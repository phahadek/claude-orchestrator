import { config } from '../config';
import {
  upsertTaskCache,
  getCacheAge,
  getTaskCache,
  updateTaskCacheStatus,
} from '../db/queries';
import { NotionTask, NotionApiError, ResolvedTask } from './types';
import { DependencyResolver } from './DependencyResolver';

// ─── Board validation types ─────────────────────────────────────────────────

export interface DatabaseValidation {
  type: 'database';
  title: string;
  id: string;
}

export interface PageValidation {
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

export function extractNotionId(input: string): string | null {
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

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
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
    return JSON.parse(row.raw_json) as NotionTask[];
  } catch {
    return null;
  }
}

function writeBoardCache(boardId: string, tasks: NotionTask[]): void {
  upsertTaskCache(boardCacheKey(boardId), JSON.stringify(tasks));
  // Also cache individual tasks by their own ID
  for (const task of tasks) {
    upsertTaskCache(task.id, JSON.stringify(task));
  }
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

function blockToLine(block: NotionBlock): string {
  const type = block.type as string;
  const inner = block[type] as
    | { rich_text?: NotionRichText[]; language?: string }
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

/**
 * Known top-level section keywords. A heading is considered a top-level
 * section boundary only when it matches one of these keywords. Sub-headings
 * like "### 🤖 Automated tests" that do not match any keyword are treated as
 * content within the current section.
 */
export const TOP_LEVEL_SECTIONS = [
  'summary',
  'dependencies',
  'context',
  'acceptance criteria',
  'files',
  'implementation notes',
  'expected size',
];

/** Extract the text content of a named heading section from a markdown string. */
export function parseSection(markdown: string, headingKeyword: string): string {
  const lines = markdown.split('\n');
  let inSection = false;
  const buf: string[] = [];
  for (const line of lines) {
    const isHeading = /^#{1,3} /.test(line);
    if (isHeading) {
      const heading = line.replace(/^#+\s*/, '').toLowerCase();
      if (heading.includes(headingKeyword.toLowerCase())) {
        inSection = true;
        continue;
      } else if (inSection) {
        // Only break on a different known top-level section, not sub-headings
        const isTopLevel = TOP_LEVEL_SECTIONS.some(
          (s) => heading.includes(s) && s !== headingKeyword.toLowerCase(),
        );
        if (isTopLevel) {
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
  return `task:${taskId}`;
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
   * Fetch all tasks from a Notion database board.
   * Results are cached per board with a 5-minute TTL.
   * Returns ResolvedTask[] with dependency annotations.
   */
  async fetchReadyTasks(
    boardId: string,
    skipCache?: boolean,
  ): Promise<ResolvedTask[]> {
    if (!skipCache && isBoardCacheFresh(boardId)) {
      const cached = readBoardCache(boardId);
      if (cached) return resolver.resolve(cached);
    }

    // Fetch all pages from the board (paginate through all results)
    const tasks: NotionTask[] = [];
    let startCursor: string | undefined;

    do {
      const body: Record<string, unknown> = {
        page_size: 100,
        filter: {
          property: 'Status',
          select: { does_not_equal: '⏭️ Deferred' },
        },
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

    writeBoardCache(boardId, tasks);
    return resolver.resolve(tasks);
  }

  /** Update the Status select property on a Notion task page. */
  async updateStatus(taskId: string, status: string): Promise<void> {
    await notionRequest('PATCH', `/pages/${taskId}`, {
      properties: {
        Status: { select: { name: status } },
      },
    });
    // Update the cache row in-place so emitTaskUpdated() can still find the row
    updateTaskCacheStatus(taskId, status);
  }

  /**
   * Fetch the full body of a Notion task page, parse it into sections, and
   * cache the result for 10 minutes using key `task:{taskId}`.
   */
  async fetchTaskPage(taskId: string): Promise<NotionTaskPage> {
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
    const page = await notionRequest<NotionPage>('GET', `/pages/${taskId}`);
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
      const path = `/blocks/${taskId}/children?page_size=100${startCursor ? `&start_cursor=${startCursor}` : ''}`;
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
   * Append a PR URL to the Notes rich_text property on a Notion task page.
   * Fetches the current Notes content first so existing text is preserved.
   */
  async attachPR(taskId: string, prUrl: string): Promise<void> {
    const page = await notionRequest<NotionPage>('GET', `/pages/${taskId}`);
    const existing = page.properties.Notes?.rich_text?.[0]?.text?.content ?? '';
    const updated = existing ? `${existing}\n${prUrl}` : prUrl;

    await notionRequest('PATCH', `/pages/${taskId}`, {
      properties: {
        Notes: {
          rich_text: [{ text: { content: updated } }],
        },
      },
    });
  }
}
