/**
 * Filters a session's failed test.request result against the current base
 * branch's own confirmed health (see baseHealthCheck.ts), so a dispatched
 * task session isn't blamed — or its retry budget charged — for a break
 * that predates its own diff.
 *
 * Four outcomes past the trivial "base is healthy, report as-is" case:
 *  - filtered_pass:    every one of the session's failing tests also fails
 *                        on the base tree (base outcome partial_fail) —
 *                        report the session's run as passing.
 *  - filtered_partial:  some of the session's failing tests also fail on
 *                        the base tree, some don't (base outcome
 *                        partial_fail) — report only the remainder.
 *  - inconclusive:      the base tree itself whole-process-crashed (base
 *                        outcome total_fail) — no per-test breakdown exists
 *                        to attribute against, so the whole run is reported
 *                        as inconclusive rather than a filtered pass, and
 *                        must not be charged against the session's
 *                        test-request retry budget.
 *  - unknown:            no usable base-health probe exists for the current
 *                        base content hash (base outcome unknown) —
 *                        attribution was impossible, not "attributed to
 *                        you". Reported distinctly from a plain unfiltered
 *                        failure so it's queryable, and — like
 *                        inconclusive — must not be charged against the
 *                        session's test-request retry budget. Distinct from
 *                        inconclusive: that means the base whole-process
 *                        crashed; this means no probe result existed to
 *                        judge against at all.
 *
 * The first time a content hash is confirmed unhealthy (partial_fail or
 * total_fail), also triggers a deduplicated remediation task filing — see
 * audit/baseHealthRemediationFiling.ts.
 *
 * See ./baseHealthCheck.ts for the `unknown` base-health outcome this
 * module's own `unknown` filter outcome mirrors.
 */
import { logger } from '../logger';
import type { ProjectConfig } from '../config';
import type { TestRequestRunRow, StructuredTestResult } from '../db/types';
import {
  getFailingTestIdsForRun,
  getFlaggedFlakyTestIds,
  getSession,
} from '../db/queries';
import { checkBaseBranchHealth } from './baseHealthCheck';
import { recordAndMaybeFileBaseHealthRemediation } from '../audit/baseHealthRemediationFiling';
import { isTestIdTouchedByChangedFiles } from '../session/test-runner';

type BaseAttributableFilterOutcome =
  | 'unfiltered'
  | 'filtered_pass'
  | 'filtered_partial'
  | 'inconclusive'
  | 'unknown';

export interface FailingTest {
  test_id: string;
  name: string;
}

export interface BaseAttributableFilterResult {
  outcome: BaseAttributableFilterOutcome;
  /** The verdict to report to the session in place of the raw run's own passed flag. */
  passed: boolean;
  /** Failing tests excluded as confirmed base-attributable. */
  excludedTests: FailingTest[];
  /** Failing tests excluded because they're flagged in flagged_flaky_tests_rollup for this project. */
  flakyExcludedTests: FailingTest[];
  /** Failing tests that remain after filtering — what's actually reported as a failure, if any. */
  remainingTests: FailingTest[];
  /**
   * The base-health probe's own test_request_runs row, when one was
   * consulted for this result (partial_fail only) — carried through so a
   * gate-level caller (see applyF2GateMaskingGuards) can compare the PR
   * run's per-test failure content against the base probe's own recorded
   * failure content without re-triggering checkBaseBranchHealth (which can
   * itself execute a fresh probe run).
   */
  baseRun: TestRequestRunRow | null;
}

/**
 * The reference checkBaseBranchHealth resolves a session/PR's merge-base
 * against — the session's own worktree path, when one is still live for
 * `sessionId`. Null/undefined when no session backs the run (or the
 * session's row carries no worktree_path), which degenerates
 * checkBaseBranchHealth to today's base-tip content-hash behavior.
 */
function sessionReferenceFor(sessionId: string | null): string | undefined {
  if (!sessionId) return undefined;
  return getSession(sessionId)?.worktree_path ?? undefined;
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
 * Fires the deduplicated remediation-task filing for a confirmed-unhealthy
 * base content hash — best-effort, never lets a filing failure affect the
 * filter result it's attached to.
 */
async function maybeFileRemediation(
  projectId: string,
  contentHash: string,
  outcome: 'partial_fail' | 'total_fail',
  failingTestIds: string[],
  failureReason: string | null,
  triggeringTaskId: string | null,
  testCounts: { passed: number; failed: number; total: number } | null,
): Promise<void> {
  try {
    await recordAndMaybeFileBaseHealthRemediation({
      projectId,
      contentHash,
      outcome,
      failingTestIds,
      failureReason,
      triggeringTaskId,
      testCounts,
    });
  } catch (err) {
    logger.warn(
      `[baseAttributableFilter] remediation filing failed for content hash ${contentHash}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Classifies `run` (an already-completed, failed test.request run) against
 * the project's current base-branch health. Never throws — an unresolvable
 * per-test breakdown on an otherwise-healthy-lookup base still collapses to
 * `unfiltered`, so callers can treat this as a plain lookup and fall back
 * to the run's own raw pass/fail verdict. A base-health outcome of
 * `unknown` (no usable probe for the current base content hash) does NOT
 * collapse to `unfiltered` — see the `unknown` outcome above.
 */
export async function filterBaseAttributableFailures(
  project: ProjectConfig,
  run: TestRequestRunRow,
  triggeringTaskId: string | null,
): Promise<BaseAttributableFilterResult> {
  if (run.state !== 'failed') {
    return UNFILTERED(run.state === 'passed');
  }

  const health = await checkBaseBranchHealth(
    project,
    sessionReferenceFor(run.session_id),
  );

  if (health.contentHash && health.run) {
    if (health.outcome === 'total_fail') {
      void maybeFileRemediation(
        project.id,
        health.contentHash,
        'total_fail',
        [],
        health.run.failure_reason,
        triggeringTaskId,
        null,
      );
    } else if (health.outcome === 'partial_fail') {
      const baseFailing = getFailingTestIdsForRun(health.run.id).map(
        (t) => t.test_id,
      );
      // Zero-evidence partial_fail is never filed — treated like
      // clean_pass/unknown for filing purposes below.
      if (baseFailing.length > 0) {
        void maybeFileRemediation(
          project.id,
          health.contentHash,
          'partial_fail',
          baseFailing,
          null,
          triggeringTaskId,
          health.testCounts ?? null,
        );
      }
    }
  }

  if (health.outcome === 'clean_pass') {
    return UNFILTERED(false);
  }

  if (health.outcome === 'unknown') {
    return {
      outcome: 'unknown',
      passed: false,
      excludedTests: [],
      flakyExcludedTests: [],
      remainingTests: getFailingTestIdsForRun(run.id),
      baseRun: null,
    };
  }

  if (health.outcome === 'total_fail') {
    return {
      outcome: 'inconclusive',
      passed: false,
      excludedTests: [],
      flakyExcludedTests: [],
      remainingTests: [],
      baseRun: null,
    };
  }

  // partial_fail: attribute per-test against the base run's own breakdown.
  if (!health.run) {
    return UNFILTERED(false);
  }
  const sessionFailing = getFailingTestIdsForRun(run.id);
  if (sessionFailing.length === 0) {
    // No per-test breakdown for the session's own run — nothing to
    // attribute granularly against, so leave it charged as a raw failure.
    return UNFILTERED(false);
  }

  return attributeFailingTests(project, sessionFailing, health.run);
}

/**
 * Shared tail of the partial_fail attribution path — splits `sessionFailing`
 * into base-attributable (excluded), flaky-flagged (excluded), and
 * genuinely-remaining buckets against `baseRun`'s own per-test breakdown.
 * Used by both filterBaseAttributableFailures (a TestRequestRunRow's own
 * breakdown, read via getFailingTestIdsForRun) and
 * filterVerifyFailureByBaseHealth (a verify report's own parsed failing
 * tests) so the two call sites can never disagree about how attribution is
 * computed once a base run is in hand.
 */
function attributeFailingTests(
  project: ProjectConfig,
  sessionFailing: FailingTest[],
  baseRun: TestRequestRunRow,
): BaseAttributableFilterResult {
  const baseFailingIds = new Set(
    getFailingTestIdsForRun(baseRun.id).map((t) => t.test_id),
  );

  const excludedTests = sessionFailing.filter((t) =>
    baseFailingIds.has(t.test_id),
  );
  const notBaseAttributable = sessionFailing.filter(
    (t) => !baseFailingIds.has(t.test_id),
  );

  const flakyIds = getFlaggedFlakyTestIds(project.id);
  const flakyExcludedTests = notBaseAttributable.filter((t) =>
    flakyIds.has(t.test_id),
  );
  const remainingTests = notBaseAttributable.filter(
    (t) => !flakyIds.has(t.test_id),
  );

  if (remainingTests.length === 0) {
    return {
      outcome: 'filtered_pass',
      passed: true,
      excludedTests,
      flakyExcludedTests,
      remainingTests: [],
      baseRun,
    };
  }

  return {
    outcome: 'filtered_partial',
    passed: false,
    excludedTests,
    flakyExcludedTests,
    remainingTests,
    baseRun,
  };
}

/**
 * Filters a pre-review verify gate's own failure against the current
 * base-branch health — a narrower sibling of filterBaseAttributableFailures
 * scoped to the case where verify's failing command produced a structured
 * report (matching the project's test_report_glob), rather than a
 * TestRequestRunRow. `structuredResult` is the report parsed from verify's
 * own worktree (see verifyRunner.ts's runVerifyAsGate); `checkBaseBranchHealth`
 * is consulted directly rather than through filterBaseAttributableFailures,
 * since a verify report is never itself persisted as a test_request_runs row
 * to key that function's DB-row-keyed path off of.
 *
 * Returns null when `structuredResult` is absent or carries no failing
 * tests — the caller falls through to today's unfiltered verify-gate
 * behavior in that case. Otherwise mirrors filterBaseAttributableFailures's
 * outcomes: `unfiltered` when the base probe is unavailable (unknown base
 * outcome) or clean, `filtered_pass`/`filtered_partial` when a per-test
 * breakdown exists to attribute against. Never returns `inconclusive` or
 * `unknown` — a total_fail/unknown base probe here just fails closed to
 * `unfiltered`, matching today's unfiltered behavior rather than the
 * test.request lane's distinct non-charging outcomes (there is no retry
 * budget on the verify gate to protect from being charged).
 */
export async function filterVerifyFailureByBaseHealth(
  project: ProjectConfig,
  structuredResult: StructuredTestResult | null | undefined,
): Promise<BaseAttributableFilterResult | null> {
  if (!structuredResult) return null;

  const failing = new Map<string, string>();
  for (const suite of structuredResult.suites ?? []) {
    for (const test of suite.tests ?? []) {
      if (test.outcome === 'failed' || test.outcome === 'error') {
        failing.set(test.id, test.name);
      }
    }
  }
  if (failing.size === 0) return null;

  const sessionFailing: FailingTest[] = Array.from(failing.entries()).map(
    ([test_id, name]) => ({ test_id, name }),
  );

  const health = await checkBaseBranchHealth(project);

  if (health.outcome !== 'partial_fail' || !health.run) {
    return UNFILTERED(false);
  }

  return attributeFailingTests(project, sessionFailing, health.run);
}

/**
 * Extracts the failure content JUnit recorded for `testId` in a run's
 * structured_result JSON — the raw acquisition artifact test_run_results
 * extraction (ingestTestRunResults) only partially denormalizes today (see
 * this module's masking-guard-2 usage). Returns null when the run has no
 * structured_result, the JSON fails to parse, the test id isn't present, or
 * the matched test carries neither a failureMessage nor a
 * failureTraceExcerpt — every one of those is a "no usable signature" case
 * a caller must treat identically (fail closed), so they're collapsed here
 * rather than distinguished.
 */
function extractFailureSignature(
  structuredResultJson: string | null,
  testId: string,
): string | null {
  if (!structuredResultJson) return null;
  let parsed: StructuredTestResult;
  try {
    parsed = JSON.parse(structuredResultJson) as StructuredTestResult;
  } catch {
    return null;
  }
  for (const suite of parsed.suites ?? []) {
    for (const test of suite.tests ?? []) {
      if (test.id !== testId) continue;
      if (!test.failureMessage && !test.failureTraceExcerpt) return null;
      return `${test.failureMessage ?? ''}\n${test.failureTraceExcerpt ?? ''}`;
    }
  }
  return null;
}

/**
 * The f2-gate masking guards (see the "Wire baseAttributableFilter into
 * PreReviewPipeline/PRMergeWatcher's f2 gate" design): a test that
 * `filterBaseAttributableFailures` already flagged as base-attributable
 * (present in `result.excludedTests`) is only actually excused at gate/
 * merge time once BOTH guards clear it:
 *
 *  1. diff-touches-test-file — the PR's own diff must not touch the
 *     test's file (isTestIdTouchedByChangedFiles fails closed: an
 *     unmappable test id or a touched file blocks exclusion).
 *  2. failure-signature match — the PR run's own recorded failure content
 *     for the test id must match the base probe's recorded failure content
 *     for the same id (extractFailureSignature). Missing content on either
 *     side, or a mismatch, fails closed.
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
    const prSig = extractFailureSignature(prRun.structured_result, t.test_id);
    const baseSig = result.baseRun
      ? extractFailureSignature(result.baseRun.structured_result, t.test_id)
      : null;
    if (!prSig || !baseSig || prSig !== baseSig) {
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
 * set of tests that were base-attributable by the raw per-test intersection
 * but got moved back into the failing set because they failed one of the
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

  if (result.outcome === 'inconclusive') {
    return (
      '**Test results:** inconclusive — the base branch itself is currently broken ' +
      '(whole-process crash, no per-test breakdown), so this run cannot be attributed ' +
      'to your changes. Not counted against your test-request budget. A remediation task ' +
      'has been filed against the base branch.'
    );
  }

  if (result.outcome === 'unknown') {
    if (result.remainingTests.length === 0) {
      return (
        '**Test results:** base health unavailable — no confirmed result exists yet for the ' +
        "current base branch content, so this run's failures cannot be attributed to your " +
        'changes or blamed on you. Not counted against your test-request budget.'
      );
    }
    const lines = [
      `**Test results:** ${result.remainingTests.length} failed — base health unavailable, ` +
        'no confirmed result exists yet for the current base branch content, so these failures ' +
        'may include pre-existing base breakage and are not counted against your test-request budget.',
      '',
      '**Failing tests:**',
    ];
    for (const t of result.remainingTests) {
      lines.push(`- \`${t.test_id}\` — ${t.name}`);
    }
    return lines.join('\n') + guardBlockedSection();
  }

  if (result.outcome === 'filtered_pass') {
    return (
      `**Test results:** passed — ${result.excludedTests.length} failing test(s) excluded ` +
      'as confirmed base-branch breaks, and ' +
      `${result.flakyExcludedTests.length} excluded as known-flaky, unrelated to your changes.` +
      guardBlockedSection()
    );
  }

  const lines = [
    `**Test results:** ${result.remainingTests.length} failed ` +
      `(${result.excludedTests.length} additional failure(s) excluded as confirmed base-branch breaks, ` +
      `${result.flakyExcludedTests.length} excluded as known-flaky).`,
    '',
    '**Failing tests:**',
  ];
  for (const t of result.remainingTests) {
    lines.push(`- \`${t.test_id}\` — ${t.name}`);
  }
  return lines.join('\n') + guardBlockedSection();
}
