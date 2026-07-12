import { randomUUID } from 'crypto';
import { recordEvent } from '../audit/AuditLog';
import {
  getGateItem,
  listGateItemsByMilestone,
  insertGateItem,
  updateGateItem,
  listGateItemSources,
  insertGateItemSource,
  listGateItemEvents,
  insertGateItemEvent,
  updateGateItemSourceMergeCommit,
} from '../db/queries';
import type { GateItemClassification } from '../db/types';

interface GateItemSource {
  sourceTaskId: string;
  sourceTaskTitle: string;
  mergeCommit?: string;
  addedAt: string;
}

export interface GateItemEvent {
  disposition: string;
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
      disposition: e.disposition,
      evidence: parseJson(e.evidence),
      filedFollowon: e.filed_followon ?? undefined,
      deploySha: e.deploy_sha ?? undefined,
      operator: e.operator ?? undefined,
      at: e.at,
    })),
  };
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
  const id = randomUUID();
  insertGateItem({
    id,
    project: input.project,
    milestone: input.milestone,
    text: input.text,
    classification: input.classification,
    min_deployed_commit: null,
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
    disposition: event.disposition,
    evidence: stringifyJson(event.evidence),
    filed_followon: event.filedFollowon ?? null,
    deploy_sha: event.deploySha ?? null,
    operator: event.operator ?? null,
    at: event.at,
  });
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

/** Records the source PR's merge commit — filled at source-task merge, not at accretion. */
export function setSourceMergeCommit(
  gateItemId: string,
  sourceTaskId: string,
  mergeCommit: string,
): void {
  const sources = listGateItemSources(gateItemId);
  if (!sources.some((s) => s.source_task_id === sourceTaskId)) {
    throw new Error(
      `gate_item_source: no source ${sourceTaskId} on item ${gateItemId}`,
    );
  }
  updateGateItemSourceMergeCommit(gateItemId, sourceTaskId, mergeCommit);
}
