import { logger } from '../logger';
import type { Scheduler } from '../orchestration/Scheduler';
import { getAllProjects, runtimeSettings } from '../config';
import { getTaskBackend } from '../tasks/TaskBackend';
import * as gateStore from './gateStore';
import type { GateItem } from './gateStore';
import {
  getGateReadiness,
  reconcileGateRunnability,
  nextRunnableGateItems,
  appendGateItemEvent,
  type GateReadiness,
  type ReconcileGateRunnabilityResult,
} from './gateService';
import type { GateItemClassification } from '../db/types';

/**
 * The live deploy-SHA source is a PLACEHOLDER — swappable when the
 * deploy-integration design lands (39b22f91-52f3-81bc). Until then, inject
 * a project-specific implementation; the default never advances.
 */
export interface DeployAdvanceTrigger {
  /** The deploy SHA to reconcile against this tick, or null if nothing has advanced since the last tick. */
  latestDeploySha(): string | null | Promise<string | null>;
}

const noopDeployAdvanceTrigger: DeployAdvanceTrigger = {
  latestDeploySha() {
    return null;
  },
};

export interface GateVerificationResult {
  disposition: 'pass' | 'fail';
  evidence?: unknown;
}

/**
 * The auto-run mechanism for a gate item — "verified-by-mechanism" in the
 * classification model. No concrete mechanism is wired by default; tiers
 * are skipped (with a warning) until a verifier is injected.
 */
export interface GateItemVerifier {
  verify(item: GateItem): Promise<GateVerificationResult>;
}

export interface FollowupFixTask {
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
 * auto-disposes on pass (gateService resolves it straight to 'pass');
 * Prod-Mutating is run the same way but gateService routes its pass to
 * 'pending-approval' — held until an operator calls approveGateItem.
 * Opportunistic and needs-triage are excluded: on-demand / requires human
 * triage before they can be routed at all.
 */
const AUTO_RUN_TIERS: GateItemClassification[] = ['Read-Only', 'Prod-Mutating'];

const DEFAULT_TIER_LIMIT = 10;

export interface GateReconcilerOptions {
  deployAdvanceTrigger?: DeployAdvanceTrigger;
  verifier?: GateItemVerifier;
  followupFiler?: FollowupFixTaskFiler;
  tierLimit?: number;
}

export interface ProcessedGateItem {
  itemId: string;
  classification: GateItemClassification;
  disposition: 'pass' | 'fail';
}

export interface GateReconcileTickResult {
  deploySha: string | null;
  reconciled: ReconcileGateRunnabilityResult | null;
  processed: ProcessedGateItem[];
  readiness: Record<string, GateReadiness>;
}

/** Appends the verifier's outcome and, on failure, files + attaches a follow-up fix task and re-opens the item. */
async function processItem(
  item: GateItem,
  verifier: GateItemVerifier,
  followupFiler: FollowupFixTaskFiler,
  deploySha: string | null,
): Promise<ProcessedGateItem> {
  const result = await verifier.verify(item);

  if (result.disposition === 'fail') {
    const followup = await followupFiler.fileFollowupFixTask(item, result);
    appendGateItemEvent(item.id, {
      disposition: 'fail',
      evidence: result.evidence,
      filedFollowon: followup.taskId,
      deploySha: deploySha ?? undefined,
    });
    const now = new Date().toISOString();
    gateStore.addSource(
      item.id,
      { sourceTaskId: followup.taskId, sourceTaskTitle: followup.taskTitle },
      now,
    );
    gateStore.advanceState(item.id, 'open', 'fail', now);
  } else {
    appendGateItemEvent(item.id, {
      disposition: result.disposition,
      evidence: result.evidence,
      deploySha: deploySha ?? undefined,
    });
  }

  return {
    itemId: item.id,
    classification: item.classification,
    disposition: result.disposition,
  };
}

/**
 * One reconcile tick: recomputes runnability against the injected deploy
 * SHA (if any advance is reported), pulls one classification tier at a time
 * per milestone (never a bulk load), routes execution, and rolls per-
 * milestone readiness into the completion signal.
 */
export async function runGateReconcilerTick(
  options: GateReconcilerOptions = {},
): Promise<GateReconcileTickResult> {
  const trigger = options.deployAdvanceTrigger ?? noopDeployAdvanceTrigger;
  const limit = options.tierLimit ?? DEFAULT_TIER_LIMIT;
  const followupFiler = options.followupFiler ?? defaultFollowupFiler;

  const deploySha = await trigger.latestDeploySha();
  const reconciled = deploySha ? reconcileGateRunnability(deploySha) : null;

  const milestones = new Set(gateStore.listAll().map((item) => item.milestone));
  const processed: ProcessedGateItem[] = [];

  if (!options.verifier) {
    if (milestones.size > 0) {
      logger.warn(
        '[GateReconciler] no verifier wired — skipping auto-run for this tick',
      );
    }
  } else {
    const verifier = options.verifier;
    for (const milestone of milestones) {
      for (const classification of AUTO_RUN_TIERS) {
        const batch = nextRunnableGateItems(milestone, {
          classification,
          limit,
        });
        for (const item of batch) {
          processed.push(
            await processItem(item, verifier, followupFiler, deploySha),
          );
        }
      }
    }
  }

  const readiness: Record<string, GateReadiness> = {};
  for (const milestone of milestones) {
    readiness[milestone] = getGateReadiness(milestone);
  }

  return { deploySha, reconciled, processed, readiness };
}

/** Registers the reconciler with the Scheduler. Built, not activated — gated off by runtimeSettings.gate_verification_enabled. */
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
