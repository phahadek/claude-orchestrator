import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import * as gateStore from './gateStore';
import type { GateItem } from './gateStore';
import type { GateItemClassification } from '../db/types';
import { getTaskBackend } from '../tasks/TaskBackend';
import {
  getTaskCache,
  getVerifySessionsForGateItems,
  getLiveVerifySessionItemIds,
  getLiveGateVerifySessions,
  getSkippedForBudgetHistory,
  hasActiveCapabilityRequestForSession,
} from '../db/queries';
import type { GateItemListOrder, GateItemVerifySession } from '../db/queries';
import { backfillGateBody, type GateBackfillResult } from './gateBackfill';
import { DEFAULT_BUDGET_MS } from './gateItemVerifier';
import { normalizeTaskId } from '../tasks/taskId';
import { getCachedType, getCachedStatus } from '../tasks/TaskWriteCommands';
import { yieldToEventLoop, runWithConcurrency } from '../utils/concurrency';
import { isMilestoneWrapped } from '../projects/milestoneResolver';

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

const execFileAsync = promisify(execFile);

/**
 * The non-blocking twin of DeployAncestrySource, for hot paths that run this
 * check across many items in a single tick (reconcileGateRunnability) — a
 * synchronous execFileSync spawn there blocks the whole Node process (every
 * concurrent request, not just this one) for the git subprocess's full
 * lifetime, once per item, per tick. isAncestor is async here so the git
 * spawn's I/O wait yields to the event loop instead of stalling it.
 */
export interface AsyncDeployAncestrySource {
  isAncestor(
    ancestorSha: string,
    descendantSha: string,
  ): boolean | Promise<boolean>;
}

/** Scoped to a specific local clone, like createLocalGitAncestrySource. */
export function createLocalAsyncGitAncestrySource(
  cwd?: string,
): AsyncDeployAncestrySource {
  return {
    async isAncestor(ancestorSha, descendantSha) {
      if (ancestorSha === descendantSha) return true;
      try {
        await execFileAsync(
          'git',
          ['merge-base', '--is-ancestor', ancestorSha, descendantSha],
          { cwd },
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** The default non-blocking git-ancestry source, used by reconcileGateRunnability. */
const asyncGitAncestrySource: AsyncDeployAncestrySource =
  createLocalAsyncGitAncestrySource();

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
 * new fail) supersedes it as the item's latest. `not-yet-triggerable` is the
 * "the real-world trigger hasn't happened yet" abstain — server-rejected
 * unless the item's classification is pending-eligible (Read-Only or
 * Prod-Mutating; mirroring approveGateItem's Prod-Mutating-only guard for
 * approval). Unlike `noted`/`needs-setup`, it does advance state: to
 * `pending`, with a backoff-scheduled next_attempt_at, so a near-certain
 * repeat non-result doesn't get re-dispatched every tick (see
 * nextStateForDisposition / computeNotYetTriggerableBackoffHours below). It
 * also requires non-empty evidence, like `discarded`.
 */
const GATE_DISPOSITIONS = [
  'pass',
  'fail',
  'deferred',
  'discarded',
  'noted',
  'needs-setup',
  'not-yet-triggerable',
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
  'pending',
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
  /** True when the item's latest event carries a non-resolving disposition (needs-setup/noted) — attempted but inconclusive, distinct from an item that was never dispatched at all. */
  nonResolving?: boolean;
  /** Backoff schedule for a `pending` item — when it next becomes due for re-check. Undefined for a non-pending item. */
  nextAttemptAt?: string;
  /** How many not-yet-triggerable attempts have been scheduled for this item's current pending parking. 0 for a non-pending item. */
  pendingAttemptCount: number;
}

export interface GateReadiness {
  status: 'green' | 'blocked';
  blocking: GateBlockingItem[];
  /**
   * Items parked at `pending` (backoff-scheduled for a later
   * not-yet-triggerable re-check) — a sibling bucket to `blocking`, never a
   * subset of it. Visible to every reader but never counted toward
   * `blocking.length` or the green/blocked status.
   */
  parked: GateBlockingItem[];
  /** Subset of `blocking` sitting in a state outside the closed vocabulary — needs human re-disposition, not indefinite blocking. */
  bespokeStates: GateBlockingItem[];
  /** Subset of `blocking` whose latest disposition is non-resolving (needs-setup/noted) — attempted but inconclusive, not simply untouched. */
  nonResolvingItems: GateBlockingItem[];
  /** The milestone's full per-state item totals, independent of any table filter; sums to the milestone's item total. */
  counts: Record<string, number>;
  /**
   * Exact count of items whose latest_disposition is `needs-setup` — the
   * same set the `awaitingSetup` list filter surfaces (queries.ts's
   * buildGateItemWhereClause: `latest_disposition = 'needs-setup'`). Not the
   * wider `nonResolvingItems` (needs-setup ∪ noted) — awaiting-setup items
   * still count inside `counts[item.state]` (always `runnable`) exactly as
   * before; this is an additive sibling field, not another counts key.
   */
  awaitingSetupCount: number;
}

/**
 * Headline output: green once every item in the milestone is
 * pass/deferred/discarded. Scoped to one project — milestone display names
 * are not unique across projects (e.g. two projects can each have an "M13"),
 * so an unscoped lookup would merge unrelated projects' items into one
 * rollup.
 */
export function getGateReadiness(
  project: string,
  milestone: string,
): GateReadiness {
  // A wrapped milestone's items are no longer reconciled by the scheduled
  // tick (see reconcileGateRunnability's isMilestoneWrapped option) — if
  // this rollup still counted them, a wrapped milestone with unresolved
  // items would report `blocked` forever with nothing left to ever
  // re-evaluate it. Excluding it here, independent of what the caller
  // already filtered, keeps this the single source of truth for readiness.
  if (isMilestoneWrapped(project, milestone)) {
    return {
      status: 'green',
      blocking: [],
      parked: [],
      bespokeStates: [],
      nonResolvingItems: [],
      counts: {},
      awaitingSetupCount: 0,
    };
  }
  const items = gateStore.listByMilestoneShallow(project, milestone);
  const toBlockingItem = (item: GateItem): GateBlockingItem => ({
    id: item.id,
    project: item.project,
    milestone: item.milestone,
    text: item.text,
    classification: item.classification,
    state: item.state,
    bespoke: isBespokeGateState(item.state),
    nonResolving:
      item.latestDisposition !== undefined &&
      NON_TERMINAL_DISPOSITIONS.has(item.latestDisposition as GateDisposition),
    nextAttemptAt: item.nextAttemptAt,
    pendingAttemptCount: item.pendingAttemptCount,
  });
  const blocking = items
    .filter(
      (item) => !RESOLVED_STATES.has(item.state) && item.state !== 'pending',
    )
    .map(toBlockingItem);
  const parked = items
    .filter((item) => item.state === 'pending')
    .map(toBlockingItem);
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.state] = (counts[item.state] ?? 0) + 1;
  }
  const awaitingSetupCount = items.filter(
    (item) => item.latestDisposition === 'needs-setup',
  ).length;
  return {
    status: blocking.length === 0 ? 'green' : 'blocked',
    blocking,
    parked,
    bespokeStates: blocking.filter((item) => item.bespoke),
    nonResolvingItems: blocking.filter((item) => item.nonResolving),
    counts,
    awaitingSetupCount,
  };
}

export interface ReconcileGateRunnabilityResult {
  markedRunnable: string[];
  reopened: string[];
}

export interface ReconcileOptions {
  ancestrySource?: AsyncDeployAncestrySource;
  /** Scope reconciliation to one project's items — every deploy SHA is project-specific. */
  project?: string;
  /**
   * Predicate excluding a wrapped milestone's items from this pass — passed
   * by the scheduled tick (gateReconciler.ts) via
   * createWrappedMilestoneChecker, so this function never hydrates a
   * wrapped milestone's rows in the first place. Omitted by the manual
   * POST /gate/reconcile route, which still reconciles everything
   * unconditionally on operator request.
   */
  isMilestoneWrapped?: (project: string, milestone: string) => boolean;
}

/**
 * The min_deployed_commit value in effect when the item's most recent `fail`
 * was recorded — stamped server-side onto that event by gateStore.appendEvent
 * at write time (never trusted from client-supplied evidence, which the
 * /gate skill documents as a free-text string). Distinguishes "already
 * covered before it failed" from "a follow-up source has since merged and
 * pushed min_deployed_commit forward" — the auto-reopen trigger below must
 * only fire on the latter.
 */
function minDeployedCommitAtLastFail(item: GateItem): string | null {
  const lastFail = [...item.events]
    .reverse()
    .find((e) => e.disposition === 'fail');
  if (!lastFail) return null;
  return lastFail.minDeployedCommitAtFail ?? null;
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
/**
 * Whether a single gate-item source is covered — i.e. its change is live.
 * A 💻 Code source (or one whose Type can't be resolved from cache, which
 * falls back to the strict test deliberately) requires a merged commit that
 * has actually deployed. Any other Type — 📐 Design, 📋 Planning, 📝 Docs,
 * 🎨 Assets, 🔧 Operational — produces no branch/PR, so "live" instead means
 * the source task itself has reached ✅ Done.
 */
async function isSourceCovered(
  source: GateItem['sources'][number],
  deploySha: string,
  ancestry: AsyncDeployAncestrySource,
  ancestryCache: Map<string, Promise<boolean>>,
): Promise<boolean> {
  const type = getCachedType(source.sourceTaskId);
  if (type !== null && type !== '💻 Code') {
    return getCachedStatus(source.sourceTaskId) === 'Done';
  }
  if (!source.mergeCommit) return false;
  // Memoized per (mergeCommit, deploySha) pair — multiple items (or
  // multiple sources within one item) commonly share the same pair within
  // a single tick, and git ancestry between two fixed shas can't change
  // mid-tick, so a repeat pair is a spawn worth skipping entirely.
  const key = `${source.mergeCommit}::${deploySha}`;
  let pending = ancestryCache.get(key);
  if (!pending) {
    pending = Promise.resolve(
      ancestry.isAncestor(source.mergeCommit, deploySha),
    );
    ancestryCache.set(key, pending);
  }
  return pending;
}

/** True once every source is covered — see isSourceCovered for the per-source, Type-dependent test. */
async function isItemCovered(
  item: GateItem,
  deploySha: string,
  ancestry: AsyncDeployAncestrySource,
  ancestryCache: Map<string, Promise<boolean>>,
): Promise<boolean> {
  if (item.sources.length === 0) return true;
  for (const source of item.sources) {
    if (!(await isSourceCovered(source, deploySha, ancestry, ancestryCache)))
      return false;
  }
  return true;
}

/**
 * Bound on simultaneous in-flight `git merge-base` spawns per tick — high
 * enough that the ancestry checks (see isSourceCovered) no longer serialize
 * one-at-a-time behind each other's I/O wait, low enough to not fork-bomb a
 * tick with hundreds of open gate items.
 */
const RECONCILE_ANCESTRY_CONCURRENCY = 8;

export async function reconcileGateRunnability(
  deploySha: string,
  options: ReconcileOptions = {},
): Promise<ReconcileGateRunnabilityResult> {
  const ancestry = options.ancestrySource ?? asyncGitAncestrySource;
  const now = new Date().toISOString();
  const markedRunnable: string[] = [];
  const reopened: string[] = [];

  // Filtered on the cheap shallow (no sources/events) rows first, then only
  // the surviving ids pay the per-item sources/events hydration cost —
  // both the terminal-`pass` filter and the wrapped-milestone exclusion
  // below used to run *after* gateStore.listAll/listByProject had already
  // hydrated every row, which is exactly the cost the wrapped-milestone
  // predicate exists to avoid.
  const shallowItems = options.project
    ? gateStore.listByProjectShallow(options.project)
    : gateStore.listAllShallow();

  // A pass is terminal for runnability — a redeploy never re-opens it.
  // Filtered out before the ancestry check below: re-checking coverage for
  // an item that can never change state is pure wasted git-spawn cost.
  const candidates = shallowItems
    .filter(
      (item) =>
        item.state !== 'pass' &&
        !(options.isMilestoneWrapped?.(item.project, item.milestone) ?? false),
    )
    .map((item) => gateStore.getItem(item.id))
    .filter((item): item is GateItem => item !== undefined);

  const ancestryCache = new Map<string, Promise<boolean>>();

  await runWithConcurrency(
    candidates,
    RECONCILE_ANCESTRY_CONCURRENCY,
    async (item) => {
      // The dominant cost of this loop is the per-source git-ancestry check
      // (see isSourceCovered) — async so the git subprocess's I/O wait
      // yields to the event loop instead of blocking the whole Node
      // process. runWithConcurrency above already keeps several of these
      // in flight at once rather than serializing them item by item.
      await yieldToEventLoop();

      const covered = await isItemCovered(
        item,
        deploySha,
        ancestry,
        ancestryCache,
      );

      let state = item.state;
      let currentDisposition = item.currentDisposition;

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
          currentDisposition = 'reopened';
        }
      }

      if (state === 'open' && covered) {
        gateStore.advanceState(item.id, 'runnable', currentDisposition, now);
        markedRunnable.push(item.id);
        return;
      }

      if (state === 'runnable' && !covered) {
        gateStore.advanceState(item.id, 'open', currentDisposition, now);
      }
    },
  );

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
 * needs-setup contract. Reads the denormalized latest_disposition column
 * rather than replaying the event log — appendGateItemEvent keeps it in
 * sync with every event's disposition, terminal or not.
 */
function isAwaitingSetup(item: GateItem): boolean {
  return item.latestDisposition === 'needs-setup';
}

/**
 * Pulls one tier's worth of runnable items at a time — never the full
 * runnable set. Scoped to one project (see getGateReadiness) — an unscoped
 * pull could hand one project's /gate session another project's items to
 * disposition, writing pass/fail/deferred events against the wrong
 * project's verification record.
 */
export function nextRunnableGateItems(
  project: string,
  milestone: string,
  options: NextRunnableGateItemsOptions = {},
): GateItem[] {
  const limit = options.limit ?? DEFAULT_BATCH_LIMIT;
  const runnable = gateStore
    .listByMilestone(project, milestone)
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

/**
 * Pending-analog dispatch pull: mirrors nextRunnableGateItems, but over
 * `pending` items — skipping one whose backoff (next_attempt_at) hasn't
 * elapsed yet, the same way nextRunnableGateItems skips a `needs-setup`
 * abstain via isAwaitingSetup. A `pending` item may be any pending-eligible
 * classification (Read-Only or Prod-Mutating — see appendGateItemEvent's
 * not-yet-triggerable guard), so there is no tier argument to mirror
 * TIER_ORDER with; the caller pulls across tiers in one batch.
 */
function isBackoffPending(item: GateItem, now: string): boolean {
  return item.nextAttemptAt !== undefined && item.nextAttemptAt > now;
}

export function nextPendingGateItems(
  project: string,
  milestone: string,
  options: { limit?: number } = {},
): GateItem[] {
  const limit = options.limit ?? DEFAULT_BATCH_LIMIT;
  const now = new Date().toISOString();
  return gateStore
    .listByMilestone(project, milestone)
    .filter((item) => item.state === 'pending')
    .filter((item) => !isBackoffPending(item, now))
    .slice(0, limit);
}

export function getGateItem(id: string): GateItem | undefined {
  return gateStore.getItem(id);
}

/**
 * Item-level re-home: copies a gate item to `targetMilestone` as a fresh
 * open item, preserving its full sources array (including empty — the
 * sourceless carry-forward case that `accreteGateContribution` cannot
 * express, since it validates and requires a single owning taskId). The
 * source item is left exactly as it was; see gateStore.carryForwardItem for
 * the idempotency guard. `targetMilestone` must already be the canonical
 * milestone display name — callers resolve it the same way accrete's route
 * does.
 */
export function carryForwardGateItem(
  gateItemId: string,
  targetMilestone: string,
): GateItem {
  return gateStore.carryForwardItem(
    gateItemId,
    targetMilestone,
    new Date().toISOString(),
  );
}

/** The item's full detail: its denormalized fields plus its sources and event history, by value. */
export function getGateItemDetail(
  id: string,
): gateStore.GateItemDetail | undefined {
  return gateStore.getItemDetail(id);
}

/**
 * The evidence attached to a gate item's most recent disposition-bearing
 * event (skipping pure log entries with no disposition) — the read a
 * pending-approval consent card surfaces alongside the item's text, since
 * that's the evidence behind the held pass. Undefined when the item has no
 * disposition-bearing event yet.
 */
export function latestDispositionEvidence(item: GateItem): unknown {
  for (let i = item.events.length - 1; i >= 0; i--) {
    const event = item.events[i];
    if (event.disposition !== undefined) return event.evidence;
  }
  return undefined;
}

/** The verify sessions dispatched for a gate item, most recent first. */
export function getVerifySessionsForGateItem(
  id: string,
): GateItemVerifySession[] {
  return getVerifySessionsForGateItems([id]);
}

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

export interface ListGateItemsOptions {
  project?: string;
  milestone?: string;
  state?: string;
  classification?: GateItemClassification;
  runnable?: boolean;
  /** True: only items whose latest event is the needs-setup abstain — "attempted, inconclusive" rather than never dispatched. */
  awaitingSetup?: boolean;
  page?: number;
  limit?: number;
  /** 'not-done-first' surfaces unresolved (non pass/deferred) items ahead of resolved ones — the run-worklist default. */
  order?: GateItemListOrder;
}

interface GateItemWithVerifyStatus extends GateItem {
  /** True if this item currently has a non-terminal, unended verify session. */
  verifyInFlight: boolean;
}

export interface ListGateItemsResult {
  items: GateItemWithVerifyStatus[];
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
      awaitingSetup: options.awaitingSetup,
    },
    limit,
    offset,
    options.order,
  );
  const liveItemIds = getLiveVerifySessionItemIds(items.map((item) => item.id));
  return {
    items: items.map((item) => ({
      ...item,
      verifyInFlight: liveItemIds.has(item.id),
    })),
    total,
    page,
  };
}

export interface MilestoneReadiness {
  project: string;
  milestone: string;
  status: 'green' | 'blocked';
  blockingCount: number;
  /** Items parked at `pending` — never counted toward blockingCount or the green/blocked status. */
  parkedCount: number;
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
    ? gateStore.listByProjectShallow(options.project)
    : gateStore.listAllShallow();

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
        (item) => !RESOLVED_STATES.has(item.state) && item.state !== 'pending',
      ).length;
      const parkedCount = group.items.filter(
        (item) => item.state === 'pending',
      ).length;
      const status: 'green' | 'blocked' =
        blockingCount === 0 ? 'green' : 'blocked';
      return {
        project: group.project,
        milestone: group.milestone,
        status,
        blockingCount,
        parkedCount,
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
  /** true = a fully-unattended reconciler auto-launch verified this event; false = a manual dispatch; omit for a non-verifier-originated event. */
  unattended?: boolean;
}

/**
 * Classifications eligible for the `not-yet-triggerable` -> `pending` abstain
 * — the "when can this be verified" axis, orthogonal to "who can verify it".
 * needs-triage is excluded: an item still awaiting triage has no verifier to
 * abstain in the first place. Human-Observation is included even though it
 * is never auto-dispatched — an operator disposing of the Human-Observation
 * mirror card can still park it via this same path (the "not now, try again
 * later" abstain), not just an auto-run verifier.
 */
const PENDING_ELIGIBLE_CLASSIFICATIONS = new Set<GateItemClassification>([
  'Read-Only',
  'Prod-Mutating',
  'Human-Observation',
]);

/** Prod-Mutating passes stop short of resolving — they wait for approveGateItem. A not-yet-triggerable result (Read-Only or Prod-Mutating) parks at `pending`, not a state literally named after the disposition. */
function nextStateForDisposition(
  disposition: GateDisposition,
  classification: GateItemClassification,
): string {
  if (disposition === 'pass' && classification === 'Prod-Mutating') {
    return 'pending-approval';
  }
  if (disposition === 'not-yet-triggerable') {
    return 'pending';
  }
  return disposition;
}

/** First re-check 3h after parking, doubling per consecutive not-yet-triggerable result, capped at 1 week. */
const NOT_YET_TRIGGERABLE_BASE_BACKOFF_HOURS = 3;
const NOT_YET_TRIGGERABLE_MAX_BACKOFF_HOURS = 168;
const MS_PER_HOUR = 60 * 60 * 1000;

/** attemptCount is 1-indexed: 1 -> 3h, 2 -> 6h, 3 -> 12h, ..., capped at 168h. */
function computeNotYetTriggerableBackoffHours(attemptCount: number): number {
  return Math.min(
    NOT_YET_TRIGGERABLE_BASE_BACKOFF_HOURS * 2 ** (attemptCount - 1),
    NOT_YET_TRIGGERABLE_MAX_BACKOFF_HOURS,
  );
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
 * event, or one carrying a non-terminal disposition (`noted`/`needs-setup`),
 * is a pure log entry as far as state goes — state is left unchanged — but
 * every disposition-bearing event, terminal or not, is still mirrored onto
 * the item's latest_disposition column (see gateStore.appendEvent), so a
 * non-resolving abstain is queryable rather than indistinguishable from an
 * item that was never attempted. `discarded` requires an evidence/reason,
 * since it permanently voids the item.
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
  if (
    event.disposition === 'not-yet-triggerable' &&
    !PENDING_ELIGIBLE_CLASSIFICATIONS.has(item.classification)
  ) {
    throw new Error(
      `gate_item ${gateItemId}: not-yet-triggerable only applies to pending-eligible items (classification=${item.classification})`,
    );
  }
  if (event.disposition === 'not-yet-triggerable' && !event.evidence) {
    throw new Error(
      `gate_item_event: 'not-yet-triggerable' requires an evidence/reason`,
    );
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

  if (event.disposition === 'not-yet-triggerable') {
    // Consecutive count: resumes from the item's own prior count only while
    // it was already `pending` — any other prior state (e.g. a fresh `open`
    // item, or one just reopened) starts the backoff over from 3h.
    const attemptCount =
      (item.state === 'pending' ? item.pendingAttemptCount : 0) + 1;
    const backoffHours = computeNotYetTriggerableBackoffHours(attemptCount);
    const nextAttemptAt = new Date(
      Date.parse(now) + backoffHours * MS_PER_HOUR,
    ).toISOString();
    gateStore.schedulePendingAttempt(
      gateItemId,
      nextAttemptAt,
      attemptCount,
      now,
    );
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
 * The Prod-Mutating consent gate's other exit: records withheld consent as a
 * `fail` disposition on the item — no new state, since the readiness rollup
 * already treats `fail` as unresolved (RESOLVED_STATES excludes it) and
 * `fail` sits outside REOPEN_BLOCKED_STATES, so reject then reopen forms a
 * complete loop back to re-verification, unlike the one-way
 * `pending-approval` state itself. Mirrors approveGateItem's guards, plus a
 * mandatory operator reason — withholding consent without a recorded reason
 * would be indistinguishable from an item nobody has looked at yet.
 */
export function rejectGateItem(
  gateItemId: string,
  reason: string,
  operator?: string,
): GateItem {
  const item = gateStore.getItem(gateItemId);
  if (!item) {
    throw new Error(`gate_item: no item ${gateItemId}`);
  }
  if (item.classification !== 'Prod-Mutating') {
    throw new Error(
      `gate_item ${gateItemId}: rejection only applies to Prod-Mutating items (classification=${item.classification})`,
    );
  }
  if (item.state !== 'pending-approval') {
    throw new Error(
      `gate_item ${gateItemId}: not pending approval (state=${item.state})`,
    );
  }
  if (!reason.trim()) {
    throw new Error(
      `gate_item ${gateItemId}: rejection requires an operator reason`,
    );
  }
  const now = new Date().toISOString();
  gateStore.appendEvent(gateItemId, {
    disposition: 'fail',
    operator,
    evidence: { reason },
    at: now,
  });
  gateStore.advanceState(gateItemId, 'fail', 'fail', now);

  const updated = gateStore.getItem(gateItemId);
  if (!updated) {
    throw new Error(
      `gate_item: failed to read back item ${gateItemId} after rejection`,
    );
  }
  return updated;
}

/**
 * States a reopen may be applied from: any resolved/terminal state, including
 * the fail-trap left by a fail dispositioned outside the reconciler's
 * processItem path. `open`/`runnable`/`pending-approval` are already on a
 * sanctioned path back to resolution, so reopening them is a no-op we reject.
 * `pending` joins them for the same reason — it already carries its own
 * scheduled backoff re-check; an operator forces it back to `open` early via
 * reclassifyGateItem (away from a pending-eligible tier) instead of this
 * generic reopen.
 */
const REOPEN_BLOCKED_STATES = new Set([
  'open',
  'runnable',
  'pending-approval',
  'pending',
]);

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
  'Human-Observation',
]);

/**
 * The /gate skill's triage step: moves a needs-triage (or any) item into a
 * resolved classification. Reclassifying a `pending` item to a target that
 * is itself pending-eligible (Read-Only <-> Prod-Mutating) preserves the
 * `pending` state and its backoff schedule — only a reclassify to a
 * non-pending-eligible target (Human-Observation, needs-triage) forces it
 * back to `open` in the same call, since advanceState clears
 * next_attempt_at/pending_attempt_count on any transition out of `pending`.
 */
export function reclassifyGateItem(
  gateItemId: string,
  classification: GateItemClassification,
  operator?: string,
  reason?: string,
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
  const updated = gateStore.setClassification(
    gateItemId,
    classification,
    now,
    operator,
    reason ? { reason } : undefined,
  );
  if (
    item.state === 'pending' &&
    !PENDING_ELIGIBLE_CLASSIFICATIONS.has(classification)
  ) {
    gateStore.advanceState(gateItemId, 'open', 'reclassified', now);
    const reopened = gateStore.getItem(gateItemId);
    if (!reopened) {
      throw new Error(
        `gate_item: failed to read back item ${gateItemId} after reclassify-forced reopen`,
      );
    }
    return reopened;
  }
  return updated;
}

/**
 * Reclassification targets a gate-verify session is permitted to propose
 * (see gateItemVerifier's `reclassify` report field). Human-Observation and
 * needs-triage route the item *out* of auto-run, so they're applied here
 * with provenance regardless of how the verdict reached this function.
 * MAX_VERIFIER_RECLASSIFY_ATTEMPTS independently caps repeat proposals per
 * item. Read-Only and Prod-Mutating remain excluded — a verifier is never
 * allowed to propose either auto-run tier.
 */
const VERIFIER_RECLASSIFY_TARGETS = new Set<GateItemClassification>([
  'Human-Observation',
  'needs-triage',
]);

/** Ping-pong guard: caps how many times a verifier may reclassify the same item before a human has to step in via /gate. */
const MAX_VERIFIER_RECLASSIFY_ATTEMPTS = 1;

/** Verifier-attributed reclassify events already recorded against this item. */
function countVerifierReclassifications(item: GateItem): number {
  return item.events.filter(
    (e) => e.disposition === 'reclassified' && e.operator === 'gate-verifier',
  ).length;
}

export interface GateItemReclassifyOutcome {
  applied: boolean;
  item: GateItem;
  /** Why the proposal was not applied — present only when `applied` is false. */
  rejectedReason?: string;
}

/**
 * Applies (or rejects) a gate-verify session's self-correction proposal —
 * "this item is mis-classified, route it to X instead." The backend
 * remains the only writer of gate state: this validates the proposed target
 * against the closed verifier-reclassify vocabulary, checks it's not a
 * no-op, and enforces the ping-pong guard, before ever touching state.
 * Auto-applied with provenance (operator: 'gate-verifier') per the grooming
 * decision — both permitted targets add oversight, so there's no
 * operator-approval stage on this path. Reversible by an operator through
 * the normal /gate reclassify flow.
 */
export function proposeGateItemReclassification(
  gateItemId: string,
  to: GateItemClassification,
  reason: string,
): GateItemReclassifyOutcome {
  const item = gateStore.getItem(gateItemId);
  if (!item) {
    throw new Error(`gate_item: no item ${gateItemId}`);
  }
  if (!VERIFIER_RECLASSIFY_TARGETS.has(to)) {
    return {
      applied: false,
      item,
      rejectedReason: `verifier may only propose reclassification to ${[...VERIFIER_RECLASSIFY_TARGETS].join(' or ')}, not ${to}`,
    };
  }
  if (item.classification === to) {
    return {
      applied: false,
      item,
      rejectedReason: `item is already classified ${to}`,
    };
  }
  if (
    countVerifierReclassifications(item) >= MAX_VERIFIER_RECLASSIFY_ATTEMPTS
  ) {
    return {
      applied: false,
      item,
      rejectedReason: `item has already been reclassified by a verifier ${MAX_VERIFIER_RECLASSIFY_ATTEMPTS} time(s) — needs operator attention via /gate rather than a further automatic reclassification`,
    };
  }
  const now = new Date().toISOString();
  const updated = gateStore.setClassification(
    gateItemId,
    to,
    now,
    'gate-verifier',
    { reason },
  );
  return { applied: true, item: updated };
}

/** A raw cached-status string counts as not-started when it hasn't left Backlog/Ready. */
function isNotStartedStatus(cachedStatus: string): boolean {
  if (!cachedStatus) return true;
  return cachedStatus.includes('Backlog') || cachedStatus.includes('Ready');
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
  const cacheRow = getTaskCache(normalizeTaskId(taskId));
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

  const cacheRow = getTaskCache(normalizeTaskId(input.taskId));
  let cachedStatus = '';
  if (cacheRow) {
    try {
      const parsed = JSON.parse(cacheRow.raw_json) as { status?: string };
      cachedStatus = parsed.status ?? '';
    } catch {
      // ignore malformed cache; treated as not-started below
    }
  }
  if (!isNotStartedStatus(cachedStatus)) {
    throw new Error(
      `gate backfill: task ${input.taskId} already started (status=${cachedStatus})`,
    );
  }

  return backfillGateBody(body, {
    project: input.project,
    milestone: input.milestone,
    milestoneBoardIds: input.milestoneBoardIds,
    now: new Date().toISOString(),
  });
}

/** scheduler_audit job name for the gate-verify reconciler tick — see gateReconciler.register() and getGateVerifyFleetState. */
export const GATE_VERIFICATION_RECONCILER_JOB = 'gate_verification_reconciler';

interface GateVerifyFleetSession {
  sessionId: string;
  itemId: string;
  project: string;
  milestone: string;
  text: string;
  status: string;
  startedAt: number;
  elapsedMs: number;
  remainingMs: number;
  suspended: boolean;
}

export interface GateVerifyFleetState {
  liveCount: number;
  sessions: GateVerifyFleetSession[];
  skippedForBudgetHistory: ReturnType<typeof getSkippedForBudgetHistory>;
}

/**
 * The cross-project gate-verify fleet snapshot: every in-flight verify
 * session across every project, with elapsed/remaining budget (computed
 * from sessions.started_at + the verifier's fixed DEFAULT_BUDGET_MS, so it
 * survives a process restart without needing one) and capability-suspension
 * state (a live join against staged_intent, mirroring
 * hasActiveCapabilityRequestForSession's own check and the boot-time
 * gate_verify_reattachment step). liveCount is the length of the same
 * live-session row set returned in `sessions`, never a second query. No
 * project filter — every row carries its own project/milestone from
 * gate_item.
 */
export function getGateVerifyFleetState(
  now: number = Date.now(),
): GateVerifyFleetState {
  const liveSessions = getLiveGateVerifySessions();
  const sessions: GateVerifyFleetSession[] = liveSessions.map((session) => {
    const item = gateStore.getItem(session.itemId);
    const elapsedMs = Math.max(0, now - session.startedAt);
    const remainingMs = Math.max(0, DEFAULT_BUDGET_MS - elapsedMs);
    return {
      sessionId: session.sessionId,
      itemId: session.itemId,
      project: item?.project ?? session.projectId ?? '',
      milestone: item?.milestone ?? '',
      text: item?.text ?? '',
      status: session.status,
      startedAt: session.startedAt,
      elapsedMs,
      remainingMs,
      suspended: hasActiveCapabilityRequestForSession(session.sessionId),
    };
  });
  return {
    liveCount: sessions.length,
    sessions,
    skippedForBudgetHistory: getSkippedForBudgetHistory(
      GATE_VERIFICATION_RECONCILER_JOB,
    ),
  };
}
