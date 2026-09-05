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
import {
  getFailingTestIdsForRun,
  getBaseHealthProbeRunsSince,
  getSession,
} from '../db/queries';
import type { TestRequestRunRow } from '../db/types';

async function checkBaseBranchHealth(
  project: ProjectConfig,
  reference?: string,
) {
  const { checkBaseBranchHealth: check } = await import('./baseHealthCheck');
  return check(project, reference);
}

/**
 * The reference checkBaseBranchHealth resolves a session's merge-base
 * against — the session's own worktree path, when one is still live for
 * `sessionId`. Null/undefined when no session backs the run (or the
 * session's row carries no worktree_path), which degenerates
 * checkBaseBranchHealth to today's base-tip content-hash behavior.
 */
function sessionReferenceFor(sessionId: string | null): string | undefined {
  if (!sessionId) return undefined;
  return getSession(sessionId)?.worktree_path ?? undefined;
}

/**
 * Coarse attributability check for call sites with no specific failing test
 * run to compare against (e.g. a PR's gate_failed reconciler stall, or a
 * flake-recovery re-run outcome, both of which surface only a pass/fail verdict,
 * not a per-test breakdown) — attributable only on a `total_fail` base.
 * `referenceCommit` — typically the caller's own PR's head_sha — keys
 * attribution on that PR's merge-base against the base branch rather than
 * the base branch's own tip; omitted callers keep today's base-tip
 * behavior.
 */
export async function isBaseTotalFail(
  project: ProjectConfig,
  referenceCommit?: string,
): Promise<boolean> {
  const health = await checkBaseBranchHealth(project, referenceCommit);
  return health.outcome === 'total_fail';
}

/**
 * Fine-grained attributability check for call sites that do have a specific
 * failing test_request_runs row in hand — additionally credits a
 * `partial_fail` base whose failing tests are a superset of the run's own
 * failing tests. Attribution is keyed on the run's own session's merge-base
 * against the base branch (see sessionReferenceFor), falling back to the
 * base tip when the run carries no session.
 */
export async function isRunFailureBaseAttributable(
  project: ProjectConfig,
  run: Pick<TestRequestRunRow, 'id' | 'session_id'>,
): Promise<boolean> {
  const health = await checkBaseBranchHealth(
    project,
    sessionReferenceFor(run.session_id),
  );
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

/**
 * True only when the base branch's own tests come back clean — the signal
 * budget-restore call sites gate on. `referenceCommit` — typically the
 * caller's own PR's head_sha — keys attribution on that PR's merge-base
 * against the base branch rather than the base branch's own tip; omitted
 * callers keep today's base-tip behavior.
 */
export async function isProjectBaseHealthy(
  project: ProjectConfig,
  referenceCommit?: string,
): Promise<boolean> {
  const health = await checkBaseBranchHealth(project, referenceCommit);
  return health.outcome === 'clean_pass';
}

/**
 * Recovery-time corroboration for a budget-restore decision: was the base
 * branch confirmed `total_fail` by ANY base-health probe finishing at or
 * after `sinceTs` (typically the PR's own escalation/exhaustion timestamp)?
 *
 * Exists because checkBaseBranchHealth/isBaseTotalFail is a live, content-
 * hash-cached snapshot of whatever tree state happens to be current when
 * it's called — a `total_fail` window is often short-lived (tens of
 * minutes), so sampling it only once, at the exact instant a PR's stall was
 * classified, misses a PR that stalled before the window opened and is
 * still stalled once it closes. Comparing against the durable
 * test_request_runs history instead of a single live sample is what lets
 * budget-restore call sites arm eligibility by stall *kind* alone (see
 * StalledPRReconciler's stalled_retry_base_exhausted / PRMergeWatcher's
 * flake_recovery_base_exhausted) and defer the actual base-attributability
 * verdict to this recovery-time check.
 */
export async function hasBaseTotalFailSince(
  project: ProjectConfig,
  sinceTs: number,
): Promise<boolean> {
  const { classifyRun } = await import('./baseHealthCheck');
  const runs = getBaseHealthProbeRunsSince(project.id, sinceTs);
  return runs.some((run) => classifyRun(run) === 'total_fail');
}
