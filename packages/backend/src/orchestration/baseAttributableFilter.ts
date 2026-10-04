/**
 * Filters a session's failed test.request result against the existing
 * cross-SHA failure corpus (see db/queries.ts's computeTestFailureBreadthFlag),
 * so a dispatched task session isn't blamed — or its retry budget charged —
 * for a failing test that cannot be attributable to its own diff.
 *
 * Per-test, not whole-tree: a failing test is excused when it has failed
 * across `flip_rate_breadth_n` or more distinct test_request_runs content
 * hashes within the trailing `flip_rate_breadth_window_hours` window,
 * measured before the run's own PR/session first started producing runs —
 * so a PR's own repeated re-runs (which all share that PR's own content
 * hash) can never inflate its own breadth count. This is the same corpus
 * signal evaluateF2LaneFlakyDisposition, flaky.confirm, and PRMergeWatcher's
 * F2 lane already use — see computeTestFailureBreadthFlag's own doc comment.
 *
 * Two outcomes past the trivial "nothing was excused" case:
 *  - filtered_pass:    every one of the session's failing tests is either
 *                        breadth-flagged or known-flaky — report the
 *                        session's run as passing.
 *  - filtered_partial:  some of the session's failing tests are excused
 *                        (breadth-flagged or known-flaky), some aren't —
 *                        report only the remainder.
 */
import type { ProjectConfig } from '../config';
import type { TestRequestRunRow, StructuredTestResult } from '../db/types';
import {
  getFlaggedFlakyTestIds,
  listTestRequestRunsForSession,
  computeTestFailureBreadthFlag,
  markTestResultExcused,
  resolveBreadthOwnTree,
  type BreadthOwnTree,
} from '../db/queries';
import { typedGetSetting } from '../config/settings';
import { isTestIdTouchedByChangedFiles } from '../session/test-runner';
import {
  getRunTestOutcomes,
  getRunTestOutcomesForRun,
  outcomesFromStructuredResult,
} from './runTestOutcomes';

type BaseAttributableFilterOutcome =
  | 'unfiltered'
  | 'filtered_pass'
  | 'filtered_partial';

export interface FailingTest {
  test_id: string;
  name: string;
}

export interface BaseAttributableFilterResult {
  outcome: BaseAttributableFilterOutcome;
  /** The verdict to report to the session in place of the raw run's own passed flag. */
  passed: boolean;
  /** Failing tests excluded as breadth-flagged against the cross-SHA failure corpus. */
  excludedTests: FailingTest[];
  /** Failing tests excluded because they're flagged in flagged_flaky_tests_rollup for this project. */
  flakyExcludedTests: FailingTest[];
  /** Failing tests that remain after filtering — what's actually reported as a failure, if any. */
  remainingTests: FailingTest[];
  /**
   * Retained for callers that carry it through (see applyF2GateMaskingGuards
   * / PRMergeWatcher) — always null now that attribution no longer consults
   * a dedicated base-health probe run.
   */
  baseRun: TestRequestRunRow | null;
}

const UNFILTERED = (passed: boolean): BaseAttributableFilterResult => ({
  outcome: 'unfiltered',
  passed,
  excludedTests: [],
  flakyExcludedTests: [],
  remainingTests: [],
  baseRun: null,
});

/**
 * The flip-rate cutoff (a genuinely temporal guard; breadth excludes the
 * subject's own tree by identity instead) — the earliest started_at among `run`'s own session's test_request_runs, so a
 * PR's own repeated runs (all sharing that session) can never count toward
 * their own breadth. Falls back to `run.started_at` itself when the run
 * carries no session (nothing else to look up against).
 */
export function firstRunCutoffMs(
  project: ProjectConfig,
  run: TestRequestRunRow,
): number {
  if (!run.session_id) return run.started_at;
  const sessionRuns = listTestRequestRunsForSession(
    project.id,
    run.session_id,
    1000,
  );
  if (sessionRuns.length === 0) return run.started_at;
  return sessionRuns.reduce(
    (min, r) => Math.min(min, r.started_at),
    run.started_at,
  );
}

/**
 * Classifies `run` (an already-completed, failed test.request run) against
 * the cross-SHA failure-breadth corpus. Never throws — a run with no
 * per-test breakdown, or none of whose failing tests clear the corpus
 * signal, collapses to `unfiltered`, so callers can treat this as a plain
 * lookup and fall back to the run's own raw pass/fail verdict.
 */
export async function filterBaseAttributableFailures(
  project: ProjectConfig,
  run: TestRequestRunRow,
  _triggeringTaskId: string | null,
): Promise<BaseAttributableFilterResult> {
  if (run.state !== 'failed') {
    return UNFILTERED(run.state === 'passed');
  }

  // The accessor awaits this run's in-flight ingestion dispatch, so a
  // just-completed run never reads back an empty failing set. Reads off the
  // row already in hand — no extra db/queries round trip to re-fetch it.
  const sessionFailing = (await getRunTestOutcomesForRun(run)).failingTests;
  if (sessionFailing.length === 0) {
    // No per-test breakdown for the session's own run — nothing to
    // attribute granularly against, so leave it charged as a raw failure.
    return UNFILTERED(false);
  }

  return attributeFailingTests(
    project,
    sessionFailing,
    ownTreeOfRun(project, run),
    run.id,
  );
}

function ownTreeOfRun(
  project: ProjectConfig,
  run: Pick<TestRequestRunRow, 'session_id' | 'worktree_path'>,
): BreadthOwnTree {
  return resolveBreadthOwnTree(project.id, {
    sessionId: run.session_id,
    worktreePath: run.worktree_path,
  });
}

/**
 * Shared tail of the attribution path — splits `sessionFailing` into
 * breadth-flagged (excluded), flaky-flagged (excluded), and
 * genuinely-remaining buckets. Breadth is evaluated as of now, excluding
 * `ownTree` (the subject's own runs) by identity. Used by both filterBaseAttributableFailures and
 * filterVerifyFailureByBaseHealth so the two call sites can never disagree
 * about how attribution is computed. `runId`, when given (only
 * filterBaseAttributableFailures has a persisted row to attach to), writes
 * the same excused marker flaky.confirm(gate:'test_request') writes onto
 * every excluded test's (runId, test_id) row — see markTestResultExcused.
 */
function attributeFailingTests(
  project: ProjectConfig,
  sessionFailing: FailingTest[],
  ownTree: BreadthOwnTree,
  runId: string | null = null,
): BaseAttributableFilterResult {
  const breadthN = typedGetSetting('flip_rate_breadth_n');
  const breadthWindowHours = typedGetSetting('flip_rate_breadth_window_hours');
  const asOfMs = Date.now();

  const excludedTests = sessionFailing.filter(
    (t) =>
      computeTestFailureBreadthFlag(
        t.test_id,
        breadthWindowHours,
        breadthN,
        asOfMs,
        ownTree,
      ).flagged,
  );
  const excludedIds = new Set(excludedTests.map((t) => t.test_id));
  const notBreadthAttributable = sessionFailing.filter(
    (t) => !excludedIds.has(t.test_id),
  );

  const flakyIds = getFlaggedFlakyTestIds(project.id);
  const flakyExcludedTests = notBreadthAttributable.filter((t) =>
    flakyIds.has(t.test_id),
  );
  const remainingTests = notBreadthAttributable.filter(
    (t) => !flakyIds.has(t.test_id),
  );

  if (excludedTests.length === 0 && flakyExcludedTests.length === 0) {
    return UNFILTERED(false);
  }

  if (runId) {
    for (const t of excludedTests) {
      markTestResultExcused(runId, t.test_id, 'breadth_corpus');
    }
    for (const t of flakyExcludedTests) {
      markTestResultExcused(runId, t.test_id, 'flaky_rollup');
    }
  }

  if (remainingTests.length === 0) {
    return {
      outcome: 'filtered_pass',
      passed: true,
      excludedTests,
      flakyExcludedTests,
      remainingTests: [],
      baseRun: null,
    };
  }

  return {
    outcome: 'filtered_partial',
    passed: false,
    excludedTests,
    flakyExcludedTests,
    remainingTests,
    baseRun: null,
  };
}

/**
 * Filters a pre-review verify gate's own failure against the cross-SHA
 * failure-breadth corpus — a narrower sibling of
 * filterBaseAttributableFailures scoped to the case where verify's failing
 * command produced a per-test report. Failing tests come from the run-outcome
 * accessor (getRunTestOutcomes) for `runId` — the persisted verify lane run
 * whose outcome the gate read — so a replayed verify run whose
 * structured_result was already cleared still yields the same failing set as
 * the fresh run, and every excluded test is marked excused (breadth_corpus /
 * flaky_rollup) on that run's test_run_results rows.
 * `fallbackStructuredResult` is only for the direct
 * (non-lane) runVerifyAsGate path that has no persisted run row. With no
 * session/PR identity to derive a "first run" cutoff from, the corpus is
 * evaluated as of now.
 *
 * Returns null when no failing tests are found — the caller falls through to
 * today's unfiltered verify-gate behavior in that case.
 */
export async function filterVerifyFailureByBaseHealth(
  project: ProjectConfig,
  runId: string | null | undefined,
  fallbackStructuredResult: StructuredTestResult | null | undefined,
  subject: { sessionId?: string | null; worktreePath?: string | null },
): Promise<BaseAttributableFilterResult | null> {
  let failingTests: FailingTest[];
  if (runId) {
    failingTests = (await getRunTestOutcomes(runId)).failingTests;
  } else if (fallbackStructuredResult) {
    failingTests = outcomesFromStructuredResult(
      fallbackStructuredResult,
    ).failingTests;
  } else {
    return null;
  }
  if (failingTests.length === 0) return null;

  const sessionFailing: FailingTest[] = failingTests.map(
    ({ test_id, name }) => ({ test_id, name }),
  );

  return attributeFailingTests(
    project,
    sessionFailing,
    resolveBreadthOwnTree(project.id, subject),
    runId ?? null,
  );
}

/**
 * The f2-gate masking guard: a test that `filterBaseAttributableFailures`
 * already flagged as breadth-attributable (present in `result.excludedTests`)
 * is only actually excused at gate/merge time once BOTH of these clear it:
 *
 *  1. diff-touches-test-file — the PR's own diff must not touch the
 *     test's file (isTestIdTouchedByChangedFiles fails closed: an
 *     unmappable test id or a touched file blocks exclusion).
 *  2. breadth signal re-confirmed — the same corpus check
 *     filterBaseAttributableFailures used, re-evaluated as of now excluding
 *     `prRun`'s own tree, must still flag the test. Re-pointed here (was
 *     previously a base-probe-run failure-signature comparison) now that
 *     attribution no longer consults a dedicated base-health probe run.
 *
 * A test that fails either guard is moved back into `remainingTests` (a
 * real gate failure) rather than silently staying excused — see
 * renderBaseAttributableFilterDigest for how a caller surfaces that a
 * candidate exclusion was blocked.
 */
export function applyF2GateMaskingGuards(
  result: BaseAttributableFilterResult,
  prRun: TestRequestRunRow,
  changedFiles: string[],
): { result: BaseAttributableFilterResult; guardBlocked: FailingTest[] } {
  if (result.excludedTests.length === 0) {
    return { result, guardBlocked: [] };
  }

  const breadthN = typedGetSetting('flip_rate_breadth_n');
  const breadthWindowHours = typedGetSetting('flip_rate_breadth_window_hours');
  const asOfMs = Date.now();
  const ownTree = resolveBreadthOwnTree(prRun.project_id, {
    sessionId: prRun.session_id,
    worktreePath: prRun.worktree_path,
  });

  const cleared: FailingTest[] = [];
  const blocked: FailingTest[] = [];
  for (const t of result.excludedTests) {
    const { touched, confident } = isTestIdTouchedByChangedFiles(
      t.test_id,
      t.name,
      changedFiles,
    );
    if (!confident || touched) {
      blocked.push(t);
      continue;
    }
    const breadthFlag = computeTestFailureBreadthFlag(
      t.test_id,
      breadthWindowHours,
      breadthN,
      asOfMs,
      ownTree,
    );
    if (!breadthFlag.flagged) {
      blocked.push(t);
      continue;
    }
    cleared.push(t);
  }

  if (blocked.length === 0) {
    return { result, guardBlocked: [] };
  }

  const remainingTests = [...result.remainingTests, ...blocked];
  const passed = remainingTests.length === 0;
  const outcome: BaseAttributableFilterOutcome =
    remainingTests.length === 0
      ? 'filtered_pass'
      : cleared.length > 0 || result.flakyExcludedTests.length > 0
        ? 'filtered_partial'
        : 'unfiltered';

  return {
    result: {
      outcome,
      passed,
      excludedTests: cleared,
      flakyExcludedTests: result.flakyExcludedTests,
      remainingTests,
      baseRun: result.baseRun,
    },
    guardBlocked: blocked,
  };
}

/**
 * The combined gate-level entry point both PreReviewPipeline's tests stage
 * and PRMergeWatcher's F2 gate use: filterBaseAttributableFailures followed
 * by applyF2GateMaskingGuards, in one call. `changedFiles` is caller-sourced
 * (a live session worktree's getChangedFiles for PreReviewPipeline, a
 * GitHubClient.fetchDiff for PRMergeWatcher, which has no worktree at
 * merge-check time) since this module has no way to obtain a diff itself.
 */
export async function filterBaseAttributableFailuresForF2Gate(
  project: ProjectConfig,
  run: TestRequestRunRow,
  changedFiles: string[],
  triggeringTaskId: string | null,
): Promise<{
  result: BaseAttributableFilterResult;
  guardBlocked: FailingTest[];
}> {
  const filterResult = await filterBaseAttributableFailures(
    project,
    run,
    triggeringTaskId,
  );
  if (filterResult.excludedTests.length === 0) {
    return { result: filterResult, guardBlocked: [] };
  }
  return applyF2GateMaskingGuards(filterResult, run, changedFiles);
}

/**
 * Renders a session-facing digest for a filter result whose outcome isn't
 * `unfiltered` — the caller's fallback (buildTestResultDigest /
 * truncateForDelivery) already covers the unfiltered case.
 *
 * `guardBlocked` (gate callers only — see applyF2GateMaskingGuards) is the
 * set of tests that were breadth-attributable by the raw corpus check but
 * got moved back into the failing set because they failed one of the
 * f2-gate masking guards; appended as its own section so an operator can
 * tell "excused" apart from "candidate exclusion, blocked" at a glance,
 * satisfying the "never silently passes" requirement even when the gate
 * ultimately still fails (outcome 'unfiltered' after guards, or
 * 'filtered_partial').
 */
export function renderBaseAttributableFilterDigest(
  result: BaseAttributableFilterResult,
  guardBlocked: FailingTest[] = [],
): string {
  const guardBlockedSection = (): string =>
    guardBlocked.length === 0
      ? ''
      : '\n\n**Candidate base-attributable, blocked by masking guard ' +
        `(still counted as real failures):**\n` +
        guardBlocked.map((t) => `- \`${t.test_id}\` — ${t.name}`).join('\n');

  if (result.outcome === 'unfiltered') {
    return (
      '**Test results:** failed — no failing test was excused at the f2 gate.' +
      guardBlockedSection()
    );
  }

  if (result.outcome === 'filtered_pass') {
    return (
      `**Test results:** passed — ${result.excludedTests.length} failing test(s) excluded ` +
      'as flagged across multiple distinct trees in the failure corpus, and ' +
      `${result.flakyExcludedTests.length} excluded as known-flaky, unrelated to your changes.` +
      guardBlockedSection()
    );
  }

  const lines = [
    `**Test results:** ${result.remainingTests.length} failed ` +
      `(${result.excludedTests.length} additional failure(s) excluded as flagged across multiple ` +
      `distinct trees in the failure corpus, ${result.flakyExcludedTests.length} excluded as known-flaky).`,
    '',
    '**Failing tests:**',
  ];
  for (const t of result.remainingTests) {
    lines.push(`- \`${t.test_id}\` — ${t.name}`);
  }
  return lines.join('\n') + guardBlockedSection();
}
