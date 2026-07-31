import { logger } from '../logger';
import type { Scheduler } from '../orchestration/Scheduler';
import { getAllProjects, getProjectById, runtimeSettings } from '../config';
import { getTaskBackend } from '../tasks/TaskBackend';
import { getProjectDeployedSha } from '../deploy/deployService';
import {
  getArm,
  getGateItemsWithPendingCapabilityRequest,
  hasLiveVerifySessionForGateItem,
} from '../db/queries';
import * as gateStore from './gateStore';
import type { GateItem } from './gateStore';
import { catchUpMergeCommits } from './gateMergeConsumer';
import {
  getGateReadiness,
  reconcileGateRunnability,
  nextRunnableGateItems,
  appendGateItemEvent,
  createLocalGitAncestrySource,
  isFollowupTaskDone,
  proposeGateItemReclassification,
  type GateReadiness,
  type ReconcileGateRunnabilityResult,
  type DeployAncestrySource,
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
   */
  disposition: 'pass' | 'fail' | 'needs-setup';
  evidence?: unknown;
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

const FOLLOWUP_TASK_TYPE = '💻 Code';

const defaultFollowupFiler: FollowupFixTaskFiler = {
  async fileFollowupFixTask(item) {
    const project = getAllProjects().find((p) => p.id === item.project);
    const databaseId =
      project?.boards?.find(
        (b) => b.id === item.milestone || b.name === item.milestone,
      )?.sourceId ?? project?.boardId;
    if (!project || !databaseId) {
      throw new Error(
        `[GateReconciler] cannot file follow-up task for gate item ${item.id} — no databaseId resolved for project=${item.project} milestone=${item.milestone}`,
      );
    }
    const backend = getTaskBackend(project.id);
    if (!backend.createTask) {
      throw new Error(
        `[GateReconciler] task backend for project ${project.id} does not support createTask`,
      );
    }
    const title = `Fix gate item: ${item.text}`;
    const taskId = await backend.createTask({
      databaseId,
      title,
      type: FOLLOWUP_TASK_TYPE,
    });
    return { taskId, taskTitle: title };
  },
};

/**
 * Classifications the reconciler auto-runs, one tier at a time. Read-Only
 * and Opportunistic auto-dispose on pass (gateService resolves it straight
 * to 'pass'); Prod-Mutating is run the same way but never mutates — its
 * verifier only gathers read-only evidence, and gateService routes a pass to
 * 'pending-approval' (held until an operator calls approveGateItem) rather
 * than resolving it. needs-triage is excluded: it requires human
 * classification before it can be routed at all. Human-Observation is
 * excluded too, but for a different reason: it is not merely unrouted, it
 * is unverifiable by any headless session (UI/visual/interactive behavior
 * can only be judged by a human observing the running app) so it never
 * enters the tick's auto-run loop. It can still be manually dispatched (the
 * operator-triggered verify surface, dispatchGateItemVerification) to
 * gather advisory pre-check evidence, but gateService.appendGateItemEvent
 * refuses to let a verifier-originated pass resolve it regardless of how it
 * was dispatched.
 */
const AUTO_RUN_TIERS: GateItemClassification[] = [
  'Read-Only',
  'Opportunistic',
  'Prod-Mutating',
];

const DEFAULT_TIER_LIMIT = 10;

/** Bounded escalation thresholds for the auto-run safety envelope. */
const DEFAULT_MAX_DISPATCH_ATTEMPTS = 3;
const DEFAULT_MAX_FIX_ATTEMPTS = 3;

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
  ancestrySourceForProject?: (project: string) => DeployAncestrySource;
  concurrency?: GateVerificationConcurrencyConfig;
}

interface ProcessedGateItem {
  itemId: string;
  classification: GateItemClassification;
  disposition: 'pass' | 'fail' | 'needs-setup';
  /** Set when this run applied a verifier-proposed self-correction — `classification` above already reflects it. */
  reclassifiedTo?: GateItemClassification;
}

export interface GateReconcileTickResult {
  deployShaByProject: Record<string, string | null>;
  reconciled: ReconcileGateRunnabilityResult | null;
  processed: ProcessedGateItem[];
  /** Keyed by `${project}::${milestone}`, not milestone alone — see projectMilestones above. */
  readiness: Record<string, GateReadiness>;
}

function defaultAncestrySourceForProject(
  project: string,
): DeployAncestrySource {
  let projectDir: string | undefined;
  try {
    projectDir = getProjectById(project)?.projectDir;
  } catch {
    projectDir = undefined;
  }
  return createLocalGitAncestrySource(projectDir);
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
 *    operator='gate-verifier'; needs-setup is the non-terminal abstain).
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
async function routeVerificationResult(
  item: GateItem,
  result: GateVerificationResult,
  followupFiler: FollowupFixTaskFiler,
  deploySha: string | null,
  concurrency: GateVerificationConcurrencyConfig = {},
  /** true = unattended (reconciler auto-launch / boot reattachment); false = operator-triggered manual dispatch (dispatchGateItemVerification) — recorded on every event this run appends. */
  unattended = false,
): Promise<ProcessedGateItem> {
  const maxFixAttempts = concurrency.maxFixAttempts ?? DEFAULT_MAX_FIX_ATTEMPTS;

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
  if (result.disposition === 'needs-setup') {
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
  } else {
    // pass — auto-pass is provenance-tagged, never anonymous.
    appendGateItemEvent(item.id, {
      disposition: result.disposition,
      evidence: result.evidence,
      deploySha: deploySha ?? undefined,
      operator: 'gate-verifier',
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

  const allItems = gateStore.listAll();
  const projects = new Set(allItems.map((item) => item.project));
  const deployShaByProject: Record<string, string | null> = {};
  let reconciled: ReconcileGateRunnabilityResult | null = null;

  for (const project of projects) {
    const sha = await trigger.latestDeploySha(project);
    deployShaByProject[project] = sha;
    if (!sha) continue;
    const result = reconcileGateRunnability(sha, {
      project,
      ancestrySource: ancestrySourceForProject(project),
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

  if (!options.verifier) {
    if (projectMilestones.size > 0) {
      logger.warn(
        '[GateReconciler] no verifier wired — skipping auto-run for this tick',
      );
    }
  } else {
    const verifier = options.verifier;
    for (const { project, milestone } of projectMilestones.values()) {
      if (!getArm(milestone, 'gate-verify')) continue;
      for (const classification of AUTO_RUN_TIERS) {
        const batch = nextRunnableGateItems(project, milestone, {
          classification,
          limit,
        });
        for (const item of batch) {
          const outcome = await processItem(
            item,
            verifier,
            followupFiler,
            deployShaByProject[item.project] ?? null,
            options.concurrency,
          );
          if (outcome) processed.push(outcome);
        }
      }
    }
  }

  const readiness: Record<string, GateReadiness> = {};
  for (const [key, { project, milestone }] of projectMilestones) {
    readiness[key] = getGateReadiness(project, milestone);
  }

  return { deployShaByProject, reconciled, processed, readiness };
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
    name: 'gate_verification_reconciler',
    intervalMs: () => runtimeSettings.gate_verification_interval_ms,
    concurrency: 'skip-if-running',
    enabled: () => runtimeSettings.gate_verification_enabled,
    run: async () => {
      const result = await runGateReconcilerTick(options);
      return { items_processed: result.processed.length };
    },
  });
}
