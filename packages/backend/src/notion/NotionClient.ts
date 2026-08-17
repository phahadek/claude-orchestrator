import { config } from '../config';
import {
  upsertTaskCache,
  getCacheAge,
  getTaskCache,
  updateTaskCacheStatus,
  deleteTaskCacheRow,
  getRecentTaskStatusWrite,
} from '../db/queries';
import { NotionTask, NotionApiError, ResolvedTask } from './types';
import { DependencyResolver } from './DependencyResolver';
import { toExternalId, normalizeTaskId } from '../tasks/taskId';
import { markdownToBlocks } from '../tasks/bodyRender';
import type { PatchBodySectionOperation } from '../tasks/TaskBackend';

// ─── Board validation types ─────────────────────────────────────────────────

interface DatabaseValidation {
  type: 'database';
  title: string;
  id: string;
}

interface PageValidation {
  type: 'page';
  childDatabaseId: string | null;
  childDatabaseTitle: string | null;
}

export type BoardValidation = DatabaseValidation | PageValidation;

// ─── ID helpers ─────────────────────────────────────────────────────────────

function formatAsUuid(raw: string): string {
  const clean = raw.replace(/-/g, '');
  if (clean.length !== 32) return raw;
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
}

function extractNotionId(input: string): string | null {
  const cleaned = input.split('?')[0].split('#')[0];
  const match = cleaned.match(
    /([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})/i,
  );
  if (!match) return null;
  return match[1].replace(/-/g, '');
}

export function normalizeNotionId(input: string): string | null {
  const trimmed = input.trim();
  const raw = extractNotionId(trimmed);
  if (!raw) return null;
  return formatAsUuid(raw);
}

const CACHE_TTL_MS = 60 * 1000; // 60 seconds
const TASK_PAGE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const NOTION_VERSION = '2022-06-28';
const resolver = new DependencyResolver();

// ─── NotionTaskPage — structured page body for review ──────────────────────

export interface NotionTaskPage {
  taskId: string;
  name: string;
  summarySection: string;
  contextSection: string;
  acceptanceCriteria: string;
  filesSection: string;
  rawMarkdown: string;
  /**
   * Per-task LOC budget from the Notion "Expected size" property, used as an
   * override of the global oversized-PR heuristic. Undefined when the property
   * is unset (most tasks fall back to the global heuristic).
   */
  expectedSize?: number;
}

// ─── Internal Notion API response shapes ───────────────────────────────────

interface NotionRichTextItem {
  text: { content: string };
}

interface NotionPage {
  id: string;
  url: string;
  properties: {
    'Task Name': { type: 'title'; title: NotionRichTextItem[] };
    Status: { type: 'select'; select: { name: string } | null };
    Type: { type: 'select'; select: { name: string } | null };
    Priority?: { type: 'select'; select: { name: string } | null };
    'Depends On': { type: 'rich_text'; rich_text: NotionRichTextItem[] };
    Notes: { type: 'rich_text'; rich_text: NotionRichTextItem[] };
    PR?: { type: 'url'; url: string | null };
    'Expected size'?: { type: 'number'; number: number | null };
    [key: string]: unknown;
  };
}

interface NotionQueryResponse {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

interface NotionDatabaseResponse {
  id: string;
  object: string;
  title: Array<{ plain_text?: string; text?: { content: string } }>;
}

interface NotionChildBlock {
  id: string;
  type: string;
  child_database?: { title: string };
}

interface NotionBlocksChildrenResponse {
  results: NotionChildBlock[];
}

// ─── Cache helpers ──────────────────────────────────────────────────────────

// Board-level cache uses a sentinel key so the full result can be stored
// without requiring a board_id column on task_cache.
function boardCacheKey(boardId: string): string {
  return `board:${boardId}`;
}

function isBoardCacheFresh(boardId: string): boolean {
  return getCacheAge(boardCacheKey(boardId)) < CACHE_TTL_MS;
}

function readBoardCache(boardId: string): NotionTask[] | null {
  const row = getTaskCache(boardCacheKey(boardId));
  if (!row) return null;
  try {
    const tasks = JSON.parse(row.raw_json) as NotionTask[];
    // Strip notion: prefix if present — cache stores prefixed-everywhere IDs (post-PR #411
    // convention extended to dependsOn). The contract of fetchReadyTasks is to return raw
    // Notion page IDs so NotionTaskBackend's formatTaskId call is the single point of prefixing.
    return tasks.map((t) => ({
      ...t,
      id: t.id.startsWith('notion:') ? t.id.slice('notion:'.length) : t.id,
      dependsOn: t.dependsOn
        ? t.dependsOn.map((dep) =>
            dep.startsWith('notion:') ? dep.slice('notion:'.length) : dep,
          )
        : t.dependsOn,
    }));
  } catch {
    return null;
  }
}

function writeBoardCache(boardId: string, tasks: NotionTask[]): void {
  upsertTaskCache(boardCacheKey(boardId), JSON.stringify(tasks));
}

/**
 * Reconciles a bulk board fetch (whether served from cache or freshly
 * queried) against any status write recorded more recently than the fetch
 * itself — guards against a stale board snapshot silently reverting a status
 * change that already landed via updateStatus. See
 * recordTaskStatusWrite/getRecentTaskStatusWrite in db/queries.ts.
 */
function reconcileTaskStatuses(tasks: NotionTask[]): NotionTask[] {
  let changed = false;
  const reconciled = tasks.map((task) => {
    const recentStatus = getRecentTaskStatusWrite(task.id);
    if (recentStatus !== null && recentStatus !== task.status) {
      changed = true;
      return { ...task, status: recentStatus };
    }
    return task;
  });
  return changed ? reconciled : tasks;
}

// ─── Notion API helpers ─────────────────────────────────────────────────────

function buildHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.notionApiKey}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

async function notionRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `https://api.notion.com/v1${path}`;
  const res = await fetch(url, {
    method,
    headers: buildHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new NotionApiError(res.status, text);
  }

  return res.json() as Promise<T>;
}

// ─── Page mapper ────────────────────────────────────────────────────────────

/**
 * Parse the Depends On field into a list of task IDs.
 *
 * `|` is the canonical delimiter; `,` is accepted leniently because it's a
 * common authoring mistake that previously caused the whole field to be
 * silently treated as a single unparseable ID.
 */
export function parseDependsOn(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[|,]/)
    .map((id) => id.trim())
    .filter(Boolean);
}

function mapPageToTask(page: NotionPage): NotionTask {
  const titleItems = page.properties['Task Name']?.title ?? [];
  const title = titleItems.map((t) => t.text.content).join('');

  const status = page.properties.Status?.select?.name ?? '';
  const type = page.properties.Type?.select?.name ?? '';
  const priority = page.properties['Priority']?.select?.name ?? '';

  const dependsOnRaw =
    page.properties['Depends On']?.rich_text?.[0]?.text?.content ?? '';
  const dependsOn = parseDependsOn(dependsOnRaw);

  const prUrl = page.properties['PR']?.url ?? undefined;

  return {
    id: page.id,
    title,
    status,
    type,
    dependsOn,
    notionUrl: page.url,
    prUrl,
    priority,
  };
}

// ─── Block helpers for fetchTaskPage ────────────────────────────────────────

interface NotionRichText {
  text?: { content: string };
  plain_text?: string;
}

interface NotionBlock {
  type: string;
  [key: string]: unknown;
}

interface NotionBlocksResponse {
  results: NotionBlock[];
  has_more: boolean;
  next_cursor: string | null;
}

function richTextToString(items: NotionRichText[]): string {
  return items.map((t) => t.plain_text ?? t.text?.content ?? '').join('');
}

export function blockToLine(block: NotionBlock): string {
  const type = block.type as string;
  const inner = block[type] as
    | { rich_text?: NotionRichText[]; language?: string; checked?: boolean }
    | undefined;
  if (!inner) return '';
  const text = inner.rich_text ? richTextToString(inner.rich_text) : '';
  switch (type) {
    case 'heading_1':
      return `# ${text}`;
    case 'heading_2':
      return `## ${text}`;
    case 'heading_3':
      return `### ${text}`;
    case 'heading_4':
      return `#### ${text}`;
    case 'to_do':
      return `- ${text}`;
    case 'code':
      return `\`\`\`${inner.language ?? ''}\n${text}\n\`\`\``;
    case 'bulleted_list_item':
      return `- ${text}`;
    case 'numbered_list_item':
      return `1. ${text}`;
    case 'quote':
      return `> ${text}`;
    case 'callout':
      return `> ${text}`;
    case 'divider':
      return '---';
    default:
      return text;
  }
}

const ERROR_SECTION_TEXT_MAX_LENGTH = 2000;

/**
 * Bounds section text embedded in a thrown error message so a huge section
 * doesn't blow up log/disposition payloads. Truncates on a JSON.stringify'd
 * form so the cut point can't land mid-escape-sequence.
 */
export function truncateForError(text: string): string {
  const quoted = JSON.stringify(text);
  if (quoted.length <= ERROR_SECTION_TEXT_MAX_LENGTH) return quoted;
  let truncated = quoted.slice(0, ERROR_SECTION_TEXT_MAX_LENGTH);
  // A cut can land right after the backslash of a "\\n"-style escape,
  // leaving a dangling backslash. An odd run of trailing backslashes means
  // the last one is unpaired, so drop it.
  let trailingBackslashes = 0;
  while (truncated[truncated.length - 1 - trailingBackslashes] === '\\') {
    trailingBackslashes++;
  }
  if (trailingBackslashes % 2 === 1) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}..."`;
}

// ─── Heading-bounded section engine (patchBodySection) ─────────────────────
// Generalizes appendImplementationNote's "find heading, walk until the next
// heading" scan into a reusable range locator, shared by append/replace/
// remove. Unlike TaskBackend's fetchTaskPage (a flattened markdown string
// with no block IDs), this fetches children directly so blocks can be
// targeted for insertion/deletion.

/** Fetch a page's direct children, block IDs intact (paginated). */
async function fetchBlockChildren(externalId: string): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = [];
  let startCursor: string | undefined;
  do {
    const path = `/blocks/${externalId}/children?page_size=100${startCursor ? `&start_cursor=${startCursor}` : ''}`;
    const resp = await notionRequest<NotionBlocksResponse>('GET', path);
    blocks.push(...resp.results);
    startCursor =
      resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
  } while (startCursor);
  return blocks;
}

interface HeadingSectionRange {
  /** The block ID of the heading itself. */
  headingId: string;
  /** Every block between the heading and the next heading (or page end), in order. */
  bodyBlocks: NotionBlock[];
}

/**
 * Locates the range of blocks belonging to the named section: the heading
 * block matching `section` (case/whitespace-insensitive), plus every
 * following block up to (not including) the next heading or the end of the
 * page. Returns null when no heading matches.
 */
function locateHeadingSection(
  blocks: NotionBlock[],
  section: string,
): HeadingSectionRange | null {
  const target = section.trim().toLowerCase();
  let headingId: string | null = null;
  const bodyBlocks: NotionBlock[] = [];
  let inSection = false;
  for (const block of blocks) {
    const type = block.type as string;
    if (type.startsWith('heading_')) {
      if (inSection) break;
      const inner = block[type] as { rich_text?: NotionRichText[] } | undefined;
      const text = inner?.rich_text ? richTextToString(inner.rich_text) : '';
      if (text.trim().toLowerCase() === target) {
        inSection = true;
        headingId = block.id as string;
      }
      continue;
    }
    if (inSection) bodyBlocks.push(block);
  }
  if (!headingId) return null;
  return { headingId, bodyBlocks };
}

// ─── Block-scoped patch engine (applyPageEdit) ──────────────────────────────
// Unlike patchBodySection's insert-then-delete-range, applyPageEdit patches a
// single matched block in place (PATCH /v1/blocks/{id}) — it never rebuilds
// or deletes blocks it didn't match, so tables, nested subtrees and
// unaffected formatting elsewhere on the page survive untouched.

/** The [start, end) offset of a block's own rendered line within the flattened text. */
interface BlockLineRange {
  blockIndex: number;
  start: number;
  end: number;
}

/**
 * Flattens `lines` (one rendered line per block, in block order) into a
 * single '\n'-joined string, alongside each block's own [start, end) offset
 * range within that string — the provenance that lets a matched substring be
 * traced back to the single block it came from.
 */
function buildFlattenedProvenance(lines: string[]): {
  text: string;
  ranges: BlockLineRange[];
} {
  const ranges: BlockLineRange[] = [];
  let offset = 0;
  lines.forEach((line, blockIndex) => {
    const start = offset;
    const end = start + line.length;
    ranges.push({ blockIndex, start, end });
    offset = end + 1; // +1 for the '\n' joiner
  });
  return { text: lines.join('\n'), ranges };
}

/** The rich_text array of a block's own type-keyed field, or undefined when that block type carries none. */
function blockRichText(block: NotionBlock): NotionRichText[] | undefined {
  const inner = block[block.type as string] as
    | { rich_text?: NotionRichText[] }
    | undefined;
  return inner?.rich_text;
}

/** blockToLine's per-type line prefix — used in reverse to recover a block's inner text from its mutated line. */
const BLOCK_LINE_PREFIXES: Record<string, string> = {
  heading_1: '# ',
  heading_2: '## ',
  heading_3: '### ',
  heading_4: '#### ',
  to_do: '- ',
  bulleted_list_item: '- ',
  numbered_list_item: '1. ',
  quote: '> ',
  callout: '> ',
};

/**
 * blockToLine's inverse for a single block: recovers the plain inner text a
 * mutated rendered line should carry back into that block's own rich_text.
 * Only ever called on a block already confirmed to carry rich_text.
 */
function lineToInnerText(type: string, line: string): string {
  if (type === 'code') {
    const match = /^```[^\n]*\n([\s\S]*)\n```$/.exec(line);
    return match ? match[1] : line;
  }
  const prefix = BLOCK_LINE_PREFIXES[type];
  if (prefix && line.startsWith(prefix)) return line.slice(prefix.length);
  return line;
}

/** Notion caps each rich_text text.content at 2000 chars; chunk plain (unannotated) text accordingly. */
function toPlainRichText(
  text: string,
): { type: 'text'; text: { content: string } }[] {
  const LIMIT = 2000;
  if (text.length === 0) return [{ type: 'text', text: { content: '' } }];
  const items: { type: 'text'; text: { content: string } }[] = [];
  for (let i = 0; i < text.length; i += LIMIT) {
    items.push({ type: 'text', text: { content: text.slice(i, i + LIMIT) } });
  }
  return items;
}

/**
 * Inserts `blocks` as children of `externalId`, positioned right after
 * `afterId` (or at the page end when omitted), chunked to Notion's
 * 100-block-per-request limit. Each chunk is inserted after the previous
 * chunk's last created block so ordering survives across chunk boundaries.
 */
async function insertChildBlocks(
  externalId: string,
  blocks: NotionBlockPayload[],
  afterId?: string,
): Promise<void> {
  let after = afterId;
  for (let i = 0; i < blocks.length; i += 100) {
    const chunk = blocks.slice(i, i + 100);
    const resp = await notionRequest<NotionBlocksResponse>(
      'PATCH',
      `/blocks/${externalId}/children`,
      { children: chunk, ...(after ? { after } : {}) },
    );
    const ids = resp.results.map((b) => b.id as string);
    if (ids.length) after = ids[ids.length - 1];
  }
}

/**
 * Extract the text content of a named heading section from a markdown string.
 *
 * The section is located by a loose keyword match against the heading text
 * (so "## Files Changed" matches keyword "files"). Once found, the section
 * terminates on the next heading at the same or shallower level (e.g. a `##`
 * section ends at the next `##` or `#`), regardless of that heading's name —
 * this lets "### Automated tests" nest inside "## Acceptance criteria" while
 * still stopping at unrecognised sibling sections like "## Notion pages
 * affected" instead of silently absorbing them.
 */
export function parseSection(markdown: string, headingKeyword: string): string {
  const lines = markdown.split('\n');
  let inSection = false;
  let sectionLevel = 0;
  const buf: string[] = [];
  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3}) /);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const heading = line.replace(/^#+\s*/, '').toLowerCase();
      if (!inSection && heading.includes(headingKeyword.toLowerCase())) {
        inSection = true;
        sectionLevel = level;
        continue;
      } else if (inSection) {
        if (level <= sectionLevel) {
          break;
        }
        buf.push(line);
      }
    } else if (inSection) {
      buf.push(line);
    }
  }
  return buf.join('\n').trim();
}

/**
 * Extract the Expected size LOC budget from a task-page markdown body.
 * Returns undefined when the section is missing or its content does not parse
 * as a positive integer. Used by PRReviewService to override the global
 * oversized-PR heuristic for tasks that legitimately need more scope.
 */
export function parseExpectedSize(markdown: string): number | undefined {
  const section = parseSection(markdown, 'expected size');
  if (!section) return undefined;
  const match = section.match(/-?\d+/);
  if (!match) return undefined;
  const n = parseInt(match[0], 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function taskPageCacheKey(taskId: string): string {
  // Strip source prefix (e.g., 'notion:') so the key is always task:notion:<raw-uuid>.
  const colonIdx = taskId.indexOf(':');
  const rawId = colonIdx >= 0 ? taskId.slice(colonIdx + 1) : taskId;
  return `task:notion:${rawId}`;
}

// ─── NotionClient ───────────────────────────────────────────────────────────

export class NotionClient {
  /**
   * Validate that a Notion ID (or URL) refers to a database, not a page.
   * Returns a discriminated union: { type: 'database', title, id } on success,
   * or { type: 'page', childDatabaseId, childDatabaseTitle } when the ID is a page.
   * Throws on network/auth errors or if the ID does not exist.
   */
  async validateBoard(input: string): Promise<BoardValidation> {
    const id = normalizeNotionId(input);
    if (!id)
      throw new Error('Could not extract a valid Notion ID from the input');

    // Try as a database first
    try {
      const db = await notionRequest<NotionDatabaseResponse>(
        'GET',
        `/databases/${id}`,
      );
      const title =
        db.title?.map((t) => t.plain_text ?? t.text?.content ?? '').join('') ??
        '';
      return { type: 'database', title, id };
    } catch (err) {
      if (
        !(err instanceof NotionApiError) ||
        (err.statusCode !== 404 && err.statusCode !== 400)
      ) {
        throw err;
      }
    }

    // Not a database — check if it's a page
    try {
      await notionRequest('GET', `/pages/${id}`);
    } catch (err) {
      if (err instanceof NotionApiError && err.statusCode === 404) {
        throw new NotionApiError(404, `No Notion object found with ID: ${id}`);
      }
      throw err;
    }

    // It's a page — look for a single embedded child database (bonus)
    let childDatabaseId: string | null = null;
    let childDatabaseTitle: string | null = null;
    try {
      const children = await notionRequest<NotionBlocksChildrenResponse>(
        'GET',
        `/blocks/${id}/children?page_size=100`,
      );
      const childDbs = children.results.filter(
        (b) => b.type === 'child_database',
      );
      if (childDbs.length === 1) {
        childDatabaseId = formatAsUuid(childDbs[0].id.replace(/-/g, ''));
        childDatabaseTitle = childDbs[0].child_database?.title ?? null;
      }
    } catch {
      // child-database lookup is best-effort
    }

    return { type: 'page', childDatabaseId, childDatabaseTitle };
  }

  /**
   * Fetch all raw tasks from a Notion database board, unresolved (no
   * dependency annotations). Results are cached per board with a 60-second
   * TTL. Used directly by callers (e.g. the ops loader) that need to combine
   * rows from multiple boards before resolving dependencies.
   */
  async fetchBoardTasks(
    boardId: string,
    skipCache?: boolean,
  ): Promise<NotionTask[]> {
    if (!skipCache && isBoardCacheFresh(boardId)) {
      const cached = readBoardCache(boardId);
      if (cached) return reconcileTaskStatuses(cached);
    }

    // Fetch all pages from the board (paginate through all results)
    const tasks: NotionTask[] = [];
    let startCursor: string | undefined;

    do {
      // No status filter — Deferred tasks are included so they surface as blockers
      // in DependencyResolver; only ✅ Done satisfies a dependency.
      const body: Record<string, unknown> = {
        page_size: 100,
      };
      if (startCursor) body.start_cursor = startCursor;

      const response = await notionRequest<NotionQueryResponse>(
        'POST',
        `/databases/${boardId}/query`,
        body,
      );

      for (const page of response.results) {
        tasks.push(mapPageToTask(page));
      }

      startCursor =
        response.has_more && response.next_cursor
          ? response.next_cursor
          : undefined;
    } while (startCursor);

    const reconciled = reconcileTaskStatuses(tasks);
    writeBoardCache(boardId, reconciled);
    return reconciled;
  }

  /**
   * Fetch all tasks from a Notion database board.
   * Results are cached per board with a 5-minute TTL.
   * Returns ResolvedTask[] with dependency annotations.
   */
  async fetchReadyTasks(
    boardId: string,
    skipCache?: boolean,
  ): Promise<ResolvedTask[]> {
    const tasks = await this.fetchBoardTasks(boardId, skipCache);
    return resolver.resolve(tasks);
  }

  /**
   * Fetch a generic Notion page's title + body as Markdown (not a task page —
   * no section parsing). Used to load fixed context pages (e.g. a project's
   * master context page) via the same Notion query path as task pages.
   */
  async fetchPageMarkdown(
    pageId: string,
  ): Promise<{ title: string; markdown: string }> {
    const externalId = toExternalId(pageId);
    const page = await notionRequest<NotionPage>('GET', `/pages/${externalId}`);
    const titleProp = Object.values(
      page.properties as Record<string, unknown>,
    ).find((p) => (p as { type?: string })?.type === 'title') as
      | { title: NotionRichTextItem[] }
      | undefined;
    const title = titleProp
      ? titleProp.title.map((t) => t.text.content).join('')
      : '';

    const lines: string[] = [];
    let startCursor: string | undefined;
    do {
      const path = `/blocks/${externalId}/children?page_size=100${startCursor ? `&start_cursor=${startCursor}` : ''}`;
      const resp = await notionRequest<NotionBlocksResponse>('GET', path);
      for (const block of resp.results) lines.push(blockToLine(block));
      startCursor =
        resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
    } while (startCursor);

    return { title, markdown: lines.join('\n') };
  }

  /** Update the Status select property on a Notion task page. */
  async updateStatus(taskId: string, status: string): Promise<void> {
    const externalId = toExternalId(taskId);
    await notionRequest('PATCH', `/pages/${externalId}`, {
      properties: {
        Status: { select: { name: status } },
      },
    });
    // Use the canonical prefixed taskId for the cache so the key matches
    updateTaskCacheStatus(taskId, status);
  }

  /**
   * Create a new task page under the given database, always at the initial
   * Backlog status regardless of any status implied by `fields`.
   */
  async createTask(
    databaseId: string,
    fields: {
      title: string;
      type?: string;
      priority?: string;
      dependsOn?: string[]; // prefixed task IDs, e.g. 'notion:abc123'
    },
  ): Promise<NotionTask> {
    const properties: Record<string, unknown> = {
      'Task Name': { title: [{ text: { content: fields.title } }] },
      Status: { select: { name: '🔲 Backlog' } },
    };
    if (fields.type) {
      properties.Type = { select: { name: fields.type } };
    }
    if (fields.priority) {
      properties.Priority = { select: { name: fields.priority } };
    }
    if (fields.dependsOn?.length) {
      const value = fields.dependsOn.map((dep) => toExternalId(dep)).join('|');
      properties['Depends On'] = { rich_text: [{ text: { content: value } }] };
    }
    const page = await notionRequest<NotionPage>('POST', '/pages', {
      parent: { database_id: databaseId },
      properties,
    });
    return mapPageToTask(page);
  }

  /**
   * Overwrite the Depends On rich_text property with the given task IDs,
   * encoded pipe-delimited (mirrors parseDependsOn's canonical format).
   */
  async setDependsOn(taskId: string, dependsOn: string[]): Promise<void> {
    const externalId = toExternalId(taskId);
    const value = dependsOn.map((dep) => toExternalId(dep)).join('|');
    await notionRequest('PATCH', `/pages/${externalId}`, {
      properties: {
        'Depends On': {
          rich_text: value ? [{ text: { content: value } }] : [],
        },
      },
    });
  }

  /** Overwrite the Type select property on a Notion task page. */
  async setType(taskId: string, type: string): Promise<void> {
    const externalId = toExternalId(taskId);
    await notionRequest('PATCH', `/pages/${externalId}`, {
      properties: {
        Type: { select: { name: type } },
      },
    });
  }

  /**
   * Overwrite cosmetic properties (Priority select / Task Name title). Only
   * the properties present in `patch` are sent.
   */
  async setProperties(
    taskId: string,
    patch: { priority?: string; title?: string },
  ): Promise<void> {
    const externalId = toExternalId(taskId);
    const properties: Record<string, unknown> = {};
    if (patch.priority !== undefined) {
      properties.Priority = { select: { name: patch.priority } };
    }
    if (patch.title !== undefined) {
      properties['Task Name'] = { title: [{ text: { content: patch.title } }] };
    }
    if (Object.keys(properties).length === 0) return;
    await notionRequest('PATCH', `/pages/${externalId}`, { properties });
  }

  /**
   * Archive a Notion task page. Notion has no delete for pages via the API —
   * archiving is the store-level equivalent.
   */
  async archive(taskId: string): Promise<void> {
    const externalId = toExternalId(taskId);
    await notionRequest('PATCH', `/pages/${externalId}`, { archived: true });
  }

  /**
   * Fetch the full body of a Notion task page, parse it into sections, and
   * cache the result for 10 minutes using key `task:{taskId}`.
   */
  async fetchTaskPage(taskId: string): Promise<NotionTaskPage> {
    const externalId = toExternalId(taskId);
    const cacheKey = taskPageCacheKey(taskId);
    if (getCacheAge(cacheKey) < TASK_PAGE_CACHE_TTL_MS) {
      const row = getTaskCache(cacheKey);
      if (row) {
        try {
          return JSON.parse(row.raw_json) as NotionTaskPage;
        } catch {
          // fall through to re-fetch
        }
      }
    }

    // Fetch page metadata for the name
    const page = await notionRequest<NotionPage>('GET', `/pages/${externalId}`);
    const titleItems = page.properties['Task Name']?.title ?? [];
    const name = titleItems.map((t) => t.text.content).join('');
    const expectedSizeProp = page.properties['Expected size'];
    const expectedSize =
      expectedSizeProp?.number != null && expectedSizeProp.number > 0
        ? expectedSizeProp.number
        : undefined;

    // Fetch page blocks (paginate)
    const lines: string[] = [];
    let startCursor: string | undefined;
    do {
      const path = `/blocks/${externalId}/children?page_size=100${startCursor ? `&start_cursor=${startCursor}` : ''}`;
      const resp = await notionRequest<NotionBlocksResponse>('GET', path);
      for (const block of resp.results) {
        const line = blockToLine(block);
        lines.push(line);
      }
      startCursor =
        resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
    } while (startCursor);

    const bodyMarkdown = lines.join('\n');
    // Embed Expected size as a top-level section so it travels through
    // TaskBackend.fetchTaskPage() (which only returns the markdown body) and
    // can be recovered downstream by parseExpectedSize().
    const rawMarkdown =
      expectedSize !== undefined
        ? `## Expected size\n${expectedSize}\n\n${bodyMarkdown}`
        : bodyMarkdown;
    const result: NotionTaskPage = {
      taskId,
      name,
      summarySection: parseSection(rawMarkdown, 'summary'),
      contextSection: parseSection(rawMarkdown, 'context'),
      acceptanceCriteria: parseSection(rawMarkdown, 'acceptance criteria'),
      filesSection: parseSection(rawMarkdown, 'files'),
      rawMarkdown,
      expectedSize,
    };

    upsertTaskCache(cacheKey, JSON.stringify(result));
    return result;
  }

  /**
   * Fetch just a task page's title/type/status properties (no body, no
   * pagination) — cheaper than fetchTaskPage for callers that don't need the
   * body. Returns null on a 404 (task not found) rather than throwing.
   */
  async fetchTaskSummary(taskId: string): Promise<NotionTask | null> {
    const externalId = toExternalId(taskId);
    try {
      const page = await notionRequest<NotionPage>(
        'GET',
        `/pages/${externalId}`,
      );
      return mapPageToTask(page);
    } catch (err) {
      if (err instanceof NotionApiError && err.statusCode === 404) return null;
      throw err;
    }
  }

  /**
   * Append a PR URL to the Notes rich_text property on a Notion task page.
   * Fetches the current Notes content first so existing text is preserved.
   */
  async attachPR(taskId: string, prUrl: string): Promise<void> {
    const externalId = toExternalId(taskId);
    const page = await notionRequest<NotionPage>('GET', `/pages/${externalId}`);
    const existing = page.properties.Notes?.rich_text?.[0]?.text?.content ?? '';
    const updated = existing ? `${existing}\n${prUrl}` : prUrl;

    await notionRequest('PATCH', `/pages/${externalId}`, {
      properties: {
        Notes: {
          rich_text: [{ text: { content: updated } }],
        },
      },
    });
  }

  /** Overwrite the Notes rich_text property on a Notion task page. */
  async updateNotes(taskId: string, notes: string): Promise<void> {
    const externalId = toExternalId(taskId);
    await notionRequest('PATCH', `/pages/${externalId}`, {
      properties: {
        Notes: {
          rich_text: [{ text: { content: notes } }],
        },
      },
    });
  }

  /**
   * Append a line to the "Implementation Notes" section in the page body.
   * Finds the heading block for "Implementation Notes" then appends a paragraph
   * after the last block in that section. Falls back to appending at the page end.
   */
  async appendImplementationNote(taskId: string, note: string): Promise<void> {
    const externalId = toExternalId(taskId);
    const blocks = await fetchBlockChildren(externalId);

    // Find the "Implementation Notes" heading block.
    let afterBlockId: string | undefined;
    let inSection = false;
    for (const block of blocks) {
      const type = block.type as string;
      if (type.startsWith('heading_')) {
        const inner = block[type] as
          | { rich_text?: NotionRichText[] }
          | undefined;
        const text = inner?.rich_text ? richTextToString(inner.rich_text) : '';
        if (text.toLowerCase().includes('implementation notes')) {
          inSection = true;
          afterBlockId = block.id as string;
          continue;
        }
        if (inSection) {
          // Next heading ends the section — stop scanning.
          break;
        }
      }
      if (inSection) {
        afterBlockId = block.id as string;
      }
    }

    const newParagraph = {
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: note } }],
      },
    };

    if (afterBlockId) {
      await notionRequest('PATCH', `/blocks/${externalId}/children`, {
        children: [newParagraph],
        after: afterBlockId,
      });
    } else {
      await notionRequest('PATCH', `/blocks/${externalId}/children`, {
        children: [newParagraph],
      });
    }
  }

  /**
   * Overwrite the full page body: archives every existing top-level block,
   * then appends `blocks` (chunked to Notion's 100-block-per-request limit).
   * Invalidates the cached task page so the next fetchTaskPage() re-fetches.
   */
  async updateBody(
    taskId: string,
    blocks: NotionBlockPayload[],
  ): Promise<void> {
    const externalId = toExternalId(taskId);

    let startCursor: string | undefined;
    do {
      const path = `/blocks/${externalId}/children?page_size=100${startCursor ? `&start_cursor=${startCursor}` : ''}`;
      const resp = await notionRequest<NotionBlocksResponse>('GET', path);
      for (const block of resp.results) {
        await notionRequest('DELETE', `/blocks/${block.id as string}`);
      }
      startCursor =
        resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
    } while (startCursor);

    for (let i = 0; i < blocks.length; i += 100) {
      const chunk = blocks.slice(i, i + 100);
      await notionRequest('PATCH', `/blocks/${externalId}/children`, {
        children: chunk,
      });
    }

    deleteTaskCacheRow(taskPageCacheKey(taskId));
  }

  /**
   * Applies a task.patchBodySection append/replace/remove to the
   * heading-bounded range of `section` in the page body — never touches
   * blocks outside that range. Missing-section semantics: append
   * auto-creates the section (heading + content); remove on an
   * already-absent section is a no-op; replace requires the section and the
   * exact find text to already exist and fails explicitly otherwise — it
   * never guesses.
   */
  async patchBodySection(
    taskId: string,
    section: string,
    patch: PatchBodySectionOperation,
  ): Promise<void> {
    const externalId = toExternalId(taskId);
    const blocks = await fetchBlockChildren(externalId);
    const range = locateHeadingSection(blocks, section);

    if (patch.operation === 'remove') {
      if (!range) return;
      for (const block of range.bodyBlocks) {
        await notionRequest('DELETE', `/blocks/${block.id as string}`);
      }
      await notionRequest('DELETE', `/blocks/${range.headingId}`);
      deleteTaskCacheRow(taskPageCacheKey(taskId));
      return;
    }

    if (patch.operation === 'append') {
      if (!range) {
        const newBlocks = markdownToBlocks(`## ${section}\n\n${patch.content}`);
        await insertChildBlocks(externalId, newBlocks);
      } else {
        const newBlocks = markdownToBlocks(patch.content);
        const afterId =
          (range.bodyBlocks.at(-1)?.id as string | undefined) ??
          range.headingId;
        await insertChildBlocks(externalId, newBlocks, afterId);
      }
      deleteTaskCacheRow(taskPageCacheKey(taskId));
      return;
    }

    // replace — the section and the find text must already exist; never guess.
    if (!range) {
      throw new Error(
        `[NotionClient] patchBodySection: section "${section}" not found on task ${taskId}`,
      );
    }
    const sectionText = range.bodyBlocks.map(blockToLine).join('\n');
    if (!sectionText.includes(patch.find)) {
      throw new Error(
        `[NotionClient] patchBodySection: text to replace not found in section "${section}" of task ${taskId}. ` +
          `Section text was: ${truncateForError(sectionText)}`,
      );
    }
    const mutated = sectionText.replace(patch.find, patch.replaceWith);
    const newBlocks = markdownToBlocks(mutated);
    const afterId =
      (range.bodyBlocks.at(-1)?.id as string | undefined) ?? range.headingId;
    // Insert-before-delete: the new content lands before the stale blocks
    // are torn down, so a crash mid-patch never leaves the section empty.
    await insertChildBlocks(externalId, newBlocks, afterId);
    for (const block of range.bodyBlocks) {
      await notionRequest('DELETE', `/blocks/${block.id as string}`);
    }
    deleteTaskCacheRow(taskPageCacheKey(taskId));
  }

  /**
   * Applies a notion.pageEdit staged intent's content_updates (each an
   * old_str/new_str find/replace pair) to an arbitrary Notion page's body.
   * Unlike patchBodySection this is not heading-scoped — the payload targets
   * a source-of-truth doc page rather than a task, so there is no fixed
   * section to anchor on.
   *
   * Block-scoped: the page's children are flattened to one line per block
   * with block-id provenance, but a match is only ever applied by patching
   * the single block it came from (PATCH /v1/blocks/{id}) — nothing else on
   * the page is touched, so tables, nested subtrees and unrelated formatting
   * survive untouched. A match that spans more than one block, lands on a
   * block with children, or lands on a block type carrying no rich_text is
   * refused with NotionPageEditUnpatchableTargetError rather than guessed at.
   *
   * Stale-base handling: the page may have changed since this edit was
   * staged, so every old_str is re-checked against a fresh fetch of the
   * page's current content before any write happens. If any old_str no
   * longer matches exactly, the whole apply is rejected with
   * NotionPageEditStaleBaseError rather than guessing at a partial or
   * best-effort match — the caller routes this back to the staging surface
   * for re-anchoring/re-staging.
   */
  async applyPageEdit(
    pageId: string,
    contentUpdates: { old_str: string; new_str: string }[],
  ): Promise<void> {
    // Accepts either a bare Notion page uuid or an already-prefixed
    // `notion:<uuid>` task id — normalizeTaskId wraps a bare id as notion:
    // (idempotent on an already-prefixed one) before parseTaskId ever sees it.
    const externalId = toExternalId(normalizeTaskId(pageId));
    const blocks = await fetchBlockChildren(externalId);
    const lines = blocks.map(blockToLine);

    // All content_updates are located and validated against the fresh fetch
    // before any write is issued — a later update's match is resolved
    // against the in-memory result of earlier updates in this same call
    // (so a chained old_str/new_str pair on the same block still works),
    // never against a re-fetch.
    const dirtyBlockIndices: number[] = [];
    for (const { old_str, new_str } of contentUpdates) {
      const { text, ranges } = buildFlattenedProvenance(lines);
      const matchStart = text.indexOf(old_str);
      if (matchStart === -1) {
        throw new NotionPageEditStaleBaseError(pageId, old_str);
      }
      const matchEnd = matchStart + old_str.length;

      const range = ranges.find(
        (r) => r.start <= matchStart && matchEnd <= r.end,
      );
      if (!range) {
        throw new NotionPageEditUnpatchableTargetError(
          pageId,
          old_str,
          'old_str spans more than one block',
        );
      }
      const block = blocks[range.blockIndex];
      if (block.has_children) {
        throw new NotionPageEditUnpatchableTargetError(
          pageId,
          old_str,
          'old_str matches a block with children',
        );
      }
      if (blockRichText(block) === undefined) {
        throw new NotionPageEditUnpatchableTargetError(
          pageId,
          old_str,
          `old_str matches a "${block.type as string}" block, which carries no editable rich text`,
        );
      }

      const line = lines[range.blockIndex];
      const localStart = matchStart - range.start;
      const localEnd = matchEnd - range.start;
      lines[range.blockIndex] =
        line.slice(0, localStart) + new_str + line.slice(localEnd);
      dirtyBlockIndices.push(range.blockIndex);
    }

    for (const blockIndex of new Set(dirtyBlockIndices)) {
      const block = blocks[blockIndex];
      const type = block.type as string;
      const inner = block[type] as Record<string, unknown>;
      const innerText = lineToInnerText(type, lines[blockIndex]);
      await notionRequest('PATCH', `/blocks/${block.id as string}`, {
        [type]: { ...inner, rich_text: toPlainRichText(innerText) },
      });
    }

    deleteTaskCacheRow(taskPageCacheKey(pageId));
  }
}

/**
 * Thrown by applyPageEdit when a content_update's old_str no longer appears
 * verbatim in the page's current content — the page changed between staging
 * and commit. Never mis-applied as a partial/best-effort match.
 */
export class NotionPageEditStaleBaseError extends Error {
  constructor(pageId: string, oldStr: string) {
    super(
      `[NotionClient] applyPageEdit: old_str no longer matches on page ${pageId} — ` +
        `the page changed since this edit was staged. Reject and re-stage: ${truncateForError(oldStr)}`,
    );
    this.name = 'NotionPageEditStaleBaseError';
  }
}

/**
 * Thrown by applyPageEdit when a content_update's old_str matches, but not
 * in a way a single-block patch can safely apply: it spans more than one
 * block, it lands on a block with children (patching the block alone would
 * silently leave its subtree unedited and unreviewed), or it lands on a
 * block type that carries no rich_text to patch (e.g. a table or divider).
 * Never falls back to a whole-page rewrite — the intent routes back to the
 * staging surface for re-anchoring against a narrower old_str.
 */
export class NotionPageEditUnpatchableTargetError extends Error {
  constructor(pageId: string, oldStr: string, reason: string) {
    super(
      `[NotionClient] applyPageEdit: cannot patch a single block on page ${pageId} — ${reason}. ` +
        `Reject and re-stage with a narrower old_str: ${truncateForError(oldStr)}`,
    );
    this.name = 'NotionPageEditUnpatchableTargetError';
  }
}

/** Shape accepted by updateBody — mirrors the bodyRender.ts RenderedBlock output. */
export interface NotionBlockPayload {
  object: 'block';
  type: string;
  [key: string]: unknown;
}

/** Probe-validate an arbitrary Notion integration token by calling /v1/users/me. */
export async function probeNotionToken(
  token: string,
): Promise<{ name?: string; type?: string }> {
  const res = await fetch('https://api.notion.com/v1/users/me', {
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new NotionApiError(res.status, text);
  }
  return res.json() as Promise<{ name?: string; type?: string }>;
}
