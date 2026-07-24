/**
 * In-process port of the deterministic part of the vendored /design loader
 * (scripts/design-load.mjs), sister to groomLoad.ts / opsLoad.ts. Where the
 * vendored script drives a whole milestone (every non-Done Design/Planning
 * task, cache files on disk), this module assembles the digest for a single
 * target Design/Planning task — the shape a dispatched design session (and
 * the planning-procedure assembler) consume:
 *
 *   1. The target task itself (status/type/url) + its body markdown.
 *   2. Its parsed open questions (same heading/bullet heuristics as the
 *      vendored script).
 *   3. The arch-store-selected units — the subset of the manifest's fixed
 *      `context_pages` catalog ("the arch store") that this task's body
 *      references under "Notion pages affected".
 *   4. Code-map grounding — the loader-seeded `.skill-cache/design/<milestone>/
 *      code-map.json` cache (per-package digests an interactive session
 *      writes during Step 1b), read as-is; empty if not yet populated.
 *
 * Pure read — no Notion writes, no cache writes.
 */

import { existsSync, readFileSync } from 'fs';
import { join, resolve, basename } from 'path';
import { config } from '../config';
import { NotionClient } from '../notion/NotionClient';
import { getMilestoneById } from '../db/queries';
import { formatTaskId, normalizeBoardId } from '../tasks/taskId';

// ─── manifest resolution (mirrors groomLoad.ts) ────────────────────────────

interface DesignManifestContextPage {
  id: string;
  title?: string;
}

interface DesignManifest {
  context_pages?: DesignManifestContextPage[];
}

function resolveConfigDir(repoRoot: string): string | null {
  const explicit = process.env.ORCHESTRATOR_CONFIG_DIR;
  if (explicit) return resolve(explicit);
  for (const c of [
    resolve(repoRoot, '..', 'config'),
    resolve(repoRoot, '..', '..', 'config'),
  ]) {
    if (existsSync(join(c, 'projects'))) return c;
  }
  return null;
}

function loadManifest(repoRoot: string, projectKey?: string): DesignManifest {
  const configDir = resolveConfigDir(repoRoot);
  if (!configDir) {
    throw new Error(
      `designLoad: could not locate the central config tree. Set $ORCHESTRATOR_CONFIG_DIR ` +
        `(must contain a 'projects/' subdir), or pass opts.manifest directly.`,
    );
  }
  const key = projectKey ?? basename(repoRoot);
  const manifestPath = join(configDir, 'projects', key, 'grooming.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`designLoad: manifest not found at ${manifestPath}`);
  }
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as DesignManifest;
  } catch (e) {
    throw new Error(
      `designLoad: manifest at ${manifestPath} is not valid JSON: ${(e as Error).message}`,
      { cause: e },
    );
  }
}

// ─── markdown parsing (ported from scripts/design-load.mjs) ───────────────

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

/** Extract top-level bullet items from a chunk of markdown.
 *  Top-level = no leading indent (sub-bullets stay attached to their parent). */
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

interface OpenQuestions {
  items: string[];
  source: 'explicit_heading' | 'decide_block' | 'none';
}

/** Extract the "Open questions" list from a Design task body. */
function extractOpenQuestions(md: string): OpenQuestions {
  const variants = [
    // eslint-disable-next-line security/detect-unsafe-regex -- Reason: verified non-backtracking; anchored by ^ and $ against a single Notion heading line, the trailing .* has no overlapping quantifier ahead of it (no catastrophic path).
    /^#{1,4}\s+(?:open\s+)?questions?(?:\s+to\s+resolve.*)?:?\s*$/i,
    // eslint-disable-next-line security/detect-unsafe-regex -- Reason: verified non-backtracking; anchored by ^ and $ against a single Notion heading line, the trailing .* has no overlapping quantifier ahead of it (no catastrophic path).
    /^#{1,4}\s+design\s+questions?(?:\s+to\s+settle.*)?:?\s*$/i,
    // eslint-disable-next-line security/detect-unsafe-regex -- Reason: verified non-backtracking; anchored by ^ and $ against a single Notion heading line, the two optional (?:...) groups are mutually exclusive alternatives with no overlap.
    /^#{1,4}\s+(?:decide|decisions?(?:\s+to\s+lock|\s+space(?:\s*\(.*\))?)?)(?:\s*\(.*\))?:?\s*$/i,
  ];
  for (const re of variants) {
    const body = sectionBody(md, re);
    if (body.trim()) {
      const bullets = topLevelBullets(body);
      if (bullets.length) return { items: bullets, source: 'explicit_heading' };
    }
  }
  const lines = md.split('\n');
  const decideIdx = lines.findIndex((l) =>
    // eslint-disable-next-line security/detect-unsafe-regex -- Reason: verified non-backtracking; anchored by ^ and $ against a single Notion body line, no overlapping/nested quantifiers.
    /^\s*decide(?:\s+the\s+following)?\s*:?\s*$/i.test(l),
  );
  if (decideIdx !== -1) {
    const tail = lines.slice(decideIdx + 1).join('\n');
    const headIdx = tail.split('\n').findIndex((l) => /^#{1,4}\s+/.test(l));
    const block =
      headIdx === -1 ? tail : tail.split('\n').slice(0, headIdx).join('\n');
    const bullets = topLevelBullets(block);
    if (bullets.length) return { items: bullets, source: 'decide_block' };
  }
  return { items: [], source: 'none' };
}

interface PageRef {
  title: string;
  raw: string;
}

/** Extract the "Notion pages affected" list from a Design task body. */
function extractPagesAffected(md: string): PageRef[] {
  const headRe = /^#{1,4}\s+notion\s+pages?\s+affected/i;
  const body = sectionBody(md, headRe);
  if (!body.trim()) return [];
  return topLevelBullets(body).map((raw) => {
    const trimmed = raw.replace(/^[*`_]+/, '').trim();
    const sepMatch = trimmed.match(/(.+?)\s*(?:—|–|-|\*\()/);
    const title = sepMatch ? sepMatch[1].trim() : trimmed;
    return { title, raw };
  });
}

/** Resolve a page title to a manifest context_pages entry (fuzzy, case-insensitive). */
function resolveArchUnit(
  title: string,
  contextPages: DesignManifestContextPage[],
): DesignManifestContextPage | null {
  const want = title.replace(/\s+/g, ' ').toLowerCase().trim();
  for (const p of contextPages) {
    const t = (p.title ?? '').replace(/\s+/g, ' ').toLowerCase().trim();
    if (t && (t === want || want.includes(t) || t.includes(want))) return p;
  }
  return null;
}

// ─── result shapes ──────────────────────────────────────────────────────────

interface DesignTaskRef {
  id: string;
  title: string;
  status: string;
  type: string;
  url: string;
}

interface ArchUnit {
  id: string;
  title: string;
  raw: string;
}

export interface DesignLoadResult {
  task: DesignTaskRef;
  markdown: string;
  openQuestions: OpenQuestions;
  archUnits: ArchUnit[];
  unresolvedPageRefs: PageRef[];
  codeMapGrounding: Record<string, unknown>;
}

export interface LoadDesignContextOptions {
  repoRoot?: string;
  project?: string;
  manifest?: DesignManifest;
  notion?: NotionClient;
}

const normId = normalizeBoardId;

/**
 * Assemble the design digest for a single target task: the task + its open
 * questions + the arch-store-selected units it references + code-map
 * grounding already cached for this milestone.
 */
export async function loadDesignContext(
  milestoneId: string,
  taskId: string,
  opts: LoadDesignContextOptions = {},
): Promise<DesignLoadResult> {
  const repoRoot = opts.repoRoot ?? config.projectDir;
  // `opts.project`, when present, is the project *registry* id — used below
  // only to validate against the milestone's registry id. The manifest
  // config-dir key is a separate id-space (the repo checkout's basename);
  // mirror groomLoad and never resolve it from the registry id.
  const manifest = opts.manifest ?? loadManifest(repoRoot);
  const notion = opts.notion ?? new NotionClient();

  // We need the target task's board to locate it among the board rows (for
  // status/type/url) — resolved via the caller-supplied milestone's board.
  const milestone = getMilestoneById(milestoneId);
  if (!milestone)
    throw new Error(`design-load: unknown milestone ${milestoneId}`);
  if (opts.project && opts.project !== milestone.project_id) {
    throw new Error(
      `design-load: milestone ${milestoneId} belongs to project ${milestone.project_id}, not ${opts.project}`,
    );
  }
  const board = milestone.source_id;
  if (!board)
    throw new Error(
      `design-load: milestone ${milestoneId} has no Notion board (source_id) configured`,
    );

  const rows = await notion.fetchBoardTasks(board);
  const row = rows.find((r) => normId(r.id) === normId(taskId));
  if (!row)
    throw new Error(
      `design-load: task ${taskId} not found on board for milestone ${milestoneId}`,
    );

  const { markdown } = await notion.fetchPageMarkdown(
    formatTaskId('notion', row.id),
  );
  const openQuestions = extractOpenQuestions(markdown);
  const pagesAffected = extractPagesAffected(markdown);

  const archUnits: ArchUnit[] = [];
  const unresolvedPageRefs: PageRef[] = [];
  const contextPages = manifest.context_pages ?? [];
  for (const p of pagesAffected) {
    const unit = resolveArchUnit(p.title, contextPages);
    if (unit)
      archUnits.push({ id: unit.id, title: unit.title ?? p.title, raw: p.raw });
    else unresolvedPageRefs.push(p);
  }

  const codeMapPath = join(
    repoRoot,
    '.skill-cache',
    'design',
    milestoneId,
    'code-map.json',
  );
  let codeMapGrounding: Record<string, unknown> = {};
  if (existsSync(codeMapPath)) {
    try {
      codeMapGrounding = JSON.parse(readFileSync(codeMapPath, 'utf8'));
    } catch {
      codeMapGrounding = {};
    }
  }

  return {
    task: {
      id: row.id,
      title: row.title,
      status: row.status,
      type: row.type,
      url: row.notionUrl,
    },
    markdown,
    openQuestions,
    archUnits,
    unresolvedPageRefs,
    codeMapGrounding,
  };
}
