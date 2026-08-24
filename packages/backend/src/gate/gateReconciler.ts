import { logger } from '../logger';
import type { Scheduler } from '../orchestration/Scheduler';
import { getProjectById, runtimeSettings } from '../config';
import { typedGetSetting } from '../config/settings';
import { computeAvailableCapacity } from '../orchestration/DispatchTriggerEvaluator';
import { getTaskBackend } from '../tasks/TaskBackend';
import { yieldToEventLoop } from '../utils/concurrency';
import { getProjectDeployedSha } from '../deploy/deployService';
import {
  countLivePlanningSessions,
  countLiveVerifySessions,
  findActiveGateVerifyMirrorForItem,
  getArm,
  getGateItemsWithPendingCapabilityRequest,
  hasLiveVerifySessionForGateItem,
  listActiveGateVerifyMirrors,
  type GateVerifyMirrorOrigin,
} from '../db/queries';
import * as gateStore from './gateStore';
import type { GateItem } from './gateStore';
import {
  renderTaskBodyMarkdown,
  type TaskBodySections,
} from '../tasks/bodyRender';
import { catchUpMergeCommits } from './gateMergeConsumer';
import {
  resolveMilestoneDatabaseId,
  resolveMilestoneRowForProject,
  createWrappedMilestoneChecker,
  UnknownMilestoneError,
} from '../projects/milestoneResolver';
import {
  getGateReadiness,
  reconcileGateRunnability,
  nextRunnableGateItems,
  nextPendingGateItems,
  appendGateItemEvent,
  createLocalAsyncGitAncestrySource,
  isFollowupTaskDone,
  proposeGateItemReclassification,
  GATE_VERIFICATION_RECONCILER_JOB,
  type GateReadiness,
  type ReconcileGateRunnabilityResult,
  type AsyncDeployAncestrySource,
} from './gateService';
import type { GateItemClassification } from '../db/types';

/**
 * The live deploy-SHA source, per project — reported in by each project's
 * deploy flow (see deployService.getProjectDeployedSha) and swappable for
 * tests via the `deployAdvanceTrigger` option.
 */
export interface DeployAdvanceTrigger {
  /** The project's deployed SHA to reconcile against this tick, or null if never reported. */
  latestDeploySha(project: string): string | null | Promise<string | null>;
}

const defaultDeployAdvanceTrigger: DeployAdvanceTrigger = {
  latestDeploySha(project) {
    return getProjectDeployedSha(project);
  },
};

export interface GateVerificationResult {
  /**
   * `needs-setup` is the bounded best-effort abstain: the verifier could not
   * settle pass/fail within its read/time/turn budget. It is not a new gate
   * state — appendGateItemEvent records it as a non-terminal disposition
   * (like `noted`), leaving the item runnable; nextRunnableGateItems skips
   * it on the next pull until a reclassify/reopen/new-source event
   * supersedes it as the item's latest event.
   *
   * `deferred` is only ever reached via an operator-supplied disposition on
   * a Human-Observation mirror intent (stagedIntents.ts's gate.verify apply
   * case) — no verifier ever proposes it. It matches GateReadinessPanel's
   * direct-path "Defer" action: the item resolves to the `deferred` state,
   * punting it to the next milestone, without filing follow-up work.
   *
   * `not-yet-triggerable` is the "the scenario hasn't occurred / the data
   * doesn't exist yet" abstain — distinct from `needs-setup`'s "a human
   * must perform a setup step" abstain. Unlike `needs-setup`, it advances
   * state: appendGateItemEvent (gateService.ts) parks the item at `pending`
   * with a backoff-scheduled next_attempt_at, which nextPendingGateItems /
   * the reconciler tick re-pulls once elapsed — see routeVerificationResult
   * below, which forwards it through the same generic disposition/evidence
   * write the `pass` case uses.
   */
  disposition:
    | 'pass'
    | 'fail'
    | 'needs-setup'
    | 'deferred'
    | 'not-yet-triggerable';
  evidence?: unknown;
  /**
   * Set only when `disposition` is `needs-setup` and the session was never
   * dispatched at all — a capacity/infra failure, not a verifier verdict.
   * Distinguishes that case from a genuine verifier abstain so the
   * reconciler can log it without occupying the item's latest_disposition,
   * keeping the item eligible for the next `next` pull and auto-run tick.
   */
  dispatchFailed?: boolean;
  /**
   * A self-correction: the session determined the item is mis-classified
   * and proposes the correct tier instead of forcing a pass/fail (or a bare
   * abstain) on a tier it structurally cannot verify. Supersedes
   * `disposition` for routing purposes when the backend accepts it — see
   * gateService.proposeGateItemReclassification.
   */
  reclassify?: {
    to: GateItemClassification;
    reason: string;
  };
  /**
   * Set when this result came from a session's own `gate.verify` report,
   * staged as a normal intent rather than written straight to
   * gate_item_event (see mcp/tools/verdictTools.ts,
   * AgentSession.recordGateVerifyDisposition). The verdict is not yet
   * final — it is awaiting operator disposition on the decision surface —
   * so `routeVerificationResult` must not write a gate_item_event or file
   * follow-up work for it here; that happens later, once, from
   * stagedIntents.ts's `gate.verify` apply case, which re-routes the
   * operator-approved result through this exact function with this flag
   * unset.
   */
  awaitingDisposition?: boolean;
}

/**
 * The auto-run mechanism for a gate item — "verified-by-mechanism" in the
 * classification model. No concrete mechanism is wired by default; tiers
 * are skipped (with a warning) until a verifier is injected.
 */
export interface GateItemVerifier {
  verify(item: GateItem): Promise<GateVerificationResult>;
}

/**
 * A verifier that can also re-attach to an already-dispatched, still-live
 * verify session — no new dispatch, just a fresh `awaitDisposition`
 * listener. Boot reconciliation uses this (when the wired verifier
 * implements it, e.g. SessionGateItemVerifier) to recover a session left
 * parked on an outstanding capability request across a restart, since the
 * old process's in-memory listener died with it.
 */
export interface ReattachableGateItemVerifier extends GateItemVerifier {
  reattach(item: GateItem, sessionId: string): Promise<GateVerificationResult>;
}

function isReattachable(
  verifier: GateItemVerifier,
): verifier is ReattachableGateItemVerifier {
  return (
    typeof (verifier as ReattachableGateItemVerifier).reattach === 'function'
  );
}

interface FollowupFixTask {
  taskId: string;
  taskTitle: string;
}

/** Files the follow-up fix task a failing verification attaches as a new gate_item_source. */
export interface FollowupFixTaskFiler {
  fileFollowupFixTask(
    item: GateItem,
    failure: GateVerificationResult,
  ): Promise<FollowupFixTask>;
}

/**
 * The follow-up fix task's Type, derived from the gate item it remediates
 * rather than hardcoded — a mis-typed follow-up (e.g. a documentation
 * assertion filed as 💻 Code, which auto-dispatches to a headless session
 * with no Notion write access) cannot actually satisfy the gate item it
 * exists to fix. Human-Observation items are, by this module's own auto-run
 * exclusion above, "unverifiable by any headless session" — the same
 * headless-session limitation applies to fixing one, so its follow-up goes
 * to 📐 Design (interactive, human-driven) instead of Code. Every other
 * classification (Read-Only, Prod-Mutating, needs-triage) keeps the prior
 * Code default, since those items describe verifiable code/config behavior.
 */
function deriveFollowupTaskType(item: GateItem): string {
  return item.classification === 'Human-Observation' ? '📐 Design' : '💻 Code';
}

/** Every filed follow-up fix blocks the gate the item belongs to — none of them are ever low-priority busywork. */
const FOLLOWUP_TASK_PRIORITY = '🔴 High';

/**
 * The verifier's evidence contract (see gateVerifyEvidenceSchema in
 * mcp/tools/schemas.ts) is `expected`/`found`/`query` required, `source`
 * optional — but GateVerificationResult.evidence is typed `unknown` since
 * non-verifier-authored fail events (dispatch failures, budget exceeded,
 * ...) carry other shapes (e.g. `{ reason }`). Narrows to the structured
 * shape when present, so a followup body can quote it verbatim without
 * assuming it's always there.
 */
function extractVerifierEvidence(
  evidence: unknown,
):
  | { expected: string; found: string; query: string; source?: string }
  | undefined {
  if (typeof evidence !== 'object' || evidence === null) return undefined;
  const e = evidence as Record<string, unknown>;
  if (
    typeof e.expected === 'string' &&
    typeof e.found === 'string' &&
    typeof e.query === 'string'
  ) {
    return {
      expected: e.expected,
      found: e.found,
      query: e.query,
      source: typeof e.source === 'string' ? e.source : undefined,
    };
  }
  return undefined;
}

/**
 * Builds the follow-up fix task's body from the gate item and the failure
 * that spawned it — a groom session working this task should never need to
 * go looking for the gate item or its event history to recover what the
 * verifier already found. Rendered through renderTaskBodyMarkdown so the
 * body parses under the same section model the promotion gate uses.
 */
function buildFollowupTaskBody(
  item: GateItem,
  failure: GateVerificationResult,
): string {
  const evidence = extractVerifierEvidence(failure.evidence);
  const originatingSource = item.sources[0];

  const context: TaskBodySections['context'] = [
    {
      type: 'paragraph',
      text: `Gate item ${item.id} — ${item.classification}, milestone ${item.milestone}.`,
    },
    { type: 'heading_3', text: 'Gate item text' },
    { type: 'paragraph', text: item.text },
    { type: 'heading_3', text: 'Verifier evidence' },
  ];

  if (evidence) {
    context.push(
      { type: 'bulleted_list_item', text: `Expected: ${evidence.expected}` },
      { type: 'bulleted_list_item', text: `Found: ${evidence.found}` },
      { type: 'bulleted_list_item', text: `Query: ${evidence.query}` },
    );
    if (evidence.source) {
      context.push({
        type: 'bulleted_list_item',
        text: `Source: ${evidence.source}`,
      });
    }
  } else {
    context.push({
      type: 'paragraph',
      text: 'No structured verifier evidence was recorded for this failure.',
    });
  }

  context.push(
    { type: 'heading_3', text: 'Deploy' },
    {
      type: 'paragraph',
      text: `Deployed SHA at failure: ${item.minDeployedCommit ?? 'unknown'}`,
    },
  );

  if (originatingSource) {
    context.push({
      type: 'paragraph',
      text: `Originating source task: ${originatingSource.sourceTaskId} (${originatingSource.sourceTaskTitle})`,
    });
  }

  const sections: TaskBodySections = {
    summary: `Fix gate item ${item.id}: ${item.text}`,
    dependencies: [],
    context,
    automatedCriteria: [`Gate item ${item.id} re-verifies as pass.`],
    manualCriteria: [],
    taskType: deriveFollowupTaskType(item),
  };
  return renderTaskBodyMarkdown(sections);
}

export const defaultFollowupFiler: FollowupFixTaskFiler = {
  async fileFollowupFixTask(item, failure) {
    const databaseId = resolveMilestoneDatabaseId(item.project, item.milestone);
    const backend = getTaskBackend(item.project);
    if (!backend.createTask) {
      throw new Error(
        `[GateReconciler] task backend for project ${item.project} does not support createTask`,
      );
    }
    const title = `Fix gate item: ${item.text}`;
    const taskId = await backend.createTask({
      databaseId,
      title,
      type: deriveFollowupTaskType(item),
      priority: FOLLOWUP_TASK_PRIORITY,
      body: buildFollowupTaskBody(item, failure),
    });
    return { taskId, taskTitle: title };
  },
};

/**
 * Classifications the reconciler auto-runs, one tier at a time. Read-Only
 * auto-disposes on pass (gateService resolves it straight to 'pass');
 * Prod-Mutating is run the same way but never mutates — its verifier only
 * gathers read-only evidence, and gateService routes a pass to
 * 'pending-approval' (held until an operator calls approveGateItem) rather
 * than resolving it. Both tiers are also pending-eligible: a
 * `not-yet-triggerable` result parks the item at `pending` on a backoff
 * schedule, pulled back in by nextPendingGateItems alongside this loop (see
 * the tick's auto-run loop below). needs-triage is excluded: it requires
 * human classification before it can be routed at all. Human-Observation is
 * excluded too, but for a different reason: it is not merely unrouted, it
 * is unverifiable by any headless session (UI/visual/interactive behavior
 * can only be judged by a human observing the running app) so it never
 * enters the tick's auto-run loop. It can still be manually dispatched (the
 * operator-triggered verify surface, dispatchGateItemVerification) to
 * gather advisory pre-check evidence, but gateService.appendGateItemEvent
 * refuses to let a verifier-originated pass resolve it regardless of how it
 * was dispatched.
 */
const AUTO_RUN_TIERS: GateItemClassification[] = ['Read-Only', 'Prod-Mutating'];

const DEFAULT_TIER_LIMIT = 10;

/** Bounded escalation thresholds for the auto-run safety envelope. */
const DEFAULT_MAX_DISPATCH_ATTEMPTS = 3;
const DEFAULT_MAX_FIX_ATTEMPTS = 3;

/**
 * NOTE: despite the name, `maxDispatchAttempts`/`maxFixAttempts` below are
 * escalation thresholds (consecutive-crash / fix-cycle counters), not
 * concurrency limits. The actual dispatch concurrency cap lives in settings
 * as `max_concurrent_verify_sessions` (see typedGetSetting in
 * runGateReconcilerTick) — a sub-limit of the shared
 * max_concurrent_planning_sessions pool, not a separate pool.
 */
export interface GateVerificationConcurrencyConfig {
  /** Consecutive verifier crashes (thrown errors) before the item is forced to needs-setup. */
  maxDispatchAttempts?: number;
  /** Fix cycles (fail -> follow-up filed) before further fails escalate to needs-setup instead of refiling. */
  maxFixAttempts?: number;
}

/** Per-item in-flight guard: item ids currently mid-verify, across ticks/manual dispatch — never double-dispatched. */
const inFlightVerifications = new Set<string>();
/** Consecutive verifier-crash counts per item, reset on a clean result. */
const crashCounts = new Map<string, number>();

export interface GateReconcilerOptions {
  deployAdvanceTrigger?: DeployAdvanceTrigger;
  verifier?: GateItemVerifier;
  followupFiler?: FollowupFixTaskFiler;
  tierLimit?: number;
  /** Per-project git-ancestry source; defaults to a local clone at that project's projectDir. */
  ancestrySourceForProject?: (project: string) => AsyncDeployAncestrySource;
  concurrency?: GateVerificationConcurrencyConfig;
}

interface ProcessedGateItem {
  itemId: string;
  classification: GateItemClassification;
  disposition:
    | 'pass'
    | 'fail'
    | 'needs-setup'
    | 'deferred'
    | 'not-yet-triggerable';
  /** Set when this run applied a verifier-proposed self-correction — `classification` above already reflects it. */
  reclassifiedTo?: GateItemClassification;
}

export interface GateReconcileTickResult {
  deployShaByProject: Record<string, string | null>;
  reconciled: ReconcileGateRunnabilityResult | null;
  processed: ProcessedGateItem[];
  /** Keyed by `${project}::${milestone}`, not milestone alone — see projectMilestones above. */
  readiness: Record<string, GateReadiness>;
  /**
   * Count of runnable items this tick found but passed over solely because
   * the dispatch budget (planning/verify capacity) had run out — as
   * distinct from finding no runnable items at all. A tick that is
   * silently starved of budget every time (e.g. a stale live-session count
   * pinning it at zero) otherwise looks identical in scheduler_audit to a
   * healthy, idle tick: status=ok, items_processed=0. See register() below,
   * which folds this into the audited items_processed as a negative count
   * so the two cases are distinguishable without a schema change.
   */
  skippedForBudget: number;
}

function defaultAncestrySourceForProject(
  project: string,
): AsyncDeployAncestrySource {
  let projectDir: string | undefined;
  try {
    projectDir = getProjectById(project)?.projectDir;
  } catch {
    projectDir = undefined;
  }
  return createLocalAsyncGitAncestrySource(projectDir);
}

/** Most recent `fail` event carrying a filedFollowon, or undefined if the item has never failed-with-followup. */
function latestFailFollowon(item: GateItem): string | undefined {
  for (let i = item.events.length - 1; i >= 0; i--) {
    const e = item.events[i];
    if (e.disposition === 'fail' && e.filedFollowon) return e.filedFollowon;
  }
  return undefined;
}

/** Fix cycles already spent on this item — a `fail` event that filed a follow-up. */
function countFixAttempts(item: GateItem): number {
  return item.events.filter((e) => e.disposition === 'fail' && e.filedFollowon)
    .length;
}

/** Wraps verifier evidence with the bookkeeping reconcileGateRunnability's auto-reopen needs to tell "already covered" from "a fix just deployed". */
function failEvidence(item: GateItem, verifierEvidence: unknown): unknown {
  return {
    verifierEvidence,
    minDeployedCommitAtFail: item.minDeployedCommit ?? null,
  };
}

/**
 * Appends the verifier's outcome and routes it:
 *  - pass/needs-setup: appendGateItemEvent as-is (pass is provenance-tagged
 *    with `passOperator`, 'gate-verifier' by default; needs-setup is the
 *    non-terminal abstain).
 *  - fail: dedup — while a prior filed follow-up is still open (not Done),
 *    log the fresh failure against it instead of refiling; escalate to
 *    needs-setup instead of refiling once maxFixAttempts is spent; otherwise
 *    file a fresh follow-up, attach it as a new source, and re-open the item.
 *
 * The per-item in-flight guard (inFlightVerifications) and the
 * per-item crash counter (crashCounts, escalating to needs-setup after
 * maxDispatchAttempts) wrap the verifier dispatch itself — this function
 * returns null when guarded (duplicate dispatch) or when a crash hasn't yet
 * hit the escalation threshold (no event recorded this attempt).
 */
/**
 * Synchronous reserve-or-refuse against the in-flight guard — must complete
 * with no intervening `await`, so two dispatchers racing for the same item
 * (a tick and a manual dispatch, or two manual dispatches) can never both
 * win it. Callers that win are responsible for releasing it.
 */
function tryReserveInFlight(itemId: string): boolean {
  if (inFlightVerifications.has(itemId)) return false;
  inFlightVerifications.add(itemId);
  return true;
}

async function processItem(
  item: GateItem,
  verifier: GateItemVerifier,
  followupFiler: FollowupFixTaskFiler,
  deploySha: string | null,
  concurrency: GateVerificationConcurrencyConfig = {},
): Promise<ProcessedGateItem | null> {
  // DB-backed guard, ahead of the in-memory reservation below: catches a
  // live verify session dispatched by an earlier process (e.g. before a
  // restart), which inFlightVerifications alone cannot see. Auto-run only —
  // dispatchGateItemVerification (operator-triggered) intentionally skips
  // this so an explicit re-verify is never blocked by a prior session.
  if (hasLiveVerifySessionForGateItem(item.id)) {
    return null;
  }
  if (!tryReserveInFlight(item.id)) {
    return null;
  }
  // processItem is only ever called from the tick's own auto-run loop — a
  // fully-unattended verification, with no operator dispatch involved.
  return runReservedVerification(
    item,
    verifier,
    followupFiler,
    deploySha,
    concurrency,
    true,
  );
}

/**
 * The post-`verify()` routing body: pass/fail/needs-setup/reclassify ->
 * appendGateItemEvent + follow-up-fix logic. Split out from
 * runReservedVerification so it's reusable from the boot-reattachment path
 * (reattachOutstandingGateVerifications below), which obtains its result via
 * a verifier's `reattach` rather than a fresh `verify()` dispatch but routes
 * it identically.
 */
export async function routeVerificationResult(
  item: GateItem,
  result: GateVerificationResult,
  followupFiler: FollowupFixTaskFiler,
  deploySha: string | null,
  concurrency: GateVerificationConcurrencyConfig = {},
  /** true = unattended (reconciler auto-launch / boot reattachment); false = operator-triggered manual dispatch (dispatchGateItemVerification) — recorded on every event this run appends. */
  unattended = false,
  /**
   * The operator provenance recorded on a `pass` event. Deliberately no
   * default value — a JS default parameter only substitutes on an
   * `undefined` *argument*, which is exactly the value the mirror call site
   * below needs to pass through untouched, so a default here would silently
   * clobber it back to 'gate-verifier'. Every headless-verifier-originated
   * call (auto-run, boot reattachment, and an operator-approved verifier
   * report re-routed through here from the decision surface) passes
   * 'gate-verifier' explicitly. stagedIntents.ts's gate.verify apply case
   * passes `undefined` only for an operator-supplied Human-Observation
   * *mirror* disposition — there, no verifier ever ran; the pass is a
   * human's own judgment and must not be tagged as the verifier's, or
   * isVerifierBlockedFromPassing (gateService.ts) wrongly suppresses it to
   * advisory-only and the item never advances.
   */
  passOperator: string | undefined,
): Promise<ProcessedGateItem> {
  const maxFixAttempts = concurrency.maxFixAttempts ?? DEFAULT_MAX_FIX_ATTEMPTS;

  if (result.awaitingDisposition) {
    // Handed off to the decision surface — a human disposes it, and that
    // disposition re-enters this exact function (see stagedIntents.ts's
    // `gate.verify` apply case) without this flag set. Nothing to write yet.
    return {
      itemId: item.id,
      classification: item.classification,
      disposition: result.disposition,
    };
  }

  if (result.reclassify) {
    const outcome = proposeGateItemReclassification(
      item.id,
      result.reclassify.to,
      result.reclassify.reason,
    );
    if (outcome.applied) {
      logger.info(
        `[GateReconciler] gate item ${item.id} reclassified ${item.classification} -> ${outcome.item.classification} by verifier: ${result.reclassify.reason}`,
      );
      return {
        itemId: item.id,
        classification: outcome.item.classification,
        disposition: 'needs-setup',
        reclassifiedTo: outcome.item.classification,
      };
    }
    // Rejected (invalid target, no-op, or the ping-pong guard) — abstain
    // rather than silently drop the run; the rejection reason and the
    // session's original evidence both ride along for a human to see.
    appendGateItemEvent(item.id, {
      disposition: 'needs-setup',
      evidence: {
        reason: 'verifier-proposed reclassification rejected',
        rejectedReason: outcome.rejectedReason,
        proposedReclassify: result.reclassify,
        verifierEvidence: result.evidence,
      },
      deploySha: deploySha ?? undefined,
      unattended,
    });
    return {
      itemId: item.id,
      classification: item.classification,
      disposition: 'needs-setup',
    };
  }
  if (result.disposition === 'needs-setup' && result.dispatchFailed) {
    // Infra failure, not a verifier verdict — log-only, no disposition, so
    // the item's latest_disposition (and its eligibility for the next
    // `next` pull / auto-run tick) is left untouched.
    appendGateItemEvent(item.id, {
      evidence: result.evidence,
      deploySha: deploySha ?? undefined,
      unattended,
    });
  } else if (result.disposition === 'needs-setup') {
    appendGateItemEvent(item.id, {
      disposition: 'needs-setup',
      evidence: result.evidence,
      deploySha: deploySha ?? undefined,
      unattended,
    });
  } else if (result.disposition === 'fail') {
    const priorFollowon = latestFailFollowon(item);
    const dedup =
      priorFollowon !== undefined && !isFollowupTaskDone(priorFollowon);
    const fixAttempts = countFixAttempts(item);

    if (dedup) {
      appendGateItemEvent(item.id, {
        disposition: 'fail',
        evidence: failEvidence(item, result.evidence),
        filedFollowon: priorFollowon,
        deploySha: deploySha ?? undefined,
        unattended,
      });
      gateStore.advanceState(item.id, 'open', 'fail', new Date().toISOString());
    } else if (fixAttempts >= maxFixAttempts) {
      appendGateItemEvent(item.id, {
        disposition: 'needs-setup',
        evidence: {
          verifierEvidence: result.evidence,
          reason: `max-fix-attempts (${maxFixAttempts}) reached — escalate to operator`,
        },
        unattended,
      });
      return {
        itemId: item.id,
        classification: item.classification,
        disposition: 'needs-setup',
      };
    } else {
      const followup = await followupFiler.fileFollowupFixTask(item, result);
      appendGateItemEvent(item.id, {
        disposition: 'fail',
        evidence: failEvidence(item, result.evidence),
        filedFollowon: followup.taskId,
        deploySha: deploySha ?? undefined,
        unattended,
      });
      const now = new Date().toISOString();
      gateStore.addSource(
        item.id,
        {
          sourceTaskId: followup.taskId,
          sourceTaskTitle: followup.taskTitle,
        },
        now,
      );
      gateStore.advanceState(item.id, 'open', 'fail', now);
    }
  } else if (result.disposition === 'deferred') {
    // Punts to the next milestone — the same disposition
    // GateReadinessPanel's direct-path "Defer" button writes via
    // appendGateItemEvent, reached here only from an operator-supplied
    // mirror disposition (no verifier ever proposes this).
    appendGateItemEvent(item.id, {
      disposition: 'deferred',
      evidence: result.evidence,
      deploySha: deploySha ?? undefined,
      unattended,
    });
  } else {
    // pass, or not-yet-triggerable — a verifier-originated auto-pass is
    // provenance-tagged, never anonymous; an operator-supplied mirror pass
    // carries passOperator (undefined) so isVerifierBlockedFromPassing
    // doesn't mistake it for the verifier's own verdict. A
    // not-yet-triggerable result rides the same generic
    // disposition/evidence forward — appendGateItemEvent already parks it
    // at `pending` with a scheduled next_attempt_at (nextStateForDisposition
    // / computeNotYetTriggerableBackoffHours, gateService.ts); the
    // `operator` tag has no effect on that path (isVerifierBlockedFromPassing
    // only special-cases `pass`).
    appendGateItemEvent(item.id, {
      disposition: result.disposition,
      evidence: result.evidence,
      deploySha: deploySha ?? undefined,
      operator: passOperator,
      unattended,
    });
  }

  return {
    itemId: item.id,
    classification: item.classification,
    disposition: result.disposition,
  };
}

/** The verify-dispatch-and-route body, assuming the in-flight slot is already reserved (by processItem or dispatchGateItemVerification). Always releases it. */
async function runReservedVerification(
  item: GateItem,
  verifier: GateItemVerifier,
  followupFiler: FollowupFixTaskFiler,
  deploySha: string | null,
  concurrency: GateVerificationConcurrencyConfig = {},
  /** true = reconciler auto-launch (processItem); false = operator-triggered manual dispatch (dispatchGateItemVerification) — recorded on every event this run appends. */
  unattended = false,
): Promise<ProcessedGateItem | null> {
  const maxDispatchAttempts =
    concurrency.maxDispatchAttempts ?? DEFAULT_MAX_DISPATCH_ATTEMPTS;

  let result: GateVerificationResult;
  try {
    result = await verifier.verify(item);
  } catch (err) {
    inFlightVerifications.delete(item.id);
    const attempts = (crashCounts.get(item.id) ?? 0) + 1;
    if (attempts < maxDispatchAttempts) {
      crashCounts.set(item.id, attempts);
      logger.warn(
        `[GateReconciler] verify crashed for gate item ${item.id} (attempt ${attempts}/${maxDispatchAttempts}): ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
    crashCounts.delete(item.id);
    appendGateItemEvent(item.id, {
      disposition: 'needs-setup',
      evidence: {
        reason: 'verifier crashed repeatedly',
        attempts,
        error: err instanceof Error ? err.message : String(err),
      },
      unattended,
    });
    return {
      itemId: item.id,
      classification: item.classification,
      disposition: 'needs-setup',
    };
  }
  crashCounts.delete(item.id);

  try {
    return await routeVerificationResult(
      item,
      result,
      followupFiler,
      deploySha,
      concurrency,
      unattended,
      'gate-verifier',
    );
  } finally {
    inFlightVerifications.delete(item.id);
  }
}

/**
 * Boot-reconciliation recovery for a gate-verify session left parked on an
 * outstanding capability request across a restart: the old process's
 * in-memory `awaitDisposition` listener died with it, so without this the
 * session's eventual `gate_verify_disposition` report fires into a void and
 * `hasLiveVerifySessionForGateItem` keeps the item permanently skipped on
 * every future reconcile tick even though the session itself completes and
 * archives cleanly. No new session is dispatched — the existing session is
 * already parked and will be resumed by the operator's disposition through
 * the existing `resumeCapabilityRequester` path; this just re-attaches a
 * listener via the configured verifier so that resumption's eventual report
 * is actually routed somewhere.
 */
export async function reattachOutstandingGateVerifications(): Promise<void> {
  const configured = configuredVerificationOptions;
  if (!configured?.verifier || !isReattachable(configured.verifier)) return;
  const verifier = configured.verifier;
  const followupFiler = configured.followupFiler ?? defaultFollowupFiler;
  const trigger =
    configured.deployAdvanceTrigger ?? defaultDeployAdvanceTrigger;
  const concurrency = configured.concurrency;

  const pending = getGateItemsWithPendingCapabilityRequest();
  for (const { itemId, sessionId } of pending) {
    const item = gateStore.getItem(itemId);
    if (!item) continue;
    if (!tryReserveInFlight(itemId)) continue;
    void (async () => {
      try {
        const deploySha = await trigger.latestDeploySha(item.project);
        const result = await verifier.reattach(item, sessionId);
        await routeVerificationResult(
          item,
          result,
          followupFiler,
          deploySha,
          concurrency,
          true,
          'gate-verifier',
        );
      } catch (err) {
        logger.error(
          `[GateReconciler] boot reattachment failed for gate item ${itemId} (session ${sessionId.slice(0, 8)}): ${err instanceof Error ? err.message : err}`,
        );
      } finally {
        inFlightVerifications.delete(itemId);
      }
    })();
  }
}

/**
 * The reconciler's Human-Observation mirror callbacks, wired at server
 * bootstrap (see server.ts's configureGateItemMirrorSink) to stagedIntents.ts's
 * stageIntent / withdrawGateVerifyMirror. Kept as an injected interface
 * rather than a direct import — stagedIntents.ts already imports
 * routeVerificationResult/defaultFollowupFiler from this module, so a static
 * import in the other direction would be a cycle.
 */
/**
 * The gate-item states/conditions this reconciler surfaces into the
 * Decision Inbox — see reconcileHumanObservationMirrors. `'unresolved-source'`
 * is staged elsewhere (gateMergeConsumer.ts's catchUpMergeCommits, once a
 * source's merge-commit lookup has failed past its escalation ceiling) but
 * retired here, alongside `'mirror'`/`'consent'`, by the same level-triggered
 * scan — see isUnresolvedSourceStillLive below.
 */
type GateItemMirrorOrigin = GateVerifyMirrorOrigin;

export interface GateItemMirrorSink {
  /**
   * Stage a `gate.verify` mirror intent for an item the operator needs to
   * see on the decision surface: `origin: 'mirror'` for a runnable
   * Human-Observation item (no groupId, no pre-set disposition — the
   * operator supplies pass/fail/deferred at apply time); `origin: 'consent'`
   * for a Prod-Mutating item held at pending-approval (the operator
   * approves/rejects it directly, mirroring GateReadinessPanel's consent
   * gate rather than routing through a disposition).
   */
  stageMirror(item: GateItem, origin: GateItemMirrorOrigin): void;
  /** Retire (withdraw) a live mirror intent whose backing gate_item has left the state that earned it a mirror. */
  retireMirror(intentId: string, reason: string): void;
}

let configuredMirrorSink: GateItemMirrorSink | null = null;

/** Wires the mirror-staging sink for reconcileHumanObservationMirrors below. */
export function configureGateItemMirrorSink(sink: GateItemMirrorSink): void {
  configuredMirrorSink = sink;
}

export interface GateItemMirrorReconcileResult {
  staged: string[];
  retired: string[];
}

/** True for a runnable Human-Observation item — no headless session can judge rendered UI/visual state, so it needs an operator disposition. */
function isMirrorCandidate(item: GateItem): boolean {
  return (
    item.classification === 'Human-Observation' && item.state === 'runnable'
  );
}

/** True for a Prod-Mutating item held at pending-approval — a pass an operator must explicitly consent to or reject before it resolves. */
function isConsentCandidate(item: GateItem): boolean {
  return (
    item.classification === 'Prod-Mutating' && item.state === 'pending-approval'
  );
}

/** Terminal gate_item states — no longer blocks anything, including an unresolved-source escalation. */
const TERMINAL_GATE_ITEM_STATES = new Set(['pass', 'deferred', 'discarded']);

/**
 * True while an escalated item's source still lacks a merge_commit —
 * the `'unresolved-source'` mirror's "still live" condition. Unlike
 * `isMirrorCandidate`/`isConsentCandidate`, this isn't also this origin's
 * staging trigger: staging happens in gateMergeConsumer.ts's
 * catchUpMergeCommits, keyed off its own in-memory attempt count, not off a
 * DB-queryable item shape. This predicate only decides retirement — once
 * every source has a merge_commit (a later catchUpMergeCommits pass filled
 * it) or the item resolved another way, the mirror is stale.
 */
function isUnresolvedSourceStillLive(item: GateItem): boolean {
  return (
    !TERMINAL_GATE_ITEM_STATES.has(item.state) &&
    item.sources.some((s) => !s.mergeCommit)
  );
}

/** The withdrawal reason for a mirror whose backing item left the classification/state that earned it a mirror of the given origin. */
function retireReasonFor(origin: GateItemMirrorOrigin, item: GateItem): string {
  if (origin === 'unresolved-source') {
    return item.sources.every((s) => s.mergeCommit)
      ? 'source merge commit resolved'
      : `gate_item resolved to ${item.state}`;
  }
  const expectedClassification: GateItemClassification =
    origin === 'mirror' ? 'Human-Observation' : 'Prod-Mutating';
  if (item.classification !== expectedClassification) {
    return `gate_item reclassified to ${item.classification}`;
  }
  return `gate_item resolved to ${item.state}`;
}

/**
 * Human-Observation items are excluded from AUTO_RUN_TIERS — no headless
 * session can judge rendered UI/visual state — so without this they live
 * only in the gate table, invisible unless an operator happens to browse
 * GateReadinessPanel filtered to that classification. A Prod-Mutating item
 * held at pending-approval has the opposite problem: it was verified, but
 * the consent gate (task-writing.md § Manual Verification Gate) holds it
 * for an operator's explicit approve/reject rather than resolving it — and
 * that hold is likewise invisible outside GateReadinessPanel. This mirrors
 * every unmirrored item matching either case into a staged `gate.verify`
 * intent (reusing its shape/kind, distinguished by payload.origin — see
 * GateItemMirrorOrigin) so both surface in the Decision Inbox instead.
 *
 * Level-triggered, not edge-triggered: re-evaluated every reconcile tick
 * (not just on the open->runnable or pass->pending-approval transition) so
 * an item accreted directly into either state is still caught. Idempotent
 * via findActiveGateVerifyMirrorForItem's per-origin dedup lookup — a
 * gate_item with an already-live mirror of that origin is never re-staged.
 * The companion retire pass rescans every live mirror of both origins each
 * tick (rather than hooking the direct GateReadinessPanel/consent routes
 * individually) so a mirror is retired however the underlying item left the
 * matching state — resolved via the direct panel path, approved/rejected
 * from the milestone surface, or reclassified away — without a stale card
 * lingering in the Inbox.
 */
export function reconcileHumanObservationMirrors(): GateItemMirrorReconcileResult {
  const staged: string[] = [];
  const retired: string[] = [];
  if (!configuredMirrorSink) return { staged, retired };
  const sink = configuredMirrorSink;

  // Shallow to pick candidates: isMirrorCandidate/isConsentCandidate below
  // only read project/milestone/classification/state, so scanning with
  // listAll()'s N+1 sources+events hydration on every all-time gate_item row
  // was pure waste here. sink.stageMirror, however, is an injected callback
  // (see server.ts) that DOES read a matched item's .events (the consent
  // origin's evidence is latestDispositionEvidence(item)) — so each matched
  // candidate is re-hydrated individually via getItem before being handed to
  // the sink. That keeps the N+1 bounded to only the (normally small) set of
  // items actually eligible for a mirror this tick, not every item ever
  // filed.
  const allItems = gateStore.listAllShallow();
  const candidatesByOrigin: [
    GateItemMirrorOrigin,
    (item: GateItem) => boolean,
  ][] = [
    ['mirror', isMirrorCandidate],
    ['consent', isConsentCandidate],
  ];
  for (const [origin, matches] of candidatesByOrigin) {
    for (const shallowItem of allItems.filter(matches)) {
      if (findActiveGateVerifyMirrorForItem(shallowItem.id, origin)) continue;
      const item = gateStore.getItem(shallowItem.id);
      if (!item) continue;
      sink.stageMirror(item, origin);
      staged.push(item.id);
    }
  }

  const stillLiveByOrigin: Record<
    GateItemMirrorOrigin,
    (item: GateItem) => boolean
  > = {
    mirror: isMirrorCandidate,
    consent: isConsentCandidate,
    'unresolved-source': isUnresolvedSourceStillLive,
  };
  for (const [origin, stillLive] of Object.entries(stillLiveByOrigin) as [
    GateItemMirrorOrigin,
    (item: GateItem) => boolean,
  ][]) {
    for (const mirror of listActiveGateVerifyMirrors(origin)) {
      let gateItemId: string | null = null;
      try {
        const payload = JSON.parse(mirror.payload) as { gateItemId?: unknown };
        gateItemId =
          typeof payload.gateItemId === 'string' ? payload.gateItemId : null;
      } catch {
        // Malformed payload — leave gateItemId null, treated as "backing item no longer exists" below.
      }
      const item = gateItemId ? gateStore.getItem(gateItemId) : undefined;
      if (item !== undefined && stillLive(item)) continue;
      const reason = !item
        ? 'backing gate_item no longer exists'
        : retireReasonFor(origin, item);
      sink.retireMirror(mirror.id, reason);
      retired.push(mirror.id);
    }
  }

  return { staged, retired };
}

/**
 * One reconcile tick: for each project with gate items, recomputes runnability
 * against that project's reported-deployed SHA (if any advance is reported),
 * then pulls one classification tier at a time per milestone (never a bulk
 * load), routes execution, and rolls per-milestone readiness into the
 * completion signal.
 */
export async function runGateReconcilerTick(
  options: GateReconcilerOptions = {},
): Promise<GateReconcileTickResult> {
  const trigger = options.deployAdvanceTrigger ?? defaultDeployAdvanceTrigger;
  const limit = options.tierLimit ?? DEFAULT_TIER_LIMIT;
  const followupFiler = options.followupFiler ?? defaultFollowupFiler;
  const ancestrySourceForProject =
    options.ancestrySourceForProject ?? defaultAncestrySourceForProject;

  // Durability net: catch up any gate_item_source.merge_commit a missed
  // merge_completed event left unfilled before reconciling runnability.
  await catchUpMergeCommits();

  // Shallow: this tick only reads project/milestone/classification/state off
  // allItems (below, and via reconcileHumanObservationMirrors) — never
  // .sources/.events — so the full sources+events N+1 hydration listAll()
  // does per row (2N+1 queries, doubled since this ran twice per tick) was
  // pure waste that scaled with all-time gate_item history. Also excludes a
  // wrapped milestone's items outright — see createWrappedMilestoneChecker
  // — since two thirds of all-time volume belongs to milestones already
  // closed out, with nothing left to reconcile.
  //
  // Cached once per tick: checking every item's milestone against
  // ProjectService would otherwise cost one DB round-trip per item rather
  // than per distinct project. See createWrappedMilestoneChecker.
  const isWrapped = createWrappedMilestoneChecker();
  const allItems = gateStore
    .listAllShallow()
    .filter((item) => !isWrapped(item.project, item.milestone));
  const projects = new Set(allItems.map((item) => item.project));
  const deployShaByProject: Record<string, string | null> = {};
  let reconciled: ReconcileGateRunnabilityResult | null = null;

  for (const project of projects) {
    const sha = await trigger.latestDeploySha(project);
    deployShaByProject[project] = sha;
    if (!sha) continue;
    const result = await reconcileGateRunnability(sha, {
      project,
      ancestrySource: ancestrySourceForProject(project),
      isMilestoneWrapped: isWrapped,
    });
    reconciled = reconciled
      ? {
          markedRunnable: [
            ...reconciled.markedRunnable,
            ...result.markedRunnable,
          ],
          reopened: [...reconciled.reopened, ...result.reopened],
        }
      : result;
  }

  // Level-triggered, independent of the auto-run tiers below — runs even
  // when no verifier is wired, since it stages Decision Inbox cards rather
  // than dispatching anything.
  const mirrorResult = reconcileHumanObservationMirrors();
  if (mirrorResult.staged.length > 0 || mirrorResult.retired.length > 0) {
    logger.info(
      `[GateReconciler] Human-Observation mirror pass: staged ${mirrorResult.staged.length}, retired ${mirrorResult.retired.length}`,
    );
  }

  // Keyed by project::milestone, not milestone alone — a milestone display
  // name is not unique across projects, so grouping by name alone would let
  // one project's /gate session pull and disposition another project's
  // items in the same tier pass.
  const projectMilestones = new Map<
    string,
    { project: string; milestone: string }
  >();
  for (const item of allItems) {
    projectMilestones.set(`${item.project}::${item.milestone}`, {
      project: item.project,
      milestone: item.milestone,
    });
  }
  const processed: ProcessedGateItem[] = [];
  /** Count of runnable items this tick passed over solely because dispatchBudget had run out — see GateReconcileTickResult.skippedForBudget. */
  let skippedForBudget = 0;

  if (!options.verifier) {
    if (projectMilestones.size > 0) {
      logger.warn(
        '[GateReconciler] no verifier wired — skipping auto-run for this tick',
      );
    }
  } else {
    const verifier = options.verifier;

    // Budget this tick's new dispatches: at most the smaller of (a) the
    // shared planning pool's headroom above the human reserve, mirroring
    // DispatchTriggerEvaluator's computeAvailableCapacity, and (b) the
    // verify-specific sub-limit. DEFAULT_TIER_LIMIT above only bounds how
    // many items are pulled per tier per tick — it is not a concurrency
    // limit, since sessions dispatched on prior ticks may still be live —
    // so this budget is the actual concurrency backstop ahead of
    // SessionManager.start's hard cap (still in place as the last line of
    // defense; a race between this read and the dispatch itself falls
    // through to it and to the dispatchFailed path).
    const planningAvailable = computeAvailableCapacity({
      maxConcurrentPlanningSessions: typedGetSetting(
        'max_concurrent_planning_sessions',
      ),
      humanReserve: typedGetSetting('human_reserve'),
      activePlanningSessions: countLivePlanningSessions(),
    });
    const verifyAvailable = Math.max(
      0,
      typedGetSetting('max_concurrent_verify_sessions') -
        countLiveVerifySessions(),
    );
    let dispatchBudget = Math.min(planningAvailable, verifyAvailable);
    if (dispatchBudget <= 0) {
      logger.warn(
        `[GateReconciler] dispatch budget exhausted this tick (planningAvailable=${planningAvailable}, verifyAvailable=${verifyAvailable}) — no auto-run verifications will be dispatched`,
      );
    }

    for (const { project, milestone } of projectMilestones.values()) {
      await yieldToEventLoop();

      let milestoneRow;
      try {
        milestoneRow = resolveMilestoneRowForProject(project, milestone);
      } catch (err) {
        if (err instanceof UnknownMilestoneError) {
          logger.warn(
            `[GateReconciler] cannot resolve milestone "${milestone}" for project ${project} — skipping auto-run for this milestone: ${err.message}`,
          );
          continue;
        }
        throw err;
      }
      if (!getArm(milestoneRow.id, 'gate-verify')) continue;
      for (const classification of AUTO_RUN_TIERS) {
        const batch = nextRunnableGateItems(project, milestone, {
          classification,
          limit,
        });
        for (const item of batch) {
          await yieldToEventLoop();

          if (dispatchBudget <= 0) {
            skippedForBudget++;
            continue;
          }
          const outcome = await processItem(
            item,
            verifier,
            followupFiler,
            deployShaByProject[item.project] ?? null,
            options.concurrency,
          );
          // Only a genuine dispatch attempt (verify() invoked) spends
          // budget — an item skipped by the in-flight/live-session guards
          // (outcome === null) claimed no new capacity.
          if (outcome) {
            processed.push(outcome);
            dispatchBudget--;
          }
        }
      }

      // Backoff-elapsed `pending` items — the not-yet-triggerable re-check
      // pull, mirroring the AUTO_RUN_TIERS loop above but over `pending`
      // state rather than a classification tier (pending is orthogonal to
      // classification; see nextPendingGateItems).
      const pendingBatch = nextPendingGateItems(project, milestone, { limit });
      for (const item of pendingBatch) {
        await yieldToEventLoop();

        if (dispatchBudget <= 0) {
          skippedForBudget++;
          continue;
        }
        const outcome = await processItem(
          item,
          verifier,
          followupFiler,
          deployShaByProject[item.project] ?? null,
          options.concurrency,
        );
        if (outcome) {
          processed.push(outcome);
          dispatchBudget--;
        }
      }
    }
  }

  const readiness: Record<string, GateReadiness> = {};
  for (const [key, { project, milestone }] of projectMilestones) {
    readiness[key] = getGateReadiness(project, milestone);
  }

  return {
    deployShaByProject,
    reconciled,
    processed,
    readiness,
    skippedForBudget,
  };
}

let configuredVerificationOptions: GateReconcilerOptions | null = null;

/**
 * Wires the verifier + followupFiler + concurrency config for gate
 * verification, read back by the manual-dispatch surface (via
 * getGateVerificationOptions) to invoke verification on operator-selected
 * items. The same config is passed to `register()` below to also drive the
 * scheduled tick's auto-run, gated per-milestone by the (milestone,
 * 'gate-verify') arm — see the tick's auto-run loop above.
 */
export function configureGateVerification(
  options: GateReconcilerOptions,
): void {
  configuredVerificationOptions = options;
}

/** The manual-dispatch surface's accessor for the wired verification config. */
export function getGateVerificationOptions(): GateReconcilerOptions | null {
  return configuredVerificationOptions;
}

export interface GateManualDispatchResult {
  /** Item ids a verification session was just started for. */
  dispatched: string[];
  /** Item ids not dispatched this call, with why. */
  skipped: { itemId: string; reason: string }[];
}

/**
 * The manual-dispatch surface's entry point (M12): operator-triggered
 * verify-item/verify-batch. Starts each item's verification via the wired
 * verifier (configureGateVerification) and returns immediately — a single
 * verify can run for the verifier's full budget (SessionGateItemVerifier
 * defaults to 20 minutes), so this never awaits completion. The dashboard
 * reflects the resulting disposition by re-polling the item afterward (its
 * event log gets the same appendGateItemEvent write processItem always
 * makes, indistinguishable from the reconciler's own tiered auto-run).
 */
export function dispatchGateItemVerification(
  itemIds: string[],
): GateManualDispatchResult {
  const configured = configuredVerificationOptions;
  if (!configured?.verifier) {
    throw new Error('no gate verifier configured');
  }
  const verifier = configured.verifier;
  const followupFiler = configured.followupFiler ?? defaultFollowupFiler;
  const trigger =
    configured.deployAdvanceTrigger ?? defaultDeployAdvanceTrigger;
  const concurrency = configured.concurrency;

  const dispatched: string[] = [];
  const skipped: { itemId: string; reason: string }[] = [];

  for (const itemId of itemIds) {
    const item = gateStore.getItem(itemId);
    if (!item) {
      skipped.push({ itemId, reason: 'not found' });
      continue;
    }
    if (!tryReserveInFlight(itemId)) {
      skipped.push({ itemId, reason: 'already in flight' });
      continue;
    }
    dispatched.push(itemId);
    void (async () => {
      const deploySha = await trigger.latestDeploySha(item.project);
      await runReservedVerification(
        item,
        verifier,
        followupFiler,
        deploySha,
        concurrency,
      );
    })().catch((err) => {
      logger.error(
        `[GateReconciler] manual dispatch failed for gate item ${itemId}: ${err instanceof Error ? err.message : err}`,
      );
    });
  }

  return { dispatched, skipped };
}

/**
 * Registers the reconciler with the Scheduler. Runnability/readiness always
 * run; auto-run verification runs only when `options.verifier` is passed
 * (see runGateReconcilerTick), further gated per-milestone by the
 * (milestone, 'gate-verify') arm on top of the global
 * gate_verification_enabled master switch checked below.
 */
export function register(
  scheduler: Scheduler,
  options: GateReconcilerOptions = {},
): void {
  scheduler.register({
    name: GATE_VERIFICATION_RECONCILER_JOB,
    intervalMs: () => runtimeSettings.gate_verification_interval_ms,
    concurrency: 'skip-if-running',
    enabled: () => runtimeSettings.gate_verification_enabled,
    run: async () => {
      const result = await runGateReconcilerTick(options);
      // A negative items_processed is this job's convention for "found
      // runnable work but dispatched none of it for want of budget" — kept
      // distinct in scheduler_audit from a genuinely idle tick
      // (items_processed: 0, no runnable items at all). See
      // GateReconcileTickResult.skippedForBudget.
      const items_processed =
        result.processed.length > 0
          ? result.processed.length
          : result.skippedForBudget > 0
            ? -result.skippedForBudget
            : 0;
      return { items_processed };
    },
  });
}
