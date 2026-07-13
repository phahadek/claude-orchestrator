import { execFileSync } from 'child_process';
import * as gateStore from './gateStore';
import type { GateItem } from './gateStore';
import type { GateItemClassification } from '../db/types';

/**
 * Recomputes whether a deploy contains a given commit. This is the git-ancestry
 * half of "the live deploy-SHA source + git-ancestry is a PLACEHOLDER" — the
 * real per-project source and deploy-advance trigger land with the
 * deploy-integration design (39b22f91-52f3-81bc). Swappable via the
 * `ancestrySource` option on reconcileGateRunnability.
 */
export interface DeployAncestrySource {
  /** True when `ancestorSha` is `descendantSha` or one of its git ancestors. */
  isAncestor(ancestorSha: string, descendantSha: string): boolean;
}

/** The default git-ancestry deploy-integration surface, reused by seedService's applyability check. */
export const gitAncestrySource: DeployAncestrySource = {
  isAncestor(ancestorSha, descendantSha) {
    if (ancestorSha === descendantSha) return true;
    try {
      execFileSync(
        'git',
        ['merge-base', '--is-ancestor', ancestorSha, descendantSha],
        { stdio: 'ignore' },
      );
      return true;
    } catch {
      return false;
    }
  },
};

/** Terminal states: the item no longer blocks milestone completion. */
const RESOLVED_STATES = new Set(['pass', 'deferred']);

interface GateBlockingItem {
  id: string;
  project: string;
  milestone: string;
  text: string;
  classification: GateItemClassification;
  state: string;
}

export interface GateReadiness {
  status: 'green' | 'blocked';
  blocking: GateBlockingItem[];
}

/** Headline output: green once every item in the milestone is pass/deferred. */
export function getGateReadiness(milestone: string): GateReadiness {
  const items = gateStore.listByMilestoneAllProjects(milestone);
  const blocking = items
    .filter((item) => !RESOLVED_STATES.has(item.state))
    .map((item) => ({
      id: item.id,
      project: item.project,
      milestone: item.milestone,
      text: item.text,
      classification: item.classification,
      state: item.state,
    }));
  return { status: blocking.length === 0 ? 'green' : 'blocked', blocking };
}

export interface ReconcileGateRunnabilityResult {
  markedRunnable: string[];
  reopened: string[];
}

export interface ReconcileOptions {
  ancestrySource?: DeployAncestrySource;
}

/**
 * Recomputes runnability against `deploySha` (injected — see DeployAncestrySource
 * above for the swappable half). An item becomes runnable once deploySha
 * contains its min_deployed_commit; a prior pass is re-opened if a later-commit
 * source has since moved min_deployed_commit past what was deployed when it passed.
 */
export function reconcileGateRunnability(
  deploySha: string,
  options: ReconcileOptions = {},
): ReconcileGateRunnabilityResult {
  const ancestry = options.ancestrySource ?? gitAncestrySource;
  const now = new Date().toISOString();
  const markedRunnable: string[] = [];
  const reopened: string[] = [];

  for (const item of gateStore.listAll()) {
    if (!item.minDeployedCommit) continue;
    const covered = ancestry.isAncestor(item.minDeployedCommit, deploySha);

    if (item.state === 'pass') {
      const lastPass = [...item.events]
        .reverse()
        .find((e) => e.disposition === 'pass');
      const stillValid =
        lastPass?.deploySha !== undefined &&
        ancestry.isAncestor(item.minDeployedCommit, lastPass.deploySha);
      if (!stillValid) {
        const nextState = covered ? 'runnable' : 'open';
        gateStore.advanceState(item.id, nextState, undefined, now);
        reopened.push(item.id);
        if (nextState === 'runnable') markedRunnable.push(item.id);
      }
      continue;
    }

    if (item.state === 'open' && covered) {
      gateStore.advanceState(item.id, 'runnable', item.currentDisposition, now);
      markedRunnable.push(item.id);
      continue;
    }

    if (item.state === 'runnable' && !covered) {
      gateStore.advanceState(item.id, 'open', item.currentDisposition, now);
    }
  }

  return { markedRunnable, reopened };
}

const DEFAULT_BATCH_LIMIT = 10;

/**
 * Tier pull order when no classification is requested: untriaged items first
 * (so they get classified), then increasing blast radius.
 */
const TIER_ORDER: GateItemClassification[] = [
  'needs-triage',
  'Read-Only',
  'Opportunistic',
  'Prod-Mutating',
];

export interface NextRunnableGateItemsOptions {
  classification?: GateItemClassification;
  limit?: number;
}

/** Pulls one tier's worth of runnable items at a time — never the full runnable set. */
export function nextRunnableGateItems(
  milestone: string,
  options: NextRunnableGateItemsOptions = {},
): GateItem[] {
  const limit = options.limit ?? DEFAULT_BATCH_LIMIT;
  const runnable = gateStore
    .listByMilestoneAllProjects(milestone)
    .filter((item) => item.state === 'runnable');

  const tier =
    options.classification ??
    TIER_ORDER.find((t) => runnable.some((item) => item.classification === t));
  if (!tier) return [];

  return runnable
    .filter((item) => item.classification === tier)
    .slice(0, limit);
}

export function getGateItem(id: string): GateItem | undefined {
  return gateStore.getItem(id);
}

/** The item's full detail: its denormalized fields plus its sources and event history, by value. */
export function getGateItemDetail(
  id: string,
): gateStore.GateItemDetail | undefined {
  return gateStore.getItemDetail(id);
}

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

export interface ListGateItemsOptions {
  project?: string;
  milestone?: string;
  state?: string;
  classification?: GateItemClassification;
  runnable?: boolean;
  page?: number;
  limit?: number;
}

export interface ListGateItemsResult {
  items: GateItem[];
  total: number;
  page: number;
}

/** Paginated, filtered read over gate items — never an unbounded load. */
export function listGateItems(
  options: ListGateItemsOptions = {},
): ListGateItemsResult {
  const page =
    options.page !== undefined && options.page > 0
      ? Math.floor(options.page)
      : 1;
  const limit = Math.min(
    options.limit !== undefined && options.limit > 0
      ? Math.floor(options.limit)
      : DEFAULT_LIST_LIMIT,
    MAX_LIST_LIMIT,
  );
  const offset = (page - 1) * limit;
  const { items, total } = gateStore.listFiltered(
    {
      project: options.project,
      milestone: options.milestone,
      state: options.state,
      classification: options.classification,
      runnable: options.runnable,
    },
    limit,
    offset,
  );
  return { items, total, page };
}

export interface MilestoneReadiness {
  project: string;
  milestone: string;
  status: 'green' | 'blocked';
  blockingCount: number;
}

export interface ListMilestoneReadinessOptions {
  project?: string;
}

interface MilestoneGroup {
  project: string;
  milestone: string;
  items: GateItem[];
}

/** The multi-milestone / multi-project readiness rollup: completion-gating's and the overview's input. */
export function listMilestoneReadiness(
  options: ListMilestoneReadinessOptions = {},
): MilestoneReadiness[] {
  const items = options.project
    ? gateStore.listByProject(options.project)
    : gateStore.listAll();

  const groups = new Map<string, MilestoneGroup>();
  for (const item of items) {
    const key = JSON.stringify([item.project, item.milestone]);
    const group = groups.get(key);
    if (group) {
      group.items.push(item);
    } else {
      groups.set(key, {
        project: item.project,
        milestone: item.milestone,
        items: [item],
      });
    }
  }

  return Array.from(groups.values())
    .map((group) => {
      const blockingCount = group.items.filter(
        (item) => !RESOLVED_STATES.has(item.state),
      ).length;
      const status: 'green' | 'blocked' =
        blockingCount === 0 ? 'green' : 'blocked';
      return {
        project: group.project,
        milestone: group.milestone,
        status,
        blockingCount,
      };
    })
    .sort(
      (a, b) =>
        a.project.localeCompare(b.project) ||
        a.milestone.localeCompare(b.milestone),
    );
}

export interface AppendGateItemEventInput {
  disposition: string;
  evidence?: unknown;
  filedFollowon?: string;
  deploySha?: string;
  operator?: string;
}

/** Prod-Mutating passes stop short of resolving — they wait for approveGateItem. */
function nextStateForDisposition(
  disposition: string,
  classification: GateItemClassification,
): string {
  if (disposition === 'pass' && classification === 'Prod-Mutating') {
    return 'pending-approval';
  }
  return disposition;
}

/** Appends an event and advances the item's denormalized (state, current_disposition). */
export function appendGateItemEvent(
  gateItemId: string,
  event: AppendGateItemEventInput,
): GateItem {
  const item = gateStore.getItem(gateItemId);
  if (!item) {
    throw new Error(`gate_item: no item ${gateItemId}`);
  }
  const now = new Date().toISOString();
  gateStore.appendEvent(gateItemId, { ...event, at: now });
  const nextState = nextStateForDisposition(
    event.disposition,
    item.classification,
  );
  gateStore.advanceState(gateItemId, nextState, event.disposition, now);

  const updated = gateStore.getItem(gateItemId);
  if (!updated) {
    throw new Error(
      `gate_item: failed to read back item ${gateItemId} after event`,
    );
  }
  return updated;
}

/** The Prod-Mutating consent gate: releases an item held at pending-approval to pass. */
export function approveGateItem(
  gateItemId: string,
  operator?: string,
): GateItem {
  const item = gateStore.getItem(gateItemId);
  if (!item) {
    throw new Error(`gate_item: no item ${gateItemId}`);
  }
  if (item.classification !== 'Prod-Mutating') {
    throw new Error(
      `gate_item ${gateItemId}: approval only applies to Prod-Mutating items (classification=${item.classification})`,
    );
  }
  if (item.state !== 'pending-approval') {
    throw new Error(
      `gate_item ${gateItemId}: not pending approval (state=${item.state})`,
    );
  }
  const now = new Date().toISOString();
  gateStore.appendEvent(gateItemId, {
    disposition: 'approved',
    operator,
    at: now,
  });
  gateStore.advanceState(gateItemId, 'pass', 'pass', now);

  const updated = gateStore.getItem(gateItemId);
  if (!updated) {
    throw new Error(
      `gate_item: failed to read back item ${gateItemId} after approval`,
    );
  }
  return updated;
}
