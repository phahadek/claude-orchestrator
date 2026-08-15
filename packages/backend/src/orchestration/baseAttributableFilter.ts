/**
 * Filters a session's failed test.request result against the current base
 * branch's own confirmed health (see baseHealthCheck.ts), so a dispatched
 * task session isn't blamed — or its retry budget charged — for a break
 * that predates its own diff.
 *
 * Three outcomes past the trivial "base is healthy / unknown, report
 * as-is" case:
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
 *
 * The first time a content hash is confirmed unhealthy (partial_fail or
 * total_fail), also triggers a deduplicated remediation task filing — see
 * audit/baseHealthRemediationFiling.ts.
 */
import { logger } from '../logger';
import type { ProjectConfig } from '../config';
import type { TestRequestRunRow } from '../db/types';
import { getFailingTestIdsForRun } from '../db/queries';
import { checkBaseBranchHealth } from './baseHealthCheck';
import { recordAndMaybeFileBaseHealthRemediation } from '../audit/baseHealthRemediationFiling';

export type BaseAttributableFilterOutcome =
  | 'unfiltered'
  | 'filtered_pass'
  | 'filtered_partial'
  | 'inconclusive';

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
  /** Failing tests that remain after filtering — what's actually reported as a failure, if any. */
  remainingTests: FailingTest[];
}

const UNFILTERED = (passed: boolean): BaseAttributableFilterResult => ({
  outcome: 'unfiltered',
  passed,
  excludedTests: [],
  remainingTests: [],
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
  triggeringTaskId: string | null,
): Promise<void> {
  try {
    await recordAndMaybeFileBaseHealthRemediation({
      projectId,
      contentHash,
      outcome,
      failingTestIds,
      triggeringTaskId,
    });
  } catch (err) {
    logger.warn(
      `[baseAttributableFilter] remediation filing failed for content hash ${contentHash}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Classifies `run` (an already-completed, failed test.request run) against
 * the project's current base-branch health. Never throws — every internal
 * failure (base-health check errors internally into `unknown`, a missing
 * per-test breakdown, etc.) collapses into `unfiltered`, so callers can
 * treat this as a plain lookup and fall back to the run's own raw
 * pass/fail verdict.
 */
export async function filterBaseAttributableFailures(
  project: ProjectConfig,
  run: TestRequestRunRow,
  triggeringTaskId: string | null,
): Promise<BaseAttributableFilterResult> {
  if (run.state !== 'failed') {
    return UNFILTERED(run.state === 'passed');
  }

  const health = await checkBaseBranchHealth(project);

  if (health.contentHash && health.run) {
    if (health.outcome === 'total_fail') {
      void maybeFileRemediation(
        project.id,
        health.contentHash,
        'total_fail',
        [],
        triggeringTaskId,
      );
    } else if (health.outcome === 'partial_fail') {
      const baseFailing = getFailingTestIdsForRun(health.run.id).map(
        (t) => t.test_id,
      );
      void maybeFileRemediation(
        project.id,
        health.contentHash,
        'partial_fail',
        baseFailing,
        triggeringTaskId,
      );
    }
  }

  if (health.outcome === 'clean_pass' || health.outcome === 'unknown') {
    return UNFILTERED(false);
  }

  if (health.outcome === 'total_fail') {
    return {
      outcome: 'inconclusive',
      passed: false,
      excludedTests: [],
      remainingTests: [],
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
  const baseFailingIds = new Set(
    getFailingTestIdsForRun(health.run.id).map((t) => t.test_id),
  );

  const excludedTests = sessionFailing.filter((t) =>
    baseFailingIds.has(t.test_id),
  );
  const remainingTests = sessionFailing.filter(
    (t) => !baseFailingIds.has(t.test_id),
  );

  if (remainingTests.length === 0) {
    return {
      outcome: 'filtered_pass',
      passed: true,
      excludedTests,
      remainingTests: [],
    };
  }

  return {
    outcome: 'filtered_partial',
    passed: false,
    excludedTests,
    remainingTests,
  };
}

/**
 * Renders a session-facing digest for a filter result whose outcome isn't
 * `unfiltered` — the caller's fallback (buildTestResultDigest /
 * truncateForDelivery) already covers the unfiltered case.
 */
export function renderBaseAttributableFilterDigest(
  result: BaseAttributableFilterResult,
): string {
  if (result.outcome === 'inconclusive') {
    return (
      '**Test results:** inconclusive — the base branch itself is currently broken ' +
      '(whole-process crash, no per-test breakdown), so this run cannot be attributed ' +
      'to your changes. Not counted against your test-request budget. A remediation task ' +
      'has been filed against the base branch.'
    );
  }

  if (result.outcome === 'filtered_pass') {
    return (
      `**Test results:** passed — ${result.excludedTests.length} failing test(s) excluded ` +
      'as confirmed base-branch breaks, unrelated to your changes.'
    );
  }

  const lines = [
    `**Test results:** ${result.remainingTests.length} failed ` +
      `(${result.excludedTests.length} additional failure(s) excluded as confirmed base-branch breaks).`,
    '',
    '**Failing tests:**',
  ];
  for (const t of result.remainingTests) {
    lines.push(`- \`${t.test_id}\` — ${t.name}`);
  }
  return lines.join('\n');
}
