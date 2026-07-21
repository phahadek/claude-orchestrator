import { execFileSync } from 'child_process';
import * as gateStore from './gateStore';
import type { GateItem } from './gateStore';
import type { GateItemClassification } from '../db/types';
import { getTaskBackend } from '../tasks/TaskBackend';
import { getTaskCache } from '../db/queries';
import type { GateItemListOrder } from '../db/queries';
import { backfillGateBody, type GateBackfillResult } from './gateBackfill';

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
export const gitAncestrySource: DeployAncestrySource =
  createLocalGitAncestrySource();

/**
 * A git-ancestry source scoped to a specific local clone (a project's
 * `projectDir`), rather than assuming the current process cwd is the right
 * repo — the gate reconciler runs against multiple projects' local clones.
 */
export function createLocalGitAncestrySource(
  cwd?: string,
): DeployAncestrySource {
  return {
    isAncestor(ancestorSha, descendantSha) {
      if (ancestorSha === descendantSha) return true;
      try {
        execFileSync(
          'git',
          ['merge-base', '--is-ancestor', ancestorSha, descendantSha],
          { cwd, stdio: 'ignore' },
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * The closed disposition vocabulary an event may carry. Anything outside this
 * set is rejected at the API boundary (POST /gate/items/:id/event) rather
 * than written straight into state — an invented or typo'd disposition used
 * to become a bespoke state that never resolves and blocks the milestone
 * rollup forever (see f64029ac). `noted` is the sanctioned non-terminal
 * disposition: it records an event but leaves state unchanged, for the
 * "attempted, not yet resolved" case that previously tempted an invented
 * value. `discarded` is the sanctioned void disposition: terminal and
 * non-blocking, for mis-accreted/erroneous items — distinct from `deferred`,
 * which means punted-to-next-milestone, not void. `needs-setup` is the
 * verifier's bounded best-effort abstain (see GateVerificationResult in
 * gateReconciler.ts): it records a verification attempt without resolving
 * it, the same non-terminal shape as `noted` — the item stays runnable, but
 * nextRunnableGateItems skips it until a later event (reclassify/reopen/a
 * new fail) supersedes it as the item's latest.
 */
const GATE_DISPOSITIONS = [
  'pass',
  'fail',
  'deferred',
  'discarded',
  'noted',
  'needs-setup',
] as const;

type GateDisposition = (typeof GATE_DISPOSITIONS)[number];

/** Dispositions that record an event without advancing state. */
const NON_TERMINAL_DISPOSITIONS = new Set<GateDisposition>([
  'noted',
  'needs-setup',
]);

function isValidGateDisposition(value: string): value is GateDisposition {
  return (GATE_DISPOSITIONS as readonly string[]).includes(value);
}

/** The closed state-machine vocabulary. Anything else is a bespoke state. */
const GATE_STATES = new Set([
  'open',
  'runnable',
  'pass',
  'fail',
  'deferred',
  'pending-approval',
  'discarded',
]);

/** True for a state outside the closed vocabulary — an invented/typo'd value that slipped in before this was enforced. */
function isBespokeGateState(state: string): boolean {
  return !GATE_STATES.has(state);
}

/** Terminal states: the item no longer blocks milestone completion. */
const RESOLVED_STATES = new Set(['pass', 'deferred', 'discarded']);

interface GateBlockingItem {
  id: string;
  project: string;
  milestone: string;
  text: string;
  classification: GateItemClassification;
  state: string;
  /** Flagged loudly rather than auto-rewritten — steer it to `discarded` (or its intended disposition) by hand. */
  bespoke?: boolean;
}

export interface GateReadiness {
  status: 'green' | 'blocked';
  blocking: GateBlockingItem[];
  /** Subset of `blocking` sitting in a state outside the closed vocabulary — needs human re-disposition, not indefinite blocking. */
  bespokeStates: GateBlockingItem[];
  /** The milestone's full per-state item totals, independent of any table filter; sums to the milestone's item total. */
  counts: Record<string, number>;
}

/** Headline output: green once every item in the milestone is pass/deferred/discarded. */
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
      bespoke: isBespokeGateState(item.state),
    }));
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.state] = (counts[item.state] ?? 0) + 1;
  }
  return {
    status: blocking.length === 0 ? 'green' : 'blocked',
    blocking,
    bespokeStates: blocking.filter((item) => item.bespoke),
    counts,
  };
}

export interface ReconcileGateRunnabilityResult {
  markedRunnable: string[];
  reopened: string[];
}

export interface ReconcileOptions {
  ancestrySource?: DeployAncestrySource;
  /** Scope reconciliation to one project's items — every deploy SHA is project-specific. */
  project?: string;
}

/**
 * The min_deployed_commit value in effect when the item's most recent `fail`
 * was recorded — stashed in that event's evidence by the reconciler
 * (processItem) at fail time. Distinguishes "already covered before it
 * failed" from "a follow-up source has since merged and pushed
 * min_deployed_commit forward" — the auto-reopen trigger below must only
 * fire on the latter.
 */
function minDeployedCommitAtLastFail(item: GateItem): string | null {
  const lastFail = [...item.events]
    .reverse()
    .find((e) => e.disposition === 'fail');
  if (!lastFail) return null;
  const evidence = lastFail.evidence;
  if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
    const v = (evidence as Record<string, unknown>).minDeployedCommitAtFail;
    if (typeof v === 'string') return v;
  }
  return null;
}

/**
 * Recomputes runnability against `deploySha` (injected — see DeployAncestrySource
 * above for the swappable half). An item becomes runnable once every one of
 * its sources has merged and deploySha contains that source's merge commit —
 * an un-merged source (no merge_commit yet) keeps the item open even if
 * other sources are fully deployed. A pass is terminal for runnability — a
 * redeploy only unblocks previously-blocked items, it never re-opens a pass.
 *
 * A `fail` item is auto-reopened (fail -> open -> runnable, in the same
 * tick) once its min_deployed_commit has genuinely advanced past what it was
 * at fail-time AND the new commit is covered by `deploySha` — i.e. its
 * follow-up fix source has merged and the fix has since deployed. This is
 * distinct from the operator-gated reopenGateItem: no operator involved,
 * gated purely on a fix actually landing.
 */
export function reconcileGateRunnability(
  deploySha: string,
  options: ReconcileOptions = {},
): ReconcileGateRunnabilityResult {
  const ancestry = options.ancestrySource ?? gitAncestrySource;
  const now = new Date().toISOString();
  const markedRunnable: string[] = [];
  const reopened: string[] = [];

  const items = options.project
    ? gateStore.listByProject(options.project)
    : gateStore.listAll();

  for (const item of items) {
    // Covered only once every source has merged AND its merge commit has
    // deployed — a null merge_commit (source not merged yet) or an
    // undeployed merge commit both keep the item open. An item with no
    // sources at all has no code dependency, so it's trivially covered.
    const covered =
      item.sources.length === 0 ||
      item.sources.every(
        (source) =>
          source.mergeCommit &&
          ancestry.isAncestor(source.mergeCommit, deploySha),
      );

    if (item.state === 'pass') {
      // A pass is terminal for runnability — a redeploy never re-opens it.
      continue;
    }

    let state = item.state;

    if (state === 'fail') {
      const failedAtCommit = minDeployedCommitAtLastFail(item);
      const advanced = (item.minDeployedCommit ?? null) !== failedAtCommit;
      if (advanced && covered) {
        gateStore.appendEvent(item.id, {
          disposition: 'reopened',
          operator: 'gate-reconciler',
          evidence: { reason: 'follow-up fix source deployed' },
          at: now,
        });
        gateStore.advanceState(item.id, 'open', 'reopened', now);
        reopened.push(item.id);
        state = 'open';
      }
    }

    if (state === 'open' && covered) {
      gateStore.advanceState(item.id, 'runnable', item.currentDisposition, now);
      markedRunnable.push(item.id);
      continue;
    }

    if (state === 'runnable' && !covered) {
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

/**
 * True once an item's latest event carries the `needs-setup` abstain — the
 * dispatcher skips it until a later event (reclassify/reopen/a new fail)
 * supersedes it as the item's latest, per GateVerificationResult's
 * needs-setup contract.
 */
function isAwaitingSetup(item: GateItem): boolean {
  return item.events.at(-1)?.disposition === 'needs-setup';
}

/** Pulls one tier's worth of runnable items at a time — never the full runnable set. */
export function nextRunnableGateItems(
  milestone: string,
  options: NextRunnableGateItemsOptions = {},
): GateItem[] {
  const limit = options.limit ?? DEFAULT_BATCH_LIMIT;
  const runnable = gateStore
    .listByMilestoneAllProjects(milestone)
    .filter((item) => item.state === 'runnable')
    .filter((item) => !isAwaitingSetup(item));

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
  /** 'not-done-first' surfaces unresolved (non pass/deferred) items ahead of resolved ones — the run-worklist default. */
  order?: GateItemListOrder;
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
    options.order,
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
  /** Omit for a pure log entry — appends with evidence, does not advance state. */
  disposition?: string;
  evidence?: unknown;
  filedFollowon?: string;
  deploySha?: string;
  operator?: string;
}

/** Prod-Mutating passes stop short of resolving — they wait for approveGateItem. */
function nextStateForDisposition(
  disposition: GateDisposition,
  classification: GateItemClassification,
): string {
  if (disposition === 'pass' && classification === 'Prod-Mutating') {
    return 'pending-approval';
  }
  return disposition;
}

/**
 * True when a `pass` event must not advance state: a Human-Observation item
 * (UI/visual/interactive) can only be passed by a human observing the
 * running app — a verifier-originated `pass` (tagged operator:
 * 'gate-verifier', see gateReconciler.ts's runReservedVerification) is
 * advisory evidence only, never a final disposition. A human passing the
 * same item through the /gate skill (any other operator) still resolves it
 * normally.
 */
function isVerifierBlockedFromPassing(
  disposition: GateDisposition,
  classification: GateItemClassification,
  operator: string | undefined,
): boolean {
  return (
    disposition === 'pass' &&
    classification === 'Human-Observation' &&
    operator === 'gate-verifier'
  );
}

/**
 * Appends an event and, when disposition is present and terminal, advances
 * the item's denormalized (state, current_disposition). A dispositionless
 * event, or one carrying the non-terminal `noted` disposition, is a pure log
 * entry — evidence is recorded but state is left unchanged. `discarded`
 * requires an evidence/reason, since it permanently voids the item.
 */
export function appendGateItemEvent(
  gateItemId: string,
  event: AppendGateItemEventInput,
): GateItem {
  const item = gateStore.getItem(gateItemId);
  if (!item) {
    throw new Error(`gate_item: no item ${gateItemId}`);
  }
  if (
    event.disposition !== undefined &&
    !isValidGateDisposition(event.disposition)
  ) {
    throw new Error(
      `gate_item_event: invalid disposition '${event.disposition}' — must be one of ${GATE_DISPOSITIONS.join(', ')}, or omitted for a log-only event`,
    );
  }
  if (event.disposition === 'discarded' && !event.evidence) {
    throw new Error(`gate_item_event: 'discarded' requires an evidence/reason`);
  }
  const now = new Date().toISOString();
  gateStore.appendEvent(gateItemId, { ...event, at: now });

  const advances =
    event.disposition !== undefined &&
    !NON_TERMINAL_DISPOSITIONS.has(event.disposition as GateDisposition) &&
    !isVerifierBlockedFromPassing(
      event.disposition as GateDisposition,
      item.classification,
      event.operator,
    );
  if (advances) {
    const nextState = nextStateForDisposition(
      event.disposition as GateDisposition,
      item.classification,
    );
    gateStore.advanceState(gateItemId, nextState, event.disposition, now);
  }

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

/**
 * States a reopen may be applied from: any resolved/terminal state, including
 * the fail-trap left by a fail dispositioned outside the reconciler's
 * processItem path. `open`/`runnable`/`pending-approval` are already on a
 * sanctioned path back to resolution, so reopening them is a no-op we reject.
 */
const REOPEN_BLOCKED_STATES = new Set(['open', 'runnable', 'pending-approval']);

/**
 * Operator-attributed reopen: pulls a pass/deferred/fail-trapped item back to
 * `open` for re-verification. Moves to `open`, not `runnable` — the scheduled
 * reconcileGateRunnability re-marks it runnable once deploy coverage catches
 * up, and a later pass still routes a Prod-Mutating item through
 * pending-approval, so this cannot bypass re-approval.
 */
export function reopenGateItem(
  gateItemId: string,
  operator?: string,
  reason?: string,
): GateItem {
  const item = gateStore.getItem(gateItemId);
  if (!item) {
    throw new Error(`gate_item: no item ${gateItemId}`);
  }
  if (REOPEN_BLOCKED_STATES.has(item.state)) {
    throw new Error(
      `gate_item ${gateItemId}: already ${item.state} — reopen only applies to a resolved/terminal item`,
    );
  }
  const now = new Date().toISOString();
  gateStore.appendEvent(gateItemId, {
    disposition: 'reopened',
    operator,
    evidence: reason === undefined ? undefined : { reason },
    at: now,
  });
  gateStore.advanceState(gateItemId, 'open', 'reopened', now);

  const updated = gateStore.getItem(gateItemId);
  if (!updated) {
    throw new Error(
      `gate_item: failed to read back item ${gateItemId} after reopen`,
    );
  }
  return updated;
}

const RECLASSIFY_TARGETS = new Set<GateItemClassification>([
  'Read-Only',
  'Prod-Mutating',
  'Opportunistic',
  'Human-Observation',
]);

/** The /gate skill's triage step: moves a needs-triage (or any) item into a resolved classification. */
export function reclassifyGateItem(
  gateItemId: string,
  classification: GateItemClassification,
  operator?: string,
): GateItem {
  if (!RECLASSIFY_TARGETS.has(classification)) {
    throw new Error(
      `gate_item: invalid reclassification target ${classification} — must be one of ${[...RECLASSIFY_TARGETS].join(', ')}`,
    );
  }
  const item = gateStore.getItem(gateItemId);
  if (!item) {
    throw new Error(`gate_item: no item ${gateItemId}`);
  }
  const now = new Date().toISOString();
  return gateStore.setClassification(gateItemId, classification, now, operator);
}

/** A raw Notion-style status string counts as not-started when it hasn't left Backlog/Ready. */
function isNotStartedStatus(notionStatus: string): boolean {
  if (!notionStatus) return true;
  return notionStatus.includes('Backlog') || notionStatus.includes('Ready');
}

/**
 * True when a filed follow-up fix task's cached status has reached Done —
 * the reconciler's fail-dedup gate (one open follow-up per item): a fresh
 * failure while the prior follow-up is still open skips refiling and just
 * logs against the existing one; a fresh failure once it's Done refiles.
 * Reads the local task cache (same source as backfillGateTask's status
 * check) rather than a live fetch — a cache miss/stale read defaults to
 * not-Done, the conservative (skip-refile) side.
 */
export function isFollowupTaskDone(taskId: string): boolean {
  const cacheRow = getTaskCache(taskId);
  if (!cacheRow) return false;
  try {
    const parsed = JSON.parse(cacheRow.raw_json) as { status?: string };
    return (parsed.status ?? '').includes('Done');
  } catch {
    return false;
  }
}

export interface BackfillGateTaskInput {
  project: string;
  taskId: string;
  milestone: string;
  milestoneBoardIds?: string[];
}

/**
 * The gate/gateBackfill.ts library's only invoker: fetches a Gate task's
 * live body and hands it to backfillGateBody. Only runs against a
 * not-yet-started task — a started Gate has run-history the backfill's
 * lossless-parse contract doesn't account for.
 */
export async function backfillGateTask(
  input: BackfillGateTaskInput,
): Promise<GateBackfillResult> {
  const backend = getTaskBackend(input.project);
  let body: string;
  try {
    body = await backend.fetchTaskPage(input.taskId);
  } catch (err) {
    throw new Error(
      `gate backfill: task ${input.taskId} not found (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
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
      `gate backfill: task ${input.taskId} already started (status=${notionStatus})`,
    );
  }

  return backfillGateBody(body, {
    project: input.project,
    milestone: input.milestone,
    milestoneBoardIds: input.milestoneBoardIds,
    now: new Date().toISOString(),
  });
}
