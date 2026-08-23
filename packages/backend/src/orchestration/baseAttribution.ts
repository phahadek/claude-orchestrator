/**
 * Shared base-attributability check for the three retry/cycle budgets that
 * must exempt (and, where a reset primitive exists, restore) charges caused
 * by the project's own base branch being broken rather than by the PR/
 * session's own change — session_test_request_cycles (stagedIntents.ts),
 * pull_requests.stalled_pr_retry_count (StalledPRReconciler.ts), and
 * pull_requests.flake_recovery_attempts (PRMergeWatcher.ts).
 *
 * Built on top of baseHealthCheck.ts's on-demand, content-hash-cached
 * checkBaseBranchHealth — never a proactive poller. A failure is
 * "attributable" when:
 *  - the base tree itself is `total_fail` (crashed/OOM'd outright — the base
 *    is unambiguously broken independent of any specific test), or
 *  - the base tree is `partial_fail` and every one of the caller-supplied
 *    run's own failing tests is also failing on the base tree (so a base
 *    defect unrelated to the run's own new failures never masks a real one).
 *
 * `clean_pass` and `unknown` are never attributable — an `unknown` outcome
 * must default to today's pre-exemption behavior (charge normally), per
 * baseHealthCheck.ts's BaseHealthCheckResult doc.
 *
 * checkBaseBranchHealth is imported dynamically (not at module top level)
 * because it transitively pulls in ScheduledAuditSweep.ts's top-level
 * `getAllProjects` import from config.ts — a module-load-time dependency
 * that would otherwise force every test file for the three call sites'
 * modules (and everything that imports them, e.g. SessionManager.ts) to
 * additionally mock getAllProjects, even when that test never exercises a
 * base-attributability check at all. Deferring the import to first call
 * keeps this module's own top-level footprint light.
 */

import type { ProjectConfig } from '../config';
import { getFailingTestIdsForRun, getBaseHealthProbesSince } from '../db/queries';
import type { TestRequestRunRow } from '../db/types';

async function checkBaseBranchHealth(project: ProjectConfig) {
  const { checkBaseBranchHealth: check } = await import('./baseHealthCheck');
  return check(project);
}

/**
 * Coarse attributability check for call sites with no specific failing test
 * run to compare against (e.g. a PR's gate_failed reconciler stall, or a
 * flake-recovery re-run outcome, both of which surface only a pass/fail verdict,
 * not a per-test breakdown) — attributable only on a `total_fail` base.
 */
export async function isBaseTotalFail(
  project: ProjectConfig,
): Promise<boolean> {
  const health = await checkBaseBranchHealth(project);
  return health.outcome === 'total_fail';
}

/**
 * Fine-grained attributability check for call sites that do have a specific
 * failing test_request_runs row in hand — additionally credits a
 * `partial_fail` base whose failing tests are a superset of the run's own
 * failing tests.
 */
export async function isRunFailureBaseAttributable(
  project: ProjectConfig,
  run: Pick<TestRequestRunRow, 'id'>,
): Promise<boolean> {
  const health = await checkBaseBranchHealth(project);
  if (health.outcome === 'total_fail') return true;
  if (health.outcome === 'partial_fail' && health.run) {
    const runFailing = getFailingTestIdsForRun(run.id);
    if (runFailing.length === 0) return false;
    const baseFailing = new Set(
      getFailingTestIdsForRun(health.run.id).map((t) => t.test_id),
    );
    return runFailing.every((t) => baseFailing.has(t.test_id));
  }
  return false;
}

/** True only when the base branch's own tests come back clean — the signal budget-restore call sites gate on. */
export async function isProjectBaseHealthy(
  project: ProjectConfig,
): Promise<boolean> {
  const health = await checkBaseBranchHealth(project);
  return health.outcome === 'clean_pass';
}

/**
 * History-ranged counterpart to isBaseTotalFail: true when any base-health
 * probe recorded for this project since `sinceTs` (typically a PR's
 * pause_reason_set_at) classifies as total_fail — not only whether the base
 * is unhealthy at the instant this is called. A live-only check can sample a
 * moment when the base happens to be transiently clean_pass even though the
 * failure that triggered the escalation was itself caused by an
 * intervening total_fail probe (or the base tree hadn't recovered yet when
 * the escalation actually happened but has since). There is no proactive
 * base-health poller, so probe coverage is sparse — absence of a bad row
 * means "no evidence found," not "definitely never happened" — but this is
 * still a strict improvement over a single point-in-time sample, never a
 * regression: it can only find MORE attributable failures, not fewer.
 */
export async function wasBaseTotalFailSince(
  project: Pick<ProjectConfig, 'id'>,
  sinceTs: number,
): Promise<boolean> {
  const { classifyRun } = await import('./baseHealthCheck');
  const probes = getBaseHealthProbesSince(project.id, sinceTs);
  return probes.some((run) => classifyRun(run) === 'total_fail');
}
