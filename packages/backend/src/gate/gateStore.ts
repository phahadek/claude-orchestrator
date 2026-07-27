import crypto from 'crypto';
import { recordEvent } from '../audit/AuditLog';
import {
  getGateItem,
  listGateItemsByMilestone,
  listGateItemsByMilestoneAllProjects,
  listAllGateItems,
  listGateItemsByProject,
  listGateItemsFiltered,
  countGateItemsFiltered,
  insertGateItem,
  updateGateItem,
  updateGateItemMinDeployedCommit,
  touchGateItemUpdatedAt,
  listGateItemSources,
  insertGateItemSource,
  listGateItemEvents,
  insertGateItemEvent,
  updateGateItemSourceMergeCommit,
  rehomeGateItemsBySourceTask,
  getGateAccretion,
  upsertGateAccretion,
  deleteGateContribution,
  listGateItemIdsBySourceTask,
  listUnfilledGateItemSourceTaskIds,
} from '../db/queries';
import type { GateItemFilter, GateItemListOrder } from '../db/queries';
import type {
  GateItemClassification,
  GateAccretionDecision,
} from '../db/types';
import { normalizeTaskId } from '../tasks/taskId';

export interface GateItemSource {
  sourceTaskId: string;
  sourceTaskTitle: string;
  mergeCommit?: string;
  addedAt: string;
}

export interface GateItemEvent {
  /** Absent for a pure log entry — evidence recorded without advancing state. */
  disposition?: string;
  evidence?: unknown;
  filedFollowon?: string;
  deploySha?: string;
  operator?: string;
  at: string;
}

export interface GateItem {
  id: string;
  project: string;
  milestone: string;
  text: string;
  classification: GateItemClassification;
  minDeployedCommit?: string;
  state: string;
  currentDisposition?: string;
  updatedAt: string;
  sources: GateItemSource[];
  events: GateItemEvent[];
}

function parseJson(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function stringifyJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

/** Full read of one gate item, denormalized state plus its sources and event history. */
export function getItem(id: string): GateItem | undefined {
  const row = getGateItem(id);
  if (!row) return undefined;
  return {
    id: row.id,
    project: row.project,
    milestone: row.milestone,
    text: row.text,
    classification: row.classification,
    minDeployedCommit: row.min_deployed_commit ?? undefined,
    state: row.state,
    currentDisposition: row.current_disposition ?? undefined,
    updatedAt: row.updated_at,
    sources: listGateItemSources(row.id).map((s) => ({
      sourceTaskId: s.source_task_id,
      sourceTaskTitle: s.source_task_title,
      mergeCommit: s.merge_commit ?? undefined,
      addedAt: s.added_at,
    })),
    events: listGateItemEvents(row.id).map((e) => ({
      disposition: e.disposition ?? undefined,
      evidence: parseJson(e.evidence),
      filedFollowon: e.filed_followon ?? undefined,
      deploySha: e.deploy_sha ?? undefined,
      operator: e.operator ?? undefined,
      at: e.at,
    })),
  };
}

export interface GateItemDetail {
  item: Omit<GateItem, 'sources' | 'events'>;
  sources: GateItemSource[];
  events: GateItemEvent[];
}

/** Full read of one gate item, split into its denormalized fields and its associations, by value. */
export function getItemDetail(id: string): GateItemDetail | undefined {
  const full = getItem(id);
  if (!full) return undefined;
  const { sources, events, ...item } = full;
  return { item, sources, events };
}

/** All gate items for a milestone, each with its sources and event history. */
export function listByMilestone(
  project: string,
  milestone: string,
): GateItem[] {
  return listGateItemsByMilestone(project, milestone)
    .map((row) => getItem(row.id))
    .filter((item): item is GateItem => item !== undefined);
}

/** All gate items for a milestone, regardless of project — the readiness/runnability API's lookup. */
export function listByMilestoneAllProjects(milestone: string): GateItem[] {
  return listGateItemsByMilestoneAllProjects(milestone)
    .map((row) => getItem(row.id))
    .filter((item): item is GateItem => item !== undefined);
}

/** Every gate item across all projects/milestones — the reconciler's working set. */
export function listAll(): GateItem[] {
  return listAllGateItems()
    .map((row) => getItem(row.id))
    .filter((item): item is GateItem => item !== undefined);
}

/** Every gate item for a single project, regardless of milestone — the readiness rollup's per-project lookup. */
export function listByProject(project: string): GateItem[] {
  return listGateItemsByProject(project)
    .map((row) => getItem(row.id))
    .filter((item): item is GateItem => item !== undefined);
}

export interface ListFilteredResult {
  items: GateItem[];
  total: number;
}

/** Paginated, filtered read of gate items — never an unbounded load. */
export function listFiltered(
  filter: GateItemFilter,
  limit: number,
  offset: number,
  order?: GateItemListOrder,
): ListFilteredResult {
  const items = listGateItemsFiltered(filter, limit, offset, order)
    .map((row) => getItem(row.id))
    .filter((item): item is GateItem => item !== undefined);
  const total = countGateItemsFiltered(filter);
  return { items, total };
}

export interface NewGateItemInput {
  project: string;
  milestone: string;
  text: string;
  classification: GateItemClassification;
  sources: Omit<GateItemSource, 'addedAt'>[];
  updatedAt: string;
}

/**
 * Mints a fresh id at accretion time (never a text hash of the content —
 * item text is mutable). min_deployed_commit stays null until the source
 * task's PR merges.
 */
export function insertItem(input: NewGateItemInput): GateItem {
  const id = crypto.randomUUID();
  const alreadyMergedCommit =
    input.sources.find((s) => s.mergeCommit)?.mergeCommit ?? null;
  insertGateItem({
    id,
    project: input.project,
    milestone: input.milestone,
    text: input.text,
    classification: input.classification,
    min_deployed_commit: alreadyMergedCommit,
    state: 'open',
    current_disposition: null,
    updated_at: input.updatedAt,
  });
  for (const source of input.sources) {
    insertGateItemSource({
      gate_item_id: id,
      source_task_id: source.sourceTaskId,
      source_task_title: source.sourceTaskTitle,
      merge_commit: source.mergeCommit ?? null,
      added_at: input.updatedAt,
    });
  }
  recordEvent({
    event_type: 'gate_item_created',
    actor_type: 'system',
    project_id: input.project,
    payload: { gateItemId: id, milestone: input.milestone },
  });
  const item = getItem(id);
  if (!item) {
    throw new Error(`gate_item: failed to read back item ${id} after insert`);
  }
  return item;
}

/** Appends an immutable event (evidence carried by value, with provenance) to an item's history. */
export function appendEvent(gateItemId: string, event: GateItemEvent): void {
  const row = getGateItem(gateItemId);
  if (!row) {
    throw new Error(`gate_item: no item ${gateItemId} to append an event to`);
  }
  insertGateItemEvent({
    gate_item_id: gateItemId,
    disposition: event.disposition ?? null,
    evidence: stringifyJson(event.evidence),
    filed_followon: event.filedFollowon ?? null,
    deploy_sha: event.deploySha ?? null,
    operator: event.operator ?? null,
    at: event.at,
  });
  touchGateItemUpdatedAt(gateItemId, event.at);
  recordEvent({
    event_type: 'gate_item_event_appended',
    actor_type: 'system',
    project_id: row.project,
    payload: { gateItemId, disposition: event.disposition },
  });
}

/**
 * Advances the denormalized (state, current_disposition) pair — the fast-read
 * summary consumers use instead of replaying the event log.
 */
export function advanceState(
  gateItemId: string,
  state: string,
  currentDisposition: string | undefined,
  updatedAt: string,
): void {
  const row = getGateItem(gateItemId);
  if (!row) {
    throw new Error(`gate_item: no item ${gateItemId} to advance`);
  }
  updateGateItem({
    ...row,
    state,
    current_disposition: currentDisposition ?? null,
    updated_at: updatedAt,
  });
  recordEvent({
    event_type: 'gate_item_state_changed',
    actor_type: 'system',
    project_id: row.project,
    payload: { gateItemId, from: row.state, to: state },
  });
}

const VALID_RECLASSIFY_TARGETS = new Set<GateItemClassification>([
  'Read-Only',
  'Prod-Mutating',
  'Opportunistic',
  'Human-Observation',
  // A verifier's self-correction proposal (see gateService's
  // proposeGateItemReclassification) may hand an item back to needs-triage
  // when it cannot tell what tier fits — the human /gate reclassify step
  // never targets this itself, but this store-level primitive is shared.
  'needs-triage',
]);

/**
 * Triages a `needs-triage` (or any) item into one of the resolved tiers —
 * the /gate skill's reclassify step, and a gate-verify session's
 * self-correction proposal (gateService.proposeGateItemReclassification).
 * `evidenceExtra` merges additional fields (e.g. a verifier's `reason`) into
 * the recorded event's evidence alongside the standard {from, to}.
 */
export function setClassification(
  gateItemId: string,
  classification: GateItemClassification,
  updatedAt: string,
  operator?: string,
  evidenceExtra?: Record<string, unknown>,
): GateItem {
  if (!VALID_RECLASSIFY_TARGETS.has(classification)) {
    throw new Error(
      `gate_item: invalid reclassification target ${classification}`,
    );
  }
  const row = getGateItem(gateItemId);
  if (!row) {
    throw new Error(`gate_item: no item ${gateItemId} to reclassify`);
  }
  const from = row.classification;
  updateGateItem({
    ...row,
    classification,
    updated_at: updatedAt,
  });
  insertGateItemEvent({
    gate_item_id: gateItemId,
    disposition: 'reclassified',
    evidence: stringifyJson({ from, to: classification, ...evidenceExtra }),
    filed_followon: null,
    deploy_sha: null,
    operator: operator ?? null,
    at: updatedAt,
  });
  recordEvent({
    event_type: 'gate_item_reclassified',
    actor_type: 'system',
    project_id: row.project,
    payload: { gateItemId, from, to: classification },
  });
  const item = getItem(gateItemId);
  if (!item) {
    throw new Error(
      `gate_item: failed to read back item ${gateItemId} after reclassify`,
    );
  }
  return item;
}

/**
 * Sets the commit a deploy must contain for this item to become runnable.
 * Owned by whatever recomputes it from the item's sources (the reconciler
 * service, sibling task 39b22f91-52f3-819e) — a later call with a
 * later commit is how an already-passed item gets superseded.
 */
export function setMinDeployedCommit(
  gateItemId: string,
  minDeployedCommit: string,
  updatedAt: string,
): void {
  const row = getGateItem(gateItemId);
  if (!row) {
    throw new Error(`gate_item: no item ${gateItemId} to set a commit on`);
  }
  updateGateItemMinDeployedCommit(gateItemId, minDeployedCommit, updatedAt);
}

/**
 * Attaches a new source to an existing item — the re-open path when a
 * failing verification files a follow-up fix task (the reconciler service,
 * sibling task 39b22f91-52f3-819e). Does not itself change item state; the
 * caller advances state separately.
 */
export function addSource(
  gateItemId: string,
  source: Omit<GateItemSource, 'addedAt'>,
  addedAt: string,
): void {
  const row = getGateItem(gateItemId);
  if (!row) {
    throw new Error(`gate_item: no item ${gateItemId} to add a source to`);
  }
  insertGateItemSource({
    gate_item_id: gateItemId,
    source_task_id: source.sourceTaskId,
    source_task_title: source.sourceTaskTitle,
    merge_commit: source.mergeCommit ?? null,
    added_at: addedAt,
  });
  recordEvent({
    event_type: 'gate_item_source_added',
    actor_type: 'system',
    project_id: row.project,
    payload: { gateItemId, sourceTaskId: source.sourceTaskId },
  });
}

/** Records the source PR's merge commit — filled at source-task merge, not at accretion. */
export function setSourceMergeCommit(
  gateItemId: string,
  sourceTaskId: string,
  mergeCommit: string,
): void {
  const normalizedSourceTaskId = normalizeTaskId(sourceTaskId);
  const sources = listGateItemSources(gateItemId);
  if (!sources.some((s) => s.source_task_id === normalizedSourceTaskId)) {
    throw new Error(
      `gate_item_source: no source ${sourceTaskId} on item ${gateItemId}`,
    );
  }
  updateGateItemSourceMergeCommit(
    gateItemId,
    normalizedSourceTaskId,
    mergeCommit,
  );
}

/**
 * Every gate_item id sourced from a task, across every project — the
 * merge-completion consumer's fan-out from a merged `notion_task_id` to the
 * gate_item rows that need their source filled and commit recomputed.
 */
export function itemIdsBySourceTask(sourceTaskId: string): string[] {
  return listGateItemIdsBySourceTask(sourceTaskId);
}

/**
 * Every distinct source task id with at least one still-unfilled
 * gate_item_source.merge_commit — the reconciler catch-up net's candidate
 * set (see `catchUpMergeCommits` in gateMergeConsumer.ts).
 */
export function unfilledSourceTaskIds(): string[] {
  return listUnfilledGateItemSourceTaskIds();
}

/**
 * Recomputes min_deployed_commit as the latest merge commit across an item's
 * sources — "latest" meaning the most recently filled one, taken as the last
 * (by insertion order, `listGateItemSources`' id-ASC order) source that
 * carries a merge_commit. A follow-on source (always appended after its
 * predecessors — see `addSource`) only outranks earlier sources once its own
 * merge event fills it in, so this only ever advances forward in time.
 * No-op (returns undefined) when no source has merged yet.
 */
export function recomputeMinDeployedCommit(
  gateItemId: string,
  updatedAt: string,
): string | undefined {
  const merged = listGateItemSources(gateItemId).filter((s) => s.merge_commit);
  if (merged.length === 0) return undefined;
  const latest = merged[merged.length - 1].merge_commit as string;
  updateGateItemMinDeployedCommit(gateItemId, latest, updatedAt);
  return latest;
}

/**
 * Re-homes a moved task's gate_item rows (identified via gate_item_source)
 * onto the target milestone — the gate accretion carry for moveTask. Leaves
 * gate_item_source.source_task_id pointing at the original task id (the
 * audit trail of what accreted the item) and min_deployed_commit untouched
 * (commit-based and project-scoped, unaffected by a cross-milestone move).
 */
export function rehomeItemsBySourceTask(
  project: string,
  sourceTaskId: string,
  targetMilestone: string,
  updatedAt: string,
): string[] {
  const gateItemIds = rehomeGateItemsBySourceTask(
    project,
    sourceTaskId,
    targetMilestone,
    updatedAt,
  );
  for (const gateItemId of gateItemIds) {
    recordEvent({
      event_type: 'gate_item_rehomed',
      actor_type: 'system',
      project_id: project,
      task_id: sourceTaskId,
      payload: { gateItemId, milestone: targetMilestone },
    });
  }
  return gateItemIds;
}

export interface GateAccretionMarker {
  sourceTaskId: string;
  project: string;
  milestone: string;
  decision: GateAccretionDecision;
  /**
   * The groomer's substantive reason for a bare 'none'/'n/a' decision — the
   * judgement that the change's behaviour was assessed and found to have
   * nothing runtime-observable, tied to the change rather than to the state
   * of the pre-groom body section. Absent for an 'items' decision.
   */
  reason?: string;
  accretedAt: string;
}

/** Reads the per-source gate_accretion marker the promotion gate checks for. */
export function getAccretionMarker(
  sourceTaskId: string,
): GateAccretionMarker | undefined {
  const row = getGateAccretion(sourceTaskId);
  if (!row) return undefined;
  return {
    sourceTaskId: row.source_task_id,
    project: row.project,
    milestone: row.milestone,
    decision: row.decision,
    reason: row.reason ?? undefined,
    accretedAt: row.accreted_at,
  };
}

/**
 * Records (or replaces) the per-source gate_accretion marker — written once a
 * Code/Tooling task has either appended its runtime items to the milestone
 * gate ('items') or explicitly recorded that it has none ('none') or is
 * exempt ('n/a'). checkGroomingPromotionGate reads this before allowing the
 * task's Ready flip.
 */
export function recordAccretionMarker(marker: GateAccretionMarker): void {
  upsertGateAccretion({
    source_task_id: marker.sourceTaskId,
    project: marker.project,
    milestone: marker.milestone,
    decision: marker.decision,
    reason: marker.reason ?? null,
    accreted_at: marker.accretedAt,
  });
}

/**
 * Undoes a completed accretion (the minted gate_item rows and the
 * gate_accretion marker) — the rollback half of insertItem +
 * recordAccretionMarker, used when a later step of an atomic Ready-flip
 * transaction fails after gate accretion already committed.
 */
export function rollbackContribution(
  itemIds: string[],
  sourceTaskId: string,
): void {
  deleteGateContribution(itemIds, sourceTaskId);
}
