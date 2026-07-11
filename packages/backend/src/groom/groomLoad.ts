/**
 * In-process port of the /groom skill's Step-1 loader (scripts/groom-load.mjs).
 *
 * Fetches the fixed context pages + the target milestone board (and neighbour
 * boards, context-only) + every non-Done target task body, then hands the
 * task bodies to codeWorklist.ts to build a deduped per-package code-
 * exploration worklist, and computes git freshness for each package against
 * the LOCAL integration branch (default `dev`). Pure read — no writes.
 *
 * See the Technical Architecture page (linked from the grooming manifest)
 * for how this fits into the wider grooming flow.
 */

import { existsSync, readFileSync } from 'fs';
import { execFile } from 'child_process';
import { join, resolve, basename } from 'path';
import { promisify } from 'util';
import { config } from '../config';
import { NotionClient } from '../notion/NotionClient';
import { buildCodeWorklist, WorklistTask } from './codeWorklist';

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────────────────

interface PageDoc {
  id: string;
  title: string;
  markdown: string;
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  type: string;
  priority: string;
  url: string;
}

interface TaskDoc extends TaskRow {
  filesSection: string;
  rawMarkdown: string;
}

type FreshnessStatus = 'fresh' | 'stale' | 'missing';

interface FreshnessInfo {
  status: FreshnessStatus;
  priorSha: string | null;
  baselineSha: string;
}

export interface GroomLoadResult {
  contextPages: PageDoc[];
  board: TaskRow[];
  neighbourBoards: TaskRow[];
  targetTasks: TaskDoc[];
  /** Per-package deduped file paths declared across target task bodies. */
  codeWorklist: Map<string, string[]>;
  /** Per-package git freshness vs. the local integration branch. */
  gitFreshness: Record<string, FreshnessInfo>;
}

interface GroomManifestMilestone {
  board: string;
  neighbours?: { id: string; board: string }[];
}

export interface GroomManifest {
  source_root?: string;
  integration_branch?: string;
  packages?: string[];
  area_aliases?: Record<string, string>;
  context_pages?: { id: string; title?: string }[];
  milestones?: Record<string, GroomManifestMilestone>;
}

export interface NotionTaskLike {
  id: string;
  title: string;
  status: string;
  type: string;
  priority?: string;
  notionUrl: string;
}

export interface NotionReadClient {
  fetchReadyTasks(boardId: string): Promise<{ task: NotionTaskLike }[]>;
  fetchTaskPage(
    taskId: string,
  ): Promise<{ name: string; filesSection: string; rawMarkdown: string }>;
}

export interface LoadGroomContextOptions {
  integrationBranch?: string;
  repoRoot?: string;
  manifest?: GroomManifest;
  /** Cached head SHA per package from a prior explore pass; absent = 'missing'. */
  priorShaByPackage?: Record<string, string>;
  notionClient?: NotionReadClient;
}

const DONE_STATUSES = new Set(['✅ Done', '⏭️ Deferred']);

// ─── Manifest resolution ────────────────────────────────────────────────────

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

function loadManifest(
  repoRoot: string,
  projectKey?: string,
): GroomManifest {
  const configDir = resolveConfigDir(repoRoot);
  if (!configDir) {
    throw new Error(
      `groomLoad: could not locate the central config tree. Set $ORCHESTRATOR_CONFIG_DIR ` +
        `(must contain a 'projects/' subdir), or pass opts.manifest directly.`,
    );
  }
  const key = projectKey ?? basename(repoRoot);
  const manifestPath = join(configDir, 'projects', key, 'grooming.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`groomLoad: manifest not found at ${manifestPath}`);
  }
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as GroomManifest;
  } catch (e) {
    throw new Error(
      `groomLoad: manifest at ${manifestPath} is not valid JSON: ${(e as Error).message}`,
      { cause: e },
    );
  }
}

// ─── git helpers (read-only) ────────────────────────────────────────────────

async function git(
  args: string[],
  cwd: string,
): Promise<{ status: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return { status: 0, stdout: stdout.trim() };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return {
      status: typeof e.code === 'number' ? e.code : 1,
      stdout: (e.stdout ?? '').trim(),
    };
  }
}

async function listTrackedFiles(repoRoot: string): Promise<string[]> {
  const r = await git(['ls-files'], repoRoot);
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

/** Freshness of a repo-relative package path vs. the cached prior SHA. */
async function freshnessFor(
  pkgPath: string,
  priorSha: string | null,
  baselineSha: string,
  repoRoot: string,
): Promise<FreshnessStatus> {
  if (!priorSha) return 'missing';
  // status 0 = no diff between priorSha and baseline for this path; non-zero = differs/error
  const diff = await git(
    ['diff', '--quiet', priorSha, baselineSha, '--', pkgPath],
    repoRoot,
  );
  if (diff.status !== 0) return 'stale';
  const dirty = await git(['status', '--porcelain', '--', pkgPath], repoRoot);
  return dirty.stdout ? 'stale' : 'fresh';
}

// ─── row/task mapping ────────────────────────────────────────────────────

function rowFromTask(task: NotionTaskLike): TaskRow {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    type: task.type,
    priority: task.priority ?? '',
    url: task.notionUrl,
  };
}

// ─── main ───────────────────────────────────────────────────────────────

export async function loadGroomContext(
  milestone: string,
  opts?: LoadGroomContextOptions,
): Promise<GroomLoadResult> {
  const repoRoot = opts?.repoRoot ?? config.projectDir;
  const manifest = opts?.manifest ?? loadManifest(repoRoot);
  const milestoneCfg = manifest.milestones?.[milestone];
  if (!milestoneCfg) {
    throw new Error(
      `groomLoad: milestone "${milestone}" is not registered in the grooming manifest ` +
        `(registered: ${Object.keys(manifest.milestones ?? {}).join(', ') || 'none'}).`,
    );
  }

  const integrationBranch =
    opts?.integrationBranch ?? manifest.integration_branch ?? 'dev';
  const notion = opts?.notionClient ?? new NotionClient();

  const baseline = await git(
    ['rev-parse', '--verify', '--quiet', integrationBranch],
    repoRoot,
  );
  if (baseline.status !== 0 || !baseline.stdout) {
    throw new Error(
      `groomLoad: could not resolve local integration branch "${integrationBranch}" in ${repoRoot}.`,
    );
  }
  const baselineSha = baseline.stdout;

  const boardResolved = await notion.fetchReadyTasks(milestoneCfg.board);
  const board: TaskRow[] = boardResolved.map((r) => rowFromTask(r.task));

  const neighbourBoards: TaskRow[] = [];
  for (const n of milestoneCfg.neighbours ?? []) {
    const rows = await notion.fetchReadyTasks(n.board);
    for (const r of rows) {
      if (!DONE_STATUSES.has(r.task.status))
        neighbourBoards.push(rowFromTask(r.task));
    }
  }

  const targetTasks: TaskDoc[] = [];
  for (const row of board) {
    if (DONE_STATUSES.has(row.status)) continue;
    const page = await notion.fetchTaskPage(row.id);
    targetTasks.push({
      ...row,
      filesSection: page.filesSection,
      rawMarkdown: page.rawMarkdown,
    });
  }

  const trackedFiles = await listTrackedFiles(repoRoot);
  const worklistTasks: WorklistTask[] = targetTasks.map((t) => ({
    id: t.id,
    title: t.title,
    filesSection: t.filesSection,
    rawMarkdown: t.rawMarkdown,
  }));
  const codeWorklist = buildCodeWorklist(worklistTasks, {
    sourceRoot: manifest.source_root ?? '',
    packages: manifest.packages ?? [],
    areaAliases: manifest.area_aliases ?? {},
    trackedFiles,
  });

  const priorShaByPackage = opts?.priorShaByPackage ?? {};
  const gitFreshness: Record<string, FreshnessInfo> = {};
  for (const pkg of codeWorklist.keys()) {
    const priorSha = priorShaByPackage[pkg] ?? null;
    const status = await freshnessFor(pkg, priorSha, baselineSha, repoRoot);
    gitFreshness[pkg] = { status, priorSha, baselineSha };
  }

  const contextPages: PageDoc[] = [];
  for (const pg of manifest.context_pages ?? []) {
    const page = await notion.fetchTaskPage(pg.id);
    contextPages.push({
      id: pg.id,
      title: pg.title ?? page.name,
      markdown: page.rawMarkdown,
    });
  }

  return {
    contextPages,
    board,
    neighbourBoards,
    targetTasks,
    codeWorklist,
    gitFreshness,
  };
}
