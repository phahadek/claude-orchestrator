import { logger } from '../logger';
import { db } from '../db/db';
import { runtimeSettings } from '../config';
import { typedGetSetting } from '../config/settings';
import type { Scheduler } from '../orchestration/Scheduler';
import { computeAvailableCapacity } from '../orchestration/DispatchTriggerEvaluator';
import { getArm, countLivePlanningSessions } from '../db/queries';
import { yieldToEventLoop } from '../utils/concurrency';
import type { SessionManager } from '../session/SessionManager';
import {
  listReportsFiltered,
  isDispatchEligible,
  isResolveEligible,
  updateReportState,
  type InvestigationReportRow,
} from './reportStore';
import { launchInvestigateBatch } from './investigateDispatcher';
import { MIGRATION_REASSIGNMENT_REPORT_MARKER } from '../db/migrationReservation';

const DEFAULT_SCAN_LIMIT = 50;
const DEFAULT_RESOLVE_SCAN_LIMIT = 200;

/**
 * Count of live (non-terminal) investigate-dispatched sessions — task_id
 * `report-batch:<batchId>` (see sessionPredicates.ts's isInvestigateSession),
 * the budget the investigate-specific sub-limit is checked against. Mirrors
 * db/queries.ts#countLiveVerifySessions' own task_id-prefix count.
 */
function countLiveInvestigateSessions(): number {
  const row = db
    .prepare<[], { c: number }>(
      `SELECT COUNT(*) as c FROM sessions
       WHERE task_id LIKE 'report-batch:%'
         AND status NOT IN ('done', 'error', 'killed', 'superseded')`,
    )
    .get();
  return row?.c ?? 0;
}

export interface InvestigationReconcilerOptions {
  /** Max number of committed reports scanned per tick, before arm/budget filtering. */
  scanLimit?: number;
}

export interface InvestigationReconcileTickResult {
  /** Report ids an investigate batch was just dispatched for this tick. */
  dispatched: string[];
  /** Count of eligible reports this tick found but passed over solely for want of dispatch budget. */
  skippedForBudget: number;
}

/**
 * One reconcile tick: scans committed investigation reports with no live
 * non-terminal session (isDispatchEligible, backed by the
 * investigation_report_dispatch join table), filters to milestones with the
 * 'investigate' flow armed, budgets against the shared planning pool and the
 * investigate-specific sub-limit, revalidates each candidate immediately
 * before dispatch (closing the scan-time/launch-time race — mirrors
 * DispatchTriggerEvaluator.dispatchUpTo's own revalidate-before-dispatch
 * pattern), and dispatches one always-batched (single-report) investigate
 * batch per eligible report via launchInvestigateBatch. Mirrors
 * gate/gateReconciler.ts's own tick shape.
 */
export async function runInvestigationReconcilerTick(
  sessionManager: SessionManager,
  options: InvestigationReconcilerOptions = {},
): Promise<InvestigationReconcileTickResult> {
  const scanLimit = options.scanLimit ?? DEFAULT_SCAN_LIMIT;

  const candidates = listReportsFiltered({ state: 'committed' }, scanLimit, 0);

  const armedByMilestone = new Map<string, boolean>();
  const armedCandidates: InvestigationReportRow[] = [];
  for (const report of candidates) {
    // A migration-number-reassignment claim was already mechanically
    // re-derived against the live reservation table at file time (see
    // stagedIntents.ts's report.file apply case) — a committed row here
    // means the orchestrator already confirmed it, so it needs only
    // operator disposition via the report surface, never an investigate
    // session digging further into an already-settled question.
    if (report.evidence_text?.includes(MIGRATION_REASSIGNMENT_REPORT_MARKER)) {
      continue;
    }
    let armed = armedByMilestone.get(report.milestone_id);
    if (armed === undefined) {
      armed = getArm(report.milestone_id, 'investigate');
      armedByMilestone.set(report.milestone_id, armed);
    }
    if (armed) armedCandidates.push(report);
  }

  const planningAvailable = computeAvailableCapacity({
    maxConcurrentPlanningSessions: typedGetSetting(
      'max_concurrent_planning_sessions',
    ),
    humanReserve: typedGetSetting('human_reserve'),
    activePlanningSessions: countLivePlanningSessions(),
  });
  const investigateAvailable = Math.max(
    0,
    typedGetSetting('max_concurrent_investigate_sessions') -
      countLiveInvestigateSessions(),
  );
  let dispatchBudget = Math.min(planningAvailable, investigateAvailable);
  if (dispatchBudget <= 0 && armedCandidates.length > 0) {
    logger.warn(
      `[InvestigationReconciler] dispatch budget exhausted this tick (planningAvailable=${planningAvailable}, investigateAvailable=${investigateAvailable}) — no auto-run investigate batches will be dispatched`,
    );
  }

  const dispatched: string[] = [];
  let skippedForBudget = 0;

  for (const report of armedCandidates) {
    await yieldToEventLoop();

    if (dispatchBudget <= 0) {
      skippedForBudget++;
      continue;
    }
    // Revalidate against freshly-read state immediately before dispatch — a
    // report that passed the scan above may have had another dispatch land
    // (or been abandoned) in the interim.
    if (!isDispatchEligible(report.id)) continue;

    await launchInvestigateBatch(sessionManager, [report.id]);
    dispatched.push(report.id);
    dispatchBudget--;
  }

  return { dispatched, skippedForBudget };
}

export interface ReportResolveWatcherOptions {
  /** Max number of committed reports scanned per page. */
  scanLimit?: number;
}

export interface ReportResolveWatcherTickResult {
  /** Report ids advanced committed -> resolved this tick. */
  resolved: string[];
}

/**
 * One resolve-watcher tick: the closure the design locked but no code path
 * ever drove — advances every committed report whose full dispatch history
 * (investigation_report_dispatch, aggregated across every session ever
 * dispatched for it) has settled from committed -> resolved. Deliberately a
 * Scheduler job over isResolveEligible rather than a staged-intent
 * disposition hook: a disposition hook structurally cannot see the
 * zero-intent case (a session that investigated and staged nothing),
 * because there is no disposition event to hook for a report with no
 * intents at all — isResolveEligible's own docstring calls this case out by
 * name. Idempotent across ticks: only 'committed' rows are scanned, so a
 * report already advanced to 'resolved' on a prior tick is never
 * re-examined, and 'abandoned' rows are never touched (excluded by the same
 * state filter) — this watcher has no authority to move a report out of
 * 'abandoned'.
 */
export function runReportResolveWatcherTick(
  options: ReportResolveWatcherOptions = {},
): ReportResolveWatcherTickResult {
  const scanLimit = options.scanLimit ?? DEFAULT_RESOLVE_SCAN_LIMIT;
  const resolved: string[] = [];
  let offset = 0;
  for (;;) {
    const page = listReportsFiltered({ state: 'committed' }, scanLimit, offset);
    for (const report of page) {
      if (isResolveEligible(report.id)) {
        updateReportState(report.id, 'resolved', new Date().toISOString());
        resolved.push(report.id);
      }
    }
    if (page.length < scanLimit) break;
    offset += scanLimit;
  }
  return { resolved };
}

/**
 * Registers the resolve watcher with the Scheduler, beside the dispatch
 * reconciler below — same cadence, since both are aspects of the same
 * committed-report lifecycle. Runs unconditionally: closure has no master
 * switch, and no per-report arm to check.
 */
function registerResolveWatcher(
  scheduler: Scheduler,
  options: ReportResolveWatcherOptions = {},
): void {
  scheduler.register({
    name: 'investigation_resolve_watcher',
    intervalMs: () => runtimeSettings.investigation_reconciler_interval_ms,
    concurrency: 'skip-if-running',
    run: async () => {
      const { resolved } = runReportResolveWatcherTick(options);
      return { items_processed: resolved.length };
    },
  });
}

/**
 * Registers the reconciler with the Scheduler. Dispatch is gated per
 * milestone by the (milestone, 'investigate') arm checked inside the tick
 * above — flow_arm and DEFAULT_ARM.investigate remain the sole dispatch
 * control. Mirrors gate/gateReconciler.ts's own register().
 */
export function register(
  scheduler: Scheduler,
  sessionManager: SessionManager,
  options: InvestigationReconcilerOptions = {},
): void {
  scheduler.register({
    name: 'investigation_reconciler',
    intervalMs: () => runtimeSettings.investigation_reconciler_interval_ms,
    concurrency: 'skip-if-running',
    run: async () => {
      const result = await runInvestigationReconcilerTick(
        sessionManager,
        options,
      );
      const items_processed =
        result.dispatched.length > 0
          ? result.dispatched.length
          : result.skippedForBudget > 0
            ? -result.skippedForBudget
            : 0;
      return { items_processed };
    },
  });
  registerResolveWatcher(scheduler);
}
