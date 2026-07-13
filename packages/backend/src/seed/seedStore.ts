import crypto from 'crypto';
import { recordEvent } from '../audit/AuditLog';
import {
  getSeedItem,
  listSeedItemsByMilestone,
  listSeedItemsByMilestoneAllProjects,
  insertSeedItem,
  updateSeedItem,
  updateSeedItemMinDeployedCommit,
  listSeedItemSources,
  insertSeedItemSource,
  updateSeedItemSourceMergeCommit,
  listSeedItemEvents,
  insertSeedItemEvent,
  getSeedAccretion,
  upsertSeedAccretion,
} from '../db/queries';
import type {
  SeedItemState,
  SeedItemEventOutcome,
  SeedAccretionDecision,
} from '../db/types';

export interface SeedItemSource {
  sourceTaskId: string;
  sourceTaskTitle: string;
  mergeCommit?: string;
  addedAt: string;
}

export interface SeedItemEvent {
  outcome: SeedItemEventOutcome;
  evidence?: unknown;
  filedFollowon?: string;
  operator?: string;
  at: string;
}

export interface SeedItem {
  id: string;
  project: string;
  milestone: string;
  spec: string;
  minDeployedCommit?: string;
  state: SeedItemState;
  updatedAt: string;
  sources: SeedItemSource[];
  events: SeedItemEvent[];
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

/** Full read of one seed item, denormalized state plus its sources and event history. */
export function getItem(id: string): SeedItem | undefined {
  const row = getSeedItem(id);
  if (!row) return undefined;
  return {
    id: row.id,
    project: row.project,
    milestone: row.milestone,
    spec: row.spec,
    minDeployedCommit: row.min_deployed_commit ?? undefined,
    state: row.state,
    updatedAt: row.updated_at,
    sources: listSeedItemSources(row.id).map((s) => ({
      sourceTaskId: s.source_task_id,
      sourceTaskTitle: s.source_task_title,
      mergeCommit: s.merge_commit ?? undefined,
      addedAt: s.added_at,
    })),
    events: listSeedItemEvents(row.id).map((e) => ({
      outcome: e.outcome,
      evidence: parseJson(e.evidence),
      filedFollowon: e.filed_followon ?? undefined,
      operator: e.operator ?? undefined,
      at: e.at,
    })),
  };
}

/** All seed items for a milestone, each with its sources and event history. */
export function listByMilestone(
  project: string,
  milestone: string,
): SeedItem[] {
  return listSeedItemsByMilestone(project, milestone)
    .map((row) => getItem(row.id))
    .filter((item): item is SeedItem => item !== undefined);
}

/** All seed items for a milestone, regardless of project — the readiness/applyability API's lookup. */
export function listByMilestoneAllProjects(milestone: string): SeedItem[] {
  return listSeedItemsByMilestoneAllProjects(milestone)
    .map((row) => getItem(row.id))
    .filter((item): item is SeedItem => item !== undefined);
}

export interface NewSeedItemInput {
  project: string;
  milestone: string;
  spec: string;
  sources: Omit<SeedItemSource, 'addedAt'>[];
  updatedAt: string;
}

/**
 * Mints a fresh id at accretion time (never a text hash of the content —
 * item spec is mutable). min_deployed_commit stays null until the source
 * task's PR merges.
 */
export function insertItem(input: NewSeedItemInput): SeedItem {
  const id = crypto.randomUUID();
  insertSeedItem({
    id,
    project: input.project,
    milestone: input.milestone,
    spec: input.spec,
    min_deployed_commit: null,
    state: 'pending',
    updated_at: input.updatedAt,
  });
  for (const source of input.sources) {
    insertSeedItemSource({
      seed_item_id: id,
      source_task_id: source.sourceTaskId,
      source_task_title: source.sourceTaskTitle,
      merge_commit: source.mergeCommit ?? null,
      added_at: input.updatedAt,
    });
  }
  recordEvent({
    event_type: 'seed_item_created',
    actor_type: 'system',
    project_id: input.project,
    payload: { seedItemId: id, milestone: input.milestone },
  });
  const item = getItem(id);
  if (!item) {
    throw new Error(`seed_item: failed to read back item ${id} after insert`);
  }
  return item;
}

/** Appends an immutable event (evidence carried by value, with provenance) to an item's history. */
export function appendEvent(seedItemId: string, event: SeedItemEvent): void {
  const row = getSeedItem(seedItemId);
  if (!row) {
    throw new Error(`seed_item: no item ${seedItemId} to append an event to`);
  }
  insertSeedItemEvent({
    seed_item_id: seedItemId,
    outcome: event.outcome,
    evidence: stringifyJson(event.evidence),
    filed_followon: event.filedFollowon ?? null,
    operator: event.operator ?? null,
    at: event.at,
  });
  recordEvent({
    event_type: 'seed_item_event_appended',
    actor_type: 'system',
    project_id: row.project,
    payload: { seedItemId, outcome: event.outcome },
  });
}

/**
 * Advances the single-field state — pending -> applied -> confirmed | blocked.
 * There is no current_disposition; the outcome lives on the event log.
 */
export function advanceState(
  seedItemId: string,
  state: SeedItemState,
  updatedAt: string,
): void {
  const row = getSeedItem(seedItemId);
  if (!row) {
    throw new Error(`seed_item: no item ${seedItemId} to advance`);
  }
  updateSeedItem({
    ...row,
    state,
    updated_at: updatedAt,
  });
  recordEvent({
    event_type: 'seed_item_state_changed',
    actor_type: 'system',
    project_id: row.project,
    payload: { seedItemId, from: row.state, to: state },
  });
}

/**
 * Sets the commit a deploy must contain for this item to become applyable —
 * filled at source-task merge, not at accretion.
 */
export function setMinDeployedCommit(
  seedItemId: string,
  minDeployedCommit: string,
  updatedAt: string,
): void {
  const row = getSeedItem(seedItemId);
  if (!row) {
    throw new Error(`seed_item: no item ${seedItemId} to set a commit on`);
  }
  updateSeedItemMinDeployedCommit(seedItemId, minDeployedCommit, updatedAt);
}

/** Attaches a new source to an existing item. Does not itself change item state. */
export function addSource(
  seedItemId: string,
  source: Omit<SeedItemSource, 'addedAt'>,
  addedAt: string,
): void {
  const row = getSeedItem(seedItemId);
  if (!row) {
    throw new Error(`seed_item: no item ${seedItemId} to add a source to`);
  }
  insertSeedItemSource({
    seed_item_id: seedItemId,
    source_task_id: source.sourceTaskId,
    source_task_title: source.sourceTaskTitle,
    merge_commit: source.mergeCommit ?? null,
    added_at: addedAt,
  });
  recordEvent({
    event_type: 'seed_item_source_added',
    actor_type: 'system',
    project_id: row.project,
    payload: { seedItemId, sourceTaskId: source.sourceTaskId },
  });
}

/** Records the source PR's merge commit — filled at source-task merge, not at accretion. */
export function setSourceMergeCommit(
  seedItemId: string,
  sourceTaskId: string,
  mergeCommit: string,
): void {
  const sources = listSeedItemSources(seedItemId);
  if (!sources.some((s) => s.source_task_id === sourceTaskId)) {
    throw new Error(
      `seed_item_source: no source ${sourceTaskId} on item ${seedItemId}`,
    );
  }
  updateSeedItemSourceMergeCommit(seedItemId, sourceTaskId, mergeCommit);
}

export interface SeedAccretionMarker {
  sourceTaskId: string;
  project: string;
  milestone: string;
  decision: SeedAccretionDecision;
  accretedAt: string;
}

/** Reads the per-source seed_accretion marker the promotion gate checks for. */
export function getAccretionMarker(
  sourceTaskId: string,
): SeedAccretionMarker | undefined {
  const row = getSeedAccretion(sourceTaskId);
  if (!row) return undefined;
  return {
    sourceTaskId: row.source_task_id,
    project: row.project,
    milestone: row.milestone,
    decision: row.decision,
    accretedAt: row.accreted_at,
  };
}

/**
 * Records (or replaces) the per-source seed_accretion marker — written once a
 * Code/Tooling task has either minted its config-change seeds onto the
 * milestone seed store ('seeds') or explicitly recorded that it has none
 * ('none') or is exempt ('n/a'). checkGroomingPromotionGate reads this before
 * allowing the task's Ready flip.
 */
export function recordAccretionMarker(marker: SeedAccretionMarker): void {
  upsertSeedAccretion({
    source_task_id: marker.sourceTaskId,
    project: marker.project,
    milestone: marker.milestone,
    decision: marker.decision,
    accreted_at: marker.accretedAt,
  });
}
