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
import {
  buildCodeWorklist,
  regionsForBinding,
  resolveTaskRegions,
  TaskRegions,
  WorklistTask,
} from './codeWorklist';
import {
  checkReadiness,
  type ReadinessViolation,
} from '../tasks/readinessGate';
import { scanTypeCheck, type TypeCheckResult } from './typeCheck';
import {
  computeMilestoneDependencyCandidates,
  type TaskDependencyCandidates,
} from '../orchestration/milestoneDependencyGraph';
import { formatTaskId } from '../tasks/taskId';
import { bindingConstraintIdsForRegions } from './constraintCatalog';
import type { FilesPathsEntry, DependsOnTaskRef } from './groomGate';
import { ProjectService } from '../projects/ProjectService';
import { selectUnitsFromStore } from '../architecture/selectiveInjection';

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────────────────

interface PageDoc {
  id: string;
  title: string;
  markdown: string;
}

/** A minimal architecture-unit reference, dual-read-source-agnostic. */
interface GroomArchUnitRef {
  id: string;
  title: string;
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
  /**
   * Pre-stage self-check against the shared command-layer readiness gate
   * (readinessGate.ts) — early feedback for the groomer before staging a
   * Ready-flip. Not a second enforcement point; the command layer's
   * TaskWriteCommands.setStatus is the sole authority.
   */
  readinessViolations: ReadinessViolation[];
  /**
   * Deterministic seed for size_check: the parsed changed-file count from
   * `## Files / paths affected` (falling back to the whole body). `loc`
   * itself stays a human estimate — the groomer derives it from `files` +
   * the code-map digest and records it (with loc_method) in grooming-state.
   */
  sizeCheckSeed: { files: number; loc_method: 'estimated' };
  /** Deterministic keyword/heuristic type/content-mismatch scan. */
  typeCheck: TypeCheckResult;
  /** This task's declared scope, resolved into package/file regions. */
  regions: TaskRegions;
  /**
   * FM1 — binding constraints re-derived from `regions` against
   * CONSTRAINT_CATALOG. groomGate.ts re-derives the same intersection
   * server-side at promotion time; this is a groomer-facing preview, not the
   * enforcement point.
   */
  bindingConstraints: string[];
  /**
   * Dual-read: which branch produced `archUnits` for this task — the
   * project's `archStoreAdopted` flag decides, same as the design/planning
   * path (selectiveInjection.ts). Grooming has file scope (`regions`, from
   * `## Files / paths affected`), so the store branch always uses
   * region-intersection, never the topic fallback.
   */
  archSource: 'store' | 'notion';
  /**
   * The architecture this task's constraints are drawn from: region-
   * intersecting arch_unit store units (+ all active invariants,
   * unconditionally) once the project has adopted the store, else the
   * milestone's fixed Notion context pages (pre-migration behaviour,
   * unchanged). This is the architecture a groomed 💻 Code task's inlined
   * constraints ultimately come from — an auto-dispatched code session has
   * no other channel to it.
   */
  archUnits: GroomArchUnitRef[];
  /**
   * FM2 — parsed `## Files / paths affected` entries, each git-validated
   * existing or left for the groomer to mark `*(new)*`. Only meaningful for
   * 💻 Code tasks; still computed for other types (harmless, unused by the gate).
   */
  filesPathsEntries: FilesPathsEntry[];
  /**
   * FM3 — this task's declared Depends On, resolved to type/status against
   * the board + neighbour boards (undefined type/status when the dependency
   * isn't present on either — the gate then can't apply the Design/Planning
   * liveness signal to it).
   */
  dependsOnTasks: DependsOnTaskRef[];
}

type FreshnessStatus = 'fresh' | 'stale' | 'missing';

interface FreshnessInfo {
  status: FreshnessStatus;
  priorSha: string | null;
  baselineSha: string;
}

export interface GroomLoadResult {
  /**
   * Which dual-read branch this milestone resolved architecture from — driven
   * by the project's `archStoreAdopted` flag (`ProjectService`/`opts.projectId`).
   * `contextPages` below is populated only on the `'notion'` branch; once a
   * project has adopted the store, grooming stops reading the fixed Notion
   * context pages and each target task's `archUnits` carries the
   * region-intersected store units instead (see `TaskDoc.archUnits`).
   */
  archSource: 'store' | 'notion';
  contextPages: PageDoc[];
  board: TaskRow[];
  neighbourBoards: TaskRow[];
  targetTasks: TaskDoc[];
  /** Per-package deduped file paths declared across target task bodies. */
  codeWorklist: Map<string, string[]>;
  /** Per-package git freshness vs. the local integration branch. */
  gitFreshness: Record<string, FreshnessInfo>;
  /**
   * Per-task dependency candidates (region overlap ∪ declared Depends On),
   * for the per-task grooming session to confirm — never auto-wired.
   */
  dependencyCandidates: TaskDependencyCandidates[];
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
  /** Raw Depends On page/task IDs, as declared on the task. */
  dependsOn?: string[];
}

export interface NotionReadClient {
  fetchReadyTasks(
    boardId: string,
    skipCache?: boolean,
  ): Promise<{ task: NotionTaskLike }[]>;
  fetchTaskPage(
    taskId: string,
  ): Promise<{ name: string; filesSection: string; rawMarkdown: string }>;
}

export interface LoadGroomContextOptions {
  integrationBranch?: string;
  repoRoot?: string;
  manifest?: GroomManifest;
  /**
   * Registry project id (e.g. `claude-dashboard`) — resolves the
   * `archStoreAdopted` dual-read flag via `ProjectService`. Absent (e.g. a
   * repo with no registered project) falls back to the pre-migration Notion
   * branch, same as an unmigrated project.
   */
  projectId?: string;
  /** Cached head SHA per package from a prior explore pass; absent = 'missing'. */
  priorShaByPackage?: Record<string, string>;
  notionClient?: NotionReadClient;
  /**
   * Bypass NotionClient's board-fetch cache. A dispatched groom session
   * targets one specific task, so a stale ~60s board cache (see
   * NotionClient.fetchBoardTasks) can omit a just-created/just-moved task —
   * callers that need the freshest worklist for a known target (e.g. a
   * worklist-miss reconciliation retry) should set this.
   */
  skipCache?: boolean;
}

const DONE_STATUSES = new Set(['✅ Done', '⏭️ Deferred']);

// ─── Manifest resolution ────────────────────────────────────────────────────

export function resolveConfigDir(repoRoot: string): string | null {
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

export function loadManifest(
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

/** Strip hyphens so both dashed and dashless Notion UUIDs match. */
function stripHyphens(id: string): string {
  return id.replace(/-/g, '');
}

const NEW_MARKER = /\(\s*new\s*\)/i;

function cleanPathToken(tok: string): string {
  return tok
    .replace(/^[`*_~\s(]+/, '')
    .replace(/[`*_~\s).,;:]+$/, '')
    .trim();
}

/** Best-effort path-shaped token out of a single Files/paths list-item line. */
function extractPathToken(line: string): string | null {
  const backtick = line.match(/`([^`]+)`/);
  if (backtick) return cleanPathToken(backtick[1]);
  const pathLike = line.match(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)/);
  if (pathLike) return cleanPathToken(pathLike[1]);
  return null;
}

/**
 * FM2 — parse a task's `## Files / paths affected` section into one entry
 * per list item, git-validating each candidate path against `trackedFiles`.
 * groomGate.ts's resolve-in-artifact check re-derives the hedge-token scan
 * itself from `raw`; this loader only supplies the git-validated facts a
 * gate can't compute without repo access.
 */
function parseFilesPathsEntries(
  section: string,
  trackedFiles: Set<string>,
): FilesPathsEntry[] {
  const entries: FilesPathsEntry[] = [];
  for (const line of section.split('\n')) {
    const m = line.match(/^\s*[-*]\s+(.+)$/);
    if (!m) continue;
    const raw = m[1].trim();
    if (!raw) continue;
    const isNew = NEW_MARKER.test(raw);
    const token = extractPathToken(raw);
    const existsInRepo = !!token && trackedFiles.has(token);
    entries.push({ raw, isNew, existsInRepo });
  }
  return entries;
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

  const skipCache = opts?.skipCache ?? false;
  const boardResolved = await notion.fetchReadyTasks(
    milestoneCfg.board,
    skipCache,
  );
  const board: TaskRow[] = boardResolved.map((r) => rowFromTask(r.task));
  const dependsOnById = new Map(
    boardResolved.map((r) => [r.task.id, r.task.dependsOn ?? []] as const),
  );

  /** Every row seen across the target + neighbour boards (Done included), for resolving Depends On refs to type/status. */
  const rowsByNormId = new Map(
    boardResolved.map((r) => [stripHyphens(r.task.id), r.task] as const),
  );

  const neighbourBoards: TaskRow[] = [];
  for (const n of milestoneCfg.neighbours ?? []) {
    const rows = await notion.fetchReadyTasks(n.board, skipCache);
    for (const r of rows) {
      rowsByNormId.set(stripHyphens(r.task.id), r.task);
      if (!DONE_STATUSES.has(r.task.status))
        neighbourBoards.push(rowFromTask(r.task));
    }
  }

  const trackedFiles = await listTrackedFiles(repoRoot);
  const trackedFilesSet = new Set(trackedFiles);
  const worklistOptions = {
    sourceRoot: manifest.source_root ?? '',
    packages: manifest.packages ?? [],
    areaAliases: manifest.area_aliases ?? {},
    trackedFiles,
  };

  // Dual-read: a migrated project (archStoreAdopted) reads its architecture
  // from the arch_unit store — grooming has file scope (a task's resolved
  // regions), so the store branch always uses region-intersection, never the
  // topic fallback (see selectiveInjection.ts). A non-migrated project keeps
  // the pre-migration behaviour untouched: the milestone's fixed Notion
  // context pages, attached to every target task alike.
  const archStoreAdopted = opts?.projectId
    ? (ProjectService.getById(opts.projectId)?.archStoreAdopted ?? false)
    : false;
  const archSource: 'store' | 'notion' = archStoreAdopted ? 'store' : 'notion';

  const contextPages: PageDoc[] = [];
  if (!archStoreAdopted) {
    for (const pg of manifest.context_pages ?? []) {
      const page = await notion.fetchTaskPage(formatTaskId('notion', pg.id));
      contextPages.push({
        id: pg.id,
        title: pg.title ?? page.name,
        markdown: page.rawMarkdown,
      });
    }
  }
  const notionArchUnits: GroomArchUnitRef[] = contextPages.map((p) => ({
    id: p.id,
    title: p.title,
  }));

  const targetTasks: TaskDoc[] = [];
  for (const row of board) {
    if (DONE_STATUSES.has(row.status)) continue;
    const page = await notion.fetchTaskPage(formatTaskId('notion', row.id));
    const regions = resolveTaskRegions(
      {
        id: row.id,
        title: row.title,
        filesSection: page.filesSection,
        rawMarkdown: page.rawMarkdown,
      },
      worklistOptions,
    );
    const dependsOnTasks: DependsOnTaskRef[] = (
      dependsOnById.get(row.id) ?? []
    ).map((depId) => {
      const dep = rowsByNormId.get(stripHyphens(depId));
      return { id: depId, type: dep?.type, status: dep?.status };
    });
    targetTasks.push({
      ...row,
      filesSection: page.filesSection,
      rawMarkdown: page.rawMarkdown,
      readinessViolations: checkReadiness(page.rawMarkdown, row.type),
      sizeCheckSeed: {
        files: regions.files.length + regions.planned.length,
        loc_method: 'estimated',
      },
      typeCheck: scanTypeCheck(row.type, page.rawMarkdown),
      regions,
      bindingConstraints: bindingConstraintIdsForRegions(
        regionsForBinding(regions),
      ),
      archSource,
      archUnits: archStoreAdopted
        ? selectUnitsFromStore({ regions: regionsForBinding(regions) }).map(
            (u) => ({ id: u.id, title: u.title }),
          )
        : notionArchUnits,
      filesPathsEntries: parseFilesPathsEntries(
        page.filesSection,
        trackedFilesSet,
      ),
      dependsOnTasks,
    });
  }

  const dependencyCandidates = computeMilestoneDependencyCandidates(
    targetTasks.map((t) => ({
      id: t.id,
      status: t.status,
      dependsOn: dependsOnById.get(t.id) ?? [],
      regions: t.regions,
    })),
  );

  const worklistTasks: WorklistTask[] = targetTasks.map((t) => ({
    id: t.id,
    title: t.title,
    filesSection: t.filesSection,
    rawMarkdown: t.rawMarkdown,
  }));
  const codeWorklist = buildCodeWorklist(worklistTasks, worklistOptions);

  const priorShaByPackage = opts?.priorShaByPackage ?? {};
  const gitFreshness: Record<string, FreshnessInfo> = {};
  for (const pkg of codeWorklist.keys()) {
    const priorSha = priorShaByPackage[pkg] ?? null;
    const status = await freshnessFor(pkg, priorSha, baselineSha, repoRoot);
    gitFreshness[pkg] = { status, priorSha, baselineSha };
  }

  return {
    archSource,
    contextPages,
    board,
    neighbourBoards,
    targetTasks,
    codeWorklist,
    gitFreshness,
    dependencyCandidates,
  };
}
