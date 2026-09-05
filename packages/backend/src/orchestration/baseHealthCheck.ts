/**
 * On-demand base-branch health check: extrapolates a project's base-branch
 * health from whatever test_request_runs row already exists for the exact
 * content hash of the commit being attributed against — a session's own
 * merge-base against the base branch when a `reference` is supplied, or the
 * base branch's own tip otherwise.
 *
 * Never launches a fresh probe run. A fast-moving base branch's merge
 * cadence outruns any probe this check could launch and wait on, so the
 * locked design keys attribution on the calling session's own merge-base
 * commit (stable for that session's lifetime) and extrapolates from
 * whatever test_request_runs row — from any producer, any origin — already
 * exists for that exact content hash. No result for that content hash is
 * `unknown`, never a trigger to go compute one.
 *
 * Reuses ScheduledAuditSweep.ts's ensureAuditWorktree pattern (session-
 * independent, zero-diff checkout) under its own worktree namespace so this
 * check's checkout never collides with the scheduled sweep's — solely to
 * compute the whole-tree content hash of the commit being attributed
 * against, never to run a test command.
 *
 * Four distinguishable outcomes — downstream dispatch-gating consumers
 * branch on all four, not just pass/fail:
 *  - clean_pass:   the attributed commit's own extrapolated run passed outright.
 *  - partial_fail: the attributed commit's extrapolated run failed, but a
 *                   per-test breakdown exists (some tests failed, the rest
 *                   didn't) — a normal test_request_runs failure.
 *  - total_fail:   the extrapolated run failed with no per-test breakdown at
 *                   all (a genuine process crash before any report was
 *                   written) — this shape is what the dispatch-gating
 *                   follow-on task branches on. A run killed at the
 *                   project's own test-timeout budget, or OOM-killed, never
 *                   reaches total_fail even though it also has no per-test
 *                   breakdown — those are the orchestrator's own
 *                   budget/resource limits, not evidence about the base
 *                   tree, so they classify as `unknown` instead (see
 *                   classifyRun).
 *  - unknown:      no result could be produced at all (worktree
 *                   provisioning failure, content-hash unavailable, no
 *                   existing test_request_runs row for this content hash to
 *                   extrapolate from). Distinct from total_fail — no
 *                   per-test breakdown exists, but also no confirmed base
 *                   verdict at all, so a caller filtering a failed session
 *                   run against it (baseAttributableFilter.ts) must not
 *                   treat this as "base is healthy, the failure is yours":
 *                   it surfaces its own distinct filter outcome instead of
 *                   collapsing to unfiltered.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger';
import type { ProjectConfig } from '../config';
import { computeWholeTreeContentHash } from '../session/analyzeGating';
import { getAuditWorktreePath, type GitRunner } from './ScheduledAuditSweep';
import {
  getLatestTestRequestRun,
  getTestRunSummary,
  getBaseHealthSuiteSizeBaseline,
} from '../db/queries';
import { typedGetSetting } from '../config/settings';
import type { TestRequestRunRow, StructuredTestResult } from '../db/types';

const execFileAsync = promisify(execFile);

/**
 * Nested one path segment deeper than `.claude/worktrees/<name>`, under a
 * namespace distinct from ScheduledAuditSweep's own 'scheduled-audit' — see
 * getAuditWorktreePath's doc comment for why this keeps both checkouts out
 * of WorktreeReconciler's exact `worktreesDir/<sessionId>` live-session GC
 * match (neither is a dispatched session; no `sessions` row backs either).
 */
const WORKTREE_NAMESPACE = 'base-health';

/** The dedicated worktree path for a project's base-branch health check — never the shared projectDir, never ScheduledAuditSweep's own checkout. */
export function getBaseHealthWorktreePath(
  project: Pick<ProjectConfig, 'projectDir' | 'id'>,
): string {
  return getAuditWorktreePath(project, WORKTREE_NAMESPACE);
}

const defaultGitRunner: GitRunner = async (args, cwd) => {
  const { stdout, stderr } = await execFileAsync('git', args, { cwd });
  return { stdout, stderr };
};

export interface BaseHealthCheckDeps {
  gitRunner: GitRunner;
}

const defaultDeps: BaseHealthCheckDeps = {
  gitRunner: defaultGitRunner,
};

type BaseHealthOutcome =
  | 'clean_pass'
  | 'partial_fail'
  | 'total_fail'
  | 'unknown';

export interface BaseHealthCheckResult {
  outcome: BaseHealthOutcome;
  projectId: string;
  /** Null only when `unknown` was reached before a content hash could be computed. */
  contentHash: string | null;
  /** True whenever an outcome other than `unknown` was reached — this check never produces a fresh run, so a non-unknown result always means an existing row was extrapolated from. */
  cacheHit: boolean;
  /** The underlying test_request_runs row this outcome was classified from — null only for `unknown`. */
  run: TestRequestRunRow | null;
  /** Populated only for `unknown` — why no result could be produced. */
  unknownReason?: string;
  /** The run's own passed/failed/total counts, read off test_run_summaries — null/absent when no summary row exists for `run` (including `unknown`/`total_fail`). */
  testCounts?: { passed: number; failed: number; total: number } | null;
}

function unknownResult(
  projectId: string,
  contentHash: string | null,
  reason: string,
): BaseHealthCheckResult {
  logger.warn(`[baseHealthCheck] project ${projectId}: ${reason}`);
  return {
    outcome: 'unknown',
    projectId,
    contentHash,
    cacheHit: false,
    run: null,
    unknownReason: reason,
    testCounts: null,
  };
}

function getRunTestCounts(
  run: TestRequestRunRow,
): { passed: number; failed: number; total: number } | null {
  const summary = getTestRunSummary(run.id);
  if (!summary) return null;
  return {
    passed: summary.passed_count,
    failed: summary.failed_count,
    total: summary.total_count,
  };
}

/**
 * A failed run is `partial_fail` only when a per-test breakdown exists for
 * it AND that breakdown is complete — otherwise (no breakdown at all, or a
 * partial multi-command merge missing an expected suite's report entirely,
 * e.g. an OOM-kill before that report was written) it's `total_fail`. This
 * split is agnostic to whether acquisition was attempted — see classifyRun,
 * its dispatch-gating caller, for that distinction; the Tests-tab taxonomy
 * (classifyTestRunOutcome) intentionally treats "never attempted" and
 * "attempted and empty" alike as "no report acquired".
 *
 * The durable source of the breakdown is test_run_summaries/test_run_results
 * (testRequestLane.ts's extraction output), not
 * test_request_runs.structured_result — that column is cleared once
 * extraction has consumed it (clearExtractedStructuredResultsBatch), so a
 * null structured_result on an already-extracted run means "already
 * processed", never "crashed". The extraction summary's own `incomplete`
 * flag (mirroring StructuredTestResult.incomplete, see db/schema.ts) is what
 * survives that clear and lets an incomplete merge still classify as
 * total_fail post-sweep. structured_result is only consulted as a fallback
 * for a run that hasn't been swept (or extracted) yet.
 */
function classifyFailedRun(
  run: TestRequestRunRow,
): 'partial_fail' | 'total_fail' {
  const summary = getTestRunSummary(run.id);
  if (summary) {
    if (summary.incomplete) return 'total_fail';
    return summary.total_count > 0 ? 'partial_fail' : 'total_fail';
  }

  if (!run.structured_result) return 'total_fail';
  try {
    const parsed = JSON.parse(run.structured_result) as StructuredTestResult;
    // A merge missing one or more expected report files (e.g. a command
    // crashed/OOM-killed before writing its report) is never a mere partial
    // failure of the suites it did capture — an entire suite never ran, so
    // this must not look identical to an ordinary named-test failure.
    if (parsed.incomplete) return 'total_fail';
    const totalTests =
      (parsed.totals?.passed ?? 0) +
      (parsed.totals?.failed ?? 0) +
      (parsed.totals?.skipped ?? 0) +
      (parsed.totals?.errors ?? 0);
    if (totalTests > 0) return 'partial_fail';
  } catch {
    // Unparseable structured_result carries no usable per-test breakdown.
  }
  return 'total_fail';
}

/**
 * `total_fail` is reserved for a failed run whose acquisition was actually
 * attempted (test_report_acquisition_attempted) and still came up empty — a
 * crash or OOM-kill before any report was written. When acquisition was
 * never attempted (project declares no test_report_glob, or a historical
 * row predates the attempted column), a null structured_result is
 * ambiguous — it does not mean the run crashed — so classifyFailedRun's
 * total_fail is downgraded to `partial_fail` here (normal failure, does not
 * escalate to the base-branch dispatch hold) rather than read as a crash.
 *
 * A run killed at the project's configured test-timeout budget (or by an
 * OOM-kill) carries no information about base-branch health at all — the
 * process was truncated by the orchestrator's own budget/resource limit,
 * not by anything the base tree did. Neither ever gets a per-test report,
 * so classifyFailedRun always reads them as `total_fail`; that must not
 * reach the dispatch-gating caller as a confirmed base-branch break, so
 * it's downgraded to `unknown` here — "no confirmed base verdict at all",
 * which AutoLauncher's gate already treats as never-blocking.
 *
 * A `partial_fail` is itself downgraded to `unknown` when its summary's
 * total_count falls short of the project's own established suite size (see
 * isSuiteTruncated) — a run where both suites wrote a report but one was
 * truncated mid-collection (e.g. killed partway through) still produces a
 * `total_count > 0` summary, so classifyFailedRun alone cannot distinguish
 * it from a normal partial failure. Treating a fraction of the suite as a
 * confirmed base verdict would file a "base branch is broken" remediation
 * task off tests that never actually ran. This check is scoped to
 * base-health classification only — classifyTestRunOutcome (the Tests-tab/
 * PR-pipeline taxonomy) does not consult it, so PR test verdicts are
 * unaffected.
 */
function isSuiteTruncated(run: TestRequestRunRow): boolean {
  const summary = getTestRunSummary(run.id);
  if (!summary) return false;
  const baseline = getBaseHealthSuiteSizeBaseline(run.project_id);
  if (baseline === null) return false;
  const floorFraction = typedGetSetting(
    'base_health_suite_size_floor_fraction',
  );
  return summary.total_count < baseline * floorFraction;
}

export function classifyRun(run: TestRequestRunRow): BaseHealthOutcome {
  if (run.state === 'passed') return 'clean_pass';
  const failed = classifyFailedRun(run);
  if (failed === 'partial_fail') {
    return isSuiteTruncated(run) ? 'unknown' : 'partial_fail';
  }
  if (!run.test_report_acquisition_attempted) return 'partial_fail';
  if (
    run.failure_reason === 'timeout' ||
    run.oom_killed ||
    run.failure_reason === 'oom_killed'
  ) {
    return 'unknown';
  }
  return 'total_fail';
}

/**
 * The Tests tab's run outcome taxonomy — reuses classifyFailedRun's
 * clean/partial/total split, splitting `total_fail` further via
 * failure_reason and oom_killed (both already recorded per run) into its
 * three distinct causes. Each outcome carries its own next-action string
 * for the tab to render alongside the run.
 *
 * `passed-scoped` is its own outcome, not `passed` — a scoped run (run_kind
 * = 'scoped', see TestRunKind) only ever exercised the tests its base-diff
 * scoping selected, so a clean result from it is not the same confirmation
 * a full-suite `passed` is. Collapsing the two would let a scoped pass read
 * as "the whole suite is green" when it never ran the whole suite.
 */
type TestRunOutcome =
  | 'passed'
  | 'passed-scoped'
  | 'failed-with-named-tests'
  | 'failed-with-no-report-acquired'
  | 'crashed-oom'
  | 'timed-out'
  | 'execution-failed'
  | 'running'
  | 'queued';

export interface TestRunOutcomeInfo {
  outcome: TestRunOutcome;
  nextAction: string;
}

const TEST_RUN_NEXT_ACTIONS: Record<TestRunOutcome, string> = {
  passed: 'No action needed — all tests passed.',
  'passed-scoped':
    'The tests scoped to this diff passed — this is not a full-suite confirmation.',
  'failed-with-named-tests':
    'Review the named failing tests below and fix them.',
  'failed-with-no-report-acquired':
    'No per-test report was produced — check the raw run output for a crash before any report was written.',
  'crashed-oom':
    'The test run was OOM-killed — reduce test memory usage/parallelism, or retry.',
  'timed-out':
    'The test run exceeded its time limit — investigate a hang or split the run.',
  'execution-failed':
    'The test runner could not be started (e.g. spawn failure) — no test ever ran. This is an infrastructure failure, not a test result; retry.',
  running: 'Run is still in progress — wait for it to finish.',
  queued: 'Run is queued — waiting for a lane concurrency slot to open.',
};

export function classifyTestRunOutcome(
  run: TestRequestRunRow,
): TestRunOutcomeInfo {
  let outcome: TestRunOutcome;
  if (run.state === 'queued') {
    outcome = 'queued';
  } else if (run.state === 'running') {
    outcome = 'running';
  } else if (run.state === 'passed') {
    outcome = run.run_kind === 'scoped' ? 'passed-scoped' : 'passed';
  } else if (
    run.failure_reason === 'execution_failed' ||
    run.failure_reason === 'interrupted_queued'
  ) {
    outcome = 'execution-failed';
  } else if (run.oom_killed || run.failure_reason === 'oom_killed') {
    outcome = 'crashed-oom';
  } else if (run.failure_reason === 'timeout') {
    outcome = 'timed-out';
  } else if (classifyFailedRun(run) === 'partial_fail') {
    outcome = 'failed-with-named-tests';
  } else {
    outcome = 'failed-with-no-report-acquired';
  }
  return { outcome, nextAction: TEST_RUN_NEXT_ACTIONS[outcome] };
}

async function fsExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves and caches a (project, reference) pair's merge-base commit sha
 * against the project's base branch — computed once per reference (a git
 * commit sha, or a live session/PR worktree path) for the life of this
 * process, since a session's merge-base against the base branch is stable
 * for that session's whole lifetime absent an explicit rebase. Never
 * throws — a resolution failure caches (and returns) null so a persistently
 * broken reference doesn't re-attempt `git merge-base` on every call.
 */
const mergeBaseCache = new Map<string, Promise<string | null>>();

async function resolveMergeBaseCommit(
  project: ProjectConfig,
  reference: string,
  gitRunner: GitRunner,
): Promise<string | null> {
  const cacheKey = `${project.id}:${reference}`;
  let cached = mergeBaseCache.get(cacheKey);
  if (!cached) {
    cached = computeMergeBaseCommit(project, reference, gitRunner);
    mergeBaseCache.set(cacheKey, cached);
  }
  return cached;
}

async function computeMergeBaseCommit(
  project: ProjectConfig,
  reference: string,
  gitRunner: GitRunner,
): Promise<string | null> {
  const baseBranch = project.baseBranch || 'dev';
  try {
    await gitRunner(['fetch', 'origin', baseBranch], project.projectDir);
    const referenceIsWorktreePath = await fsExists(reference);
    const cwd = referenceIsWorktreePath ? reference : project.projectDir;
    const target = referenceIsWorktreePath ? 'HEAD' : reference;
    const { stdout } = await gitRunner(
      ['merge-base', `origin/${baseBranch}`, target],
      cwd,
    );
    return stdout.trim() || null;
  } catch (err) {
    logger.warn(
      `[baseHealthCheck] project ${project.id}: merge-base resolution failed for reference ${reference}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * Checks out `checkoutTarget` (a git ref/sha) into the dedicated base-health
 * worktree — mirrors ScheduledAuditSweep.ts's ensureAuditWorktree, but
 * against an arbitrary commit rather than always the base branch's own tip,
 * since a supplied `reference`'s merge-base commit is not necessarily the
 * base branch's current HEAD.
 */
async function ensureWorktreeAtCommit(
  project: ProjectConfig,
  worktreePath: string,
  checkoutTarget: string,
  gitRunner: GitRunner,
): Promise<void> {
  const exists = await fsExists(worktreePath);
  if (!exists) {
    await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });
    await gitRunner(
      ['worktree', 'add', '--force', '--detach', worktreePath, checkoutTarget],
      project.projectDir,
    );
    return;
  }

  try {
    await gitRunner(['reset', '--hard', checkoutTarget], worktreePath);
    await gitRunner(['clean', '-fd'], worktreePath);
  } catch (err) {
    // Worktree dir exists but is no longer a valid checkout (e.g. manually
    // disturbed) — reclaim it and re-add fresh rather than getting stuck.
    logger.warn(
      `[baseHealthCheck] project ${project.id}: existing base-health worktree at ${worktreePath} failed to reset (${err instanceof Error ? err.message : err}) — recreating`,
    );
    await fs.promises.rm(worktreePath, { recursive: true, force: true });
    try {
      await gitRunner(['worktree', 'prune'], project.projectDir);
    } catch {
      // best-effort
    }
    await gitRunner(
      ['worktree', 'add', '--force', '--detach', worktreePath, checkoutTarget],
      project.projectDir,
    );
  }
}

/**
 * Extrapolates the project's base-branch health from whatever
 * test_request_runs row already exists for the exact content hash of the
 * commit being attributed against — never runs a fresh test.request lane
 * execution itself. Never throws; every failure mode collapses into the
 * `unknown` outcome so callers can treat this as a plain lookup.
 *
 * When `reference` (a git commit sha, or an existing worktree path this can
 * run `git merge-base` from) is supplied, attribution keys on that
 * reference's own merge-base commit against the project's base branch —
 * the session/PR whose test-request failure is being attributed against
 * base health. When omitted, attribution keys on the base branch's own tip
 * (today's pre-existing behavior) — the correct degenerate case for a
 * pre-dispatch gate check with no session/branch/commit yet to key a
 * merge-base against.
 */
export async function checkBaseBranchHealth(
  project: ProjectConfig,
  reference?: string,
  deps: BaseHealthCheckDeps = defaultDeps,
): Promise<BaseHealthCheckResult> {
  const worktreePath = getBaseHealthWorktreePath(project);
  const baseBranch = project.baseBranch || 'dev';

  let checkoutTarget: string;
  if (reference) {
    const mergeBase = await resolveMergeBaseCommit(
      project,
      reference,
      deps.gitRunner,
    );
    if (!mergeBase) {
      return unknownResult(
        project.id,
        null,
        `merge-base resolution failed for reference ${reference}`,
      );
    }
    checkoutTarget = mergeBase;
  } else {
    try {
      await deps.gitRunner(['fetch', 'origin', baseBranch], project.projectDir);
    } catch (err) {
      return unknownResult(
        project.id,
        null,
        `base branch fetch failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    checkoutTarget = `origin/${baseBranch}`;
  }

  try {
    await ensureWorktreeAtCommit(
      project,
      worktreePath,
      checkoutTarget,
      deps.gitRunner,
    );
  } catch (err) {
    return unknownResult(
      project.id,
      null,
      `worktree provisioning failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  let contentHash: string | null;
  try {
    contentHash = await computeWholeTreeContentHash(worktreePath);
  } catch (err) {
    return unknownResult(
      project.id,
      null,
      `content hash computation failed: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (!contentHash) {
    return unknownResult(
      project.id,
      null,
      'attributed commit content hash unavailable (empty tree)',
    );
  }

  const run = getLatestTestRequestRun(project.id, contentHash);
  if (!run) {
    return unknownResult(
      project.id,
      contentHash,
      `no existing test_request_runs row for content hash ${contentHash} — extrapolation unavailable`,
    );
  }

  return {
    outcome: classifyRun(run),
    projectId: project.id,
    contentHash,
    cacheHit: true,
    run,
    testCounts: getRunTestCounts(run),
  };
}
