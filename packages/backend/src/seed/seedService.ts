import * as seedStore from './seedStore';
import type { SeedItem } from './seedStore';
import {
  gitAncestrySource,
  type DeployAncestrySource,
} from '../gate/gateService';
import type { SeedItemEventOutcome } from '../db/types';

/** Terminal state: the item no longer blocks milestone completion. */
const RESOLVED_STATE = 'confirmed';

export interface SeedBlockingItem {
  id: string;
  project: string;
  milestone: string;
  spec: string;
  state: string;
}

export interface SeedReadiness {
  status: 'green' | 'blocked';
  blocking: SeedBlockingItem[];
}

/**
 * Headline output: green once every seed_item in the milestone is confirmed.
 * The orchestrator's milestone-completion predicate is a thin AND of this
 * and getGateReadiness(m) — surfaced here for display, not composed here.
 */
export function getSeedReadiness(milestone: string): SeedReadiness {
  const items = seedStore.listByMilestoneAllProjects(milestone);
  const blocking = items
    .filter((item) => item.state !== RESOLVED_STATE)
    .map((item) => ({
      id: item.id,
      project: item.project,
      milestone: item.milestone,
      spec: item.spec,
      state: item.state,
    }));
  return { status: blocking.length === 0 ? 'green' : 'blocked', blocking };
}

const DEFAULT_APPLYABLE_LIMIT = 1;
const MAX_APPLYABLE_LIMIT = 10;

export interface NextApplyableSeedItemsOptions {
  limit?: number;
  ancestrySource?: DeployAncestrySource;
}

/**
 * Applyability: deploy-included (deploySha contains min_deployed_commit,
 * reusing the gate's deploy-integration surfaces) and not yet confirmed.
 * Surfaces one bounded batch at a time — never the full applyable set,
 * since the orchestrator cannot write another project's config and only
 * hands these to an operator (or, later, an apply session) one at a time.
 */
export function nextApplyableSeedItems(
  milestone: string,
  deploySha: string,
  options: NextApplyableSeedItemsOptions = {},
): SeedItem[] {
  const ancestry = options.ancestrySource ?? gitAncestrySource;
  const limit = Math.min(
    options.limit !== undefined && options.limit > 0
      ? Math.floor(options.limit)
      : DEFAULT_APPLYABLE_LIMIT,
    MAX_APPLYABLE_LIMIT,
  );

  const applyable = seedStore
    .listByMilestoneAllProjects(milestone)
    .filter(
      (item) =>
        item.state !== RESOLVED_STATE &&
        item.minDeployedCommit !== undefined &&
        ancestry.isAncestor(item.minDeployedCommit, deploySha),
    );

  return applyable.slice(0, limit);
}

export function getSeedItem(id: string): SeedItem | undefined {
  return seedStore.getItem(id);
}

export interface AppendSeedItemEventInput {
  outcome: SeedItemEventOutcome;
  evidence?: unknown;
  filedFollowon?: string;
  operator?: string;
}

/**
 * Records an operator's outcome for a seed item and advances its single
 * state field to match. There is deliberately no apply-side-effect path
 * here — the orchestrator cannot write another project's config, so this
 * only surfaces applyable seeds and records what an operator observed.
 */
export function appendSeedItemEvent(
  seedItemId: string,
  event: AppendSeedItemEventInput,
): SeedItem {
  const item = seedStore.getItem(seedItemId);
  if (!item) {
    throw new Error(`seed_item: no item ${seedItemId}`);
  }
  if (event.outcome === 'blocked' && !event.filedFollowon) {
    throw new Error(
      `seed_item ${seedItemId}: a blocked outcome must carry a filedFollowon`,
    );
  }
  const now = new Date().toISOString();
  seedStore.appendEvent(seedItemId, { ...event, at: now });
  seedStore.advanceState(seedItemId, event.outcome, now);

  const updated = seedStore.getItem(seedItemId);
  if (!updated) {
    throw new Error(
      `seed_item: failed to read back item ${seedItemId} after event`,
    );
  }
  return updated;
}
