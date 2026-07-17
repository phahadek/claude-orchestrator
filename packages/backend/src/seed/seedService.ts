import * as seedStore from './seedStore';
import type { SeedItem } from './seedStore';
import {
  gitAncestrySource,
  type DeployAncestrySource,
} from '../gate/gateService';
import type { SeedItemEventOutcome } from '../db/types';
import { getTaskBackend } from '../tasks/TaskBackend';
import { getTaskCache } from '../db/queries';
import {
  backfillConfigSeedTask,
  type BackfillConfigSeedResult,
  type TaskCandidate,
} from './seedBackfill';

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

/** The item's full detail: its denormalized fields plus its sources and event history, by value. */
export function getSeedItemDetail(
  id: string,
): seedStore.SeedItemDetail | undefined {
  return seedStore.getItemDetail(id);
}

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

export interface ListSeedItemsOptions {
  project?: string;
  milestone?: string;
  state?: string;
  page?: number;
  limit?: number;
}

export interface ListSeedItemsResult {
  items: SeedItem[];
  total: number;
  page: number;
}

/** Paginated, filtered read over seed items — never an unbounded load. */
export function listSeedItems(
  options: ListSeedItemsOptions = {},
): ListSeedItemsResult {
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
  const { items, total } = seedStore.listFiltered(
    {
      project: options.project,
      milestone: options.milestone,
      state: options.state,
    },
    limit,
    offset,
  );
  return { items, total, page };
}

export interface SeedMilestoneReadiness {
  project: string;
  milestone: string;
  status: 'green' | 'blocked';
  blockingCount: number;
}

export interface ListSeedMilestoneReadinessOptions {
  project?: string;
}

interface SeedMilestoneGroup {
  project: string;
  milestone: string;
  items: SeedItem[];
}

/** The multi-milestone / multi-project seed readiness rollup: the dashboard's join input alongside listMilestoneReadiness (gate). */
export function listSeedMilestoneReadiness(
  options: ListSeedMilestoneReadinessOptions = {},
): SeedMilestoneReadiness[] {
  const items = options.project
    ? seedStore.listByProject(options.project)
    : seedStore.listAll();

  const groups = new Map<string, SeedMilestoneGroup>();
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
        (item) => item.state !== RESOLVED_STATE,
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

/** A raw Notion-style status string counts as not-started when it hasn't left Backlog/Ready. */
function isNotStartedStatus(notionStatus: string): boolean {
  if (!notionStatus) return true;
  return notionStatus.includes('Backlog') || notionStatus.includes('Ready');
}

export interface BackfillSeedTaskInput {
  project: string;
  taskId: string;
  milestone: string;
  candidates?: TaskCandidate[];
}

/**
 * The seed/seedBackfill.ts library's only invoker: fetches a config-seed
 * task's live body and hands it to backfillConfigSeedTask. Only runs
 * against a not-yet-started task — a started config-seed has run-history
 * the backfill's lossless-parse contract doesn't account for.
 */
export async function backfillSeedTask(
  input: BackfillSeedTaskInput,
): Promise<BackfillConfigSeedResult> {
  const backend = getTaskBackend(input.project);
  let taskBody: string;
  try {
    taskBody = await backend.fetchTaskPage(input.taskId);
  } catch (err) {
    throw new Error(
      `seed backfill: task ${input.taskId} not found (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const cacheRow = getTaskCache(input.taskId);
  let notionStatus = '';
  if (cacheRow) {
    try {
      const parsed = JSON.parse(cacheRow.raw_json) as { status?: string };
      notionStatus = parsed.status ?? '';
    } catch {
      // ignore malformed cache; treated as not-started below
    }
  }
  if (!isNotStartedStatus(notionStatus)) {
    throw new Error(
      `seed backfill: task ${input.taskId} already started (status=${notionStatus})`,
    );
  }

  return backfillConfigSeedTask({
    project: input.project,
    milestone: input.milestone,
    taskBody,
    candidates: input.candidates,
    now: new Date().toISOString(),
  });
}
