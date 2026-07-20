import crypto from 'crypto';
import { recordEvent } from '../audit/AuditLog';
import {
  getArchUnit,
  insertArchUnit,
  updateArchUnit,
  listArchUnitEvents,
  insertArchUnitEvent,
  queryArchUnits,
} from '../db/queries';
import type {
  ArchUnitKind,
  ArchUnitStatus,
  ArchUnitQuery,
  ArchUnitEventType,
} from '../db/types';

/**
 * Orchestrator-owned architecture-information store. A unit is a single
 * titled architecture statement (kind/topic/regions/status envelope + a
 * markdown body). Mirrors the gate_item/seed_item shape: envelope as typed
 * columns, prose as a markdown body, plus an append-only event log.
 *
 * Write authority: units are edited only through the command layer's
 * staged-apply path, never raw writes from sessions — this module is the
 * orchestrator's own read+write surface, not a session-callable API.
 */
export interface ArchUnit {
  id: string;
  title: string;
  kind: ArchUnitKind;
  topic: string;
  regions: string[];
  status: ArchUnitStatus;
  body: string;
  supersedes?: string;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArchUnitEvent {
  eventType: ArchUnitEventType;
  payload?: unknown;
  at: string;
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

function toArchUnit(row: {
  id: string;
  title: string;
  kind: ArchUnitKind;
  topic: string;
  regions: string;
  status: ArchUnitStatus;
  body: string;
  supersedes: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
}): ArchUnit {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    topic: row.topic,
    regions: JSON.parse(row.regions) as string[],
    status: row.status,
    body: row.body,
    supersedes: row.supersedes ?? undefined,
    supersededBy: row.superseded_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Full read of one unit. */
export function getUnit(id: string): ArchUnit | undefined {
  const row = getArchUnit(id);
  return row ? toArchUnit(row) : undefined;
}

/** History of a unit's changes, oldest first. */
export function getUnitEvents(id: string): ArchUnitEvent[] {
  return listArchUnitEvents(id).map((e) => ({
    eventType: e.event_type,
    payload: parseJson(e.payload),
    at: e.at,
  }));
}

export interface NewArchUnitInput {
  title: string;
  kind: ArchUnitKind;
  topic: string;
  regions: string[];
  status?: ArchUnitStatus;
  body: string;
  at: string;
}

/** Creates a fresh unit and appends a 'created' event. */
export function createUnit(input: NewArchUnitInput): ArchUnit {
  const id = crypto.randomUUID();
  insertArchUnit({
    id,
    title: input.title,
    kind: input.kind,
    topic: input.topic,
    regions: JSON.stringify(input.regions),
    status: input.status ?? 'active',
    body: input.body,
    supersedes: null,
    created_at: input.at,
    updated_at: input.at,
  });
  insertArchUnitEvent({
    arch_unit_id: id,
    event_type: 'created',
    payload: stringifyJson({ title: input.title, kind: input.kind }),
    at: input.at,
  });
  recordEvent({
    event_type: 'arch_unit_created',
    actor_type: 'system',
    payload: { archUnitId: id, kind: input.kind, topic: input.topic },
  });
  const unit = getUnit(id);
  if (!unit) {
    throw new Error(`arch_unit: failed to read back unit ${id} after insert`);
  }
  return unit;
}

export interface ArchUnitUpdateFields {
  title?: string;
  kind?: ArchUnitKind;
  topic?: string;
  regions?: string[];
  status?: ArchUnitStatus;
  body?: string;
}

/** Updates a unit's fields in place and appends an 'updated' event with the diff. */
export function updateUnit(
  id: string,
  fields: ArchUnitUpdateFields,
  at: string,
): ArchUnit {
  const row = getArchUnit(id);
  if (!row) {
    throw new Error(`arch_unit: no unit ${id} to update`);
  }
  const next = {
    ...row,
    title: fields.title ?? row.title,
    kind: fields.kind ?? row.kind,
    topic: fields.topic ?? row.topic,
    regions: fields.regions ? JSON.stringify(fields.regions) : row.regions,
    status: fields.status ?? row.status,
    body: fields.body ?? row.body,
    updated_at: at,
  };
  updateArchUnit(next);
  insertArchUnitEvent({
    arch_unit_id: id,
    event_type: 'updated',
    payload: stringifyJson({ before: fields, after: toArchUnit(next) }),
    at,
  });
  recordEvent({
    event_type: 'arch_unit_updated',
    actor_type: 'system',
    payload: { archUnitId: id, fields: Object.keys(fields) },
  });
  const unit = getUnit(id);
  if (!unit) {
    throw new Error(`arch_unit: failed to read back unit ${id} after update`);
  }
  return unit;
}

/**
 * Supersedes a unit — supersede-not-delete: the old unit is retained with
 * status='superseded' and superseded_by set; a new unit is created carrying
 * supersedes back to the old id.
 */
export function supersedeUnit(
  id: string,
  replacement: NewArchUnitInput,
  at: string,
): { previous: ArchUnit; next: ArchUnit } {
  const row = getArchUnit(id);
  if (!row) {
    throw new Error(`arch_unit: no unit ${id} to supersede`);
  }
  const newId = crypto.randomUUID();
  insertArchUnit({
    id: newId,
    title: replacement.title,
    kind: replacement.kind,
    topic: replacement.topic,
    regions: JSON.stringify(replacement.regions),
    status: replacement.status ?? 'active',
    body: replacement.body,
    supersedes: id,
    created_at: at,
    updated_at: at,
  });
  insertArchUnitEvent({
    arch_unit_id: newId,
    event_type: 'created',
    payload: stringifyJson({ supersedes: id }),
    at,
  });
  updateArchUnit({
    ...row,
    status: 'superseded',
    superseded_by: newId,
    updated_at: at,
  });
  insertArchUnitEvent({
    arch_unit_id: id,
    event_type: 'superseded',
    payload: stringifyJson({ supersededBy: newId }),
    at,
  });
  recordEvent({
    event_type: 'arch_unit_superseded',
    actor_type: 'system',
    payload: { archUnitId: id, supersededBy: newId },
  });
  const previous = getUnit(id);
  const next = getUnit(newId);
  if (!previous || !next) {
    throw new Error(`arch_unit: failed to read back units after supersede`);
  }
  return { previous, next };
}

/**
 * Query the active set by default (superseded excluded) filterable by
 * topic/kind/region/status — the read/query route's backing lookup.
 */
export function queryUnits(query: ArchUnitQuery = {}): ArchUnit[] {
  return queryArchUnits(query).map(toArchUnit);
}
