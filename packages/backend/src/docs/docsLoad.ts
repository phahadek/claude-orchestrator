/**
 * In-process loader for a single 📝 Docs task, sister to groomLoad.ts /
 * designLoad.ts / opsLoad.ts. Assembles the digest a dispatched docs session
 * (and the planning-procedure assembler) consume: the target task itself
 * plus the two fields the Docs task-body convention requires it declare
 * before any authoring may start (see `skills/docs/SKILL.md` § "Docs
 * task-body convention"):
 *
 *   - Target surface — a repo path (draft-PR output) or a Notion page id
 *     (staged `notion.pageEdit` output).
 *   - Source domains — the `WebFetch` allowlist this session's dispatch is
 *     scoped to.
 *
 * Pure read — no Notion writes, no cache writes.
 */

import { NotionClient } from '../notion/NotionClient';
import { getMilestoneById } from '../db/queries';
import { formatTaskId, normalizeBoardId } from '../tasks/taskId';
import { ProjectService } from '../projects/ProjectService';
import { GroomTaskSourceUnsupportedError } from '../planning/errors';

/** Extract the body between a heading matching `headRe` and the next heading. */
function sectionBody(md: string, headRe: RegExp): string {
  const lines = md.split('\n');
  const anyHead = /^#{1,4}\s+/;
  const i = lines.findIndex((l) => headRe.test(l));
  if (i === -1) return '';
  const body: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (anyHead.test(lines[j])) break;
    body.push(lines[j]);
  }
  return body.join('\n');
}

/** Extract top-level bullet items from a chunk of markdown (mirrors designLoad.ts's topLevelBullets). */
function topLevelBullets(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  const out: string[] = [];
  let current: string | null = null;
  const bulletRe = /^(?:[-*+]|\d+\.)\s+(.*)$/;
  const indentedRe = /^\s+\S/;
  for (const line of lines) {
    const m = bulletRe.exec(line);
    if (m && !line.startsWith(' ') && !line.startsWith('\t')) {
      if (current !== null) out.push(current.trim());
      current = m[1];
    } else if (current !== null && indentedRe.test(line)) {
      current += '\n' + line;
    } else if (current !== null && line.trim() === '') {
      // blank line — keep accumulating; closes only on next non-indented non-bullet
    } else if (current !== null && line.trim() !== '' && !bulletRe.test(line)) {
      out.push(current.trim());
      current = null;
    }
  }
  if (current !== null) out.push(current.trim());
  return out.filter(Boolean);
}

const TARGET_SURFACE_HEADING = /^#{1,4}\s+target\s+surface\b/i;
const SOURCE_DOMAINS_HEADING = /^#{1,4}\s+source\s+domains?\b/i;

/** Extract the declared "Target surface" — a repo path or a Notion page id — from a Docs task body. Empty when not declared. */
function extractTargetSurface(md: string): string {
  const body = sectionBody(md, TARGET_SURFACE_HEADING).trim();
  if (!body) return '';
  const bullets = topLevelBullets(body);
  if (bullets.length) return bullets[0].replace(/^[`*_]+|[`*_]+$/g, '').trim();
  return body
    .split('\n')[0]
    .replace(/^[`*_]+|[`*_]+$/g, '')
    .trim();
}

/** Extract the declared "Source domains" WebFetch allowlist from a Docs task body. Empty when not declared. */
function extractSourceDomains(md: string): string[] {
  const body = sectionBody(md, SOURCE_DOMAINS_HEADING).trim();
  if (!body) return [];
  const bullets = topLevelBullets(body);
  const raw = bullets.length ? bullets.join(',') : body;
  return raw
    .split(/[,\n]/)
    .map((s) => s.replace(/^[-*+`\s]+|[`\s]+$/g, '').trim())
    .filter(Boolean);
}

interface DocsTaskRef {
  id: string;
  title: string;
  status: string;
  type: string;
  url: string;
}

export interface DocsLoadResult {
  task: DocsTaskRef;
  /** The task's full markdown body, verbatim. */
  markdown: string;
  /** The declared Target surface — a repo path or a Notion page id. Empty when the task body does not declare one. */
  targetSurface: string;
  /** The declared Source domain(s) this session's WebFetch allowlist is scoped to. Empty when the task body declares none. */
  sourceDomains: string[];
}

export interface LoadDocsContextOptions {
  repoRoot: string;
  project: string;
  notion?: NotionClient;
}

const normId = normalizeBoardId;

/**
 * Assemble the docs digest for a single target task: the task's body plus
 * its declared Target surface + Source domains.
 */
export async function loadDocsContext(
  milestoneId: string,
  taskId: string,
  opts: LoadDocsContextOptions,
): Promise<DocsLoadResult> {
  const milestone = getMilestoneById(milestoneId);
  if (!milestone)
    throw new Error(`docs-load: unknown milestone ${milestoneId}`);
  if (opts.project && opts.project !== milestone.project_id) {
    throw new Error(
      `docs-load: milestone ${milestoneId} belongs to project ${milestone.project_id}, not ${opts.project}`,
    );
  }
  const projectRowForSourceCheck = ProjectService.getById(milestone.project_id);
  if (
    projectRowForSourceCheck &&
    projectRowForSourceCheck.taskSource !== 'notion'
  ) {
    throw new GroomTaskSourceUnsupportedError(
      milestone.project_id,
      projectRowForSourceCheck.taskSource,
    );
  }

  const notion = opts.notion ?? new NotionClient();

  const board = milestone.source_id;
  if (!board)
    throw new Error(
      `docs-load: milestone ${milestoneId} has no Notion board (source_id) configured`,
    );

  const rows = await notion.fetchBoardTasks(board);
  const row = rows.find((r) => normId(r.id) === normId(taskId));
  if (!row)
    throw new Error(
      `docs-load: task ${taskId} not found on board for milestone ${milestoneId}`,
    );

  const { markdown } = await notion.fetchPageMarkdown(
    formatTaskId('notion', row.id),
  );

  return {
    task: {
      id: row.id,
      title: row.title,
      status: row.status,
      type: row.type,
      url: row.notionUrl,
    },
    markdown,
    targetSurface: extractTargetSurface(markdown),
    sourceDomains: extractSourceDomains(markdown),
  };
}
