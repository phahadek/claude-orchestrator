/**
 * Tests for the architecture-information store (packages/backend/src/architecture/ArchUnitStore.ts).
 *
 * AC: arch_unit + arch_unit_event tables exist via forward migration; a unit
 * round-trips create -> read -> update -> supersede; each change appends an
 * event-log row; query-by-topic/kind/region/status returns the correct
 * active set with superseded excluded by default.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import {
  getUnit,
  getUnitEvents,
  createUnit,
  updateUnit,
  supersedeUnit,
  queryUnits,
} from '../ArchUnitStore.js';

beforeEach(() => {
  db.prepare('DELETE FROM arch_unit_event').run();
  db.prepare('DELETE FROM arch_unit').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('arch_unit schema', () => {
  it('creates the two tables', () => {
    const names = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('arch_unit','arch_unit_event')`,
      )
      .all() as { name: string }[];
    expect(names.map((r) => r.name).sort()).toEqual([
      'arch_unit',
      'arch_unit_event',
    ]);
  });
});

describe('createUnit / getUnit / updateUnit / supersedeUnit round-trip', () => {
  it('creates a unit, reads it back, and logs a created event', () => {
    const unit = createUnit({
      title: 'Session lifecycle',
      kind: 'subsystem',
      topic: 'sessions',
      regions: ['packages/backend/src/sessions'],
      body: '# Session lifecycle\nDescribes session states.',
      at: '2026-01-01T00:00:00Z',
    });

    expect(unit.status).toBe('active');
    expect(unit.regions).toEqual(['packages/backend/src/sessions']);

    const read = getUnit(unit.id);
    expect(read).toEqual(unit);

    const events = getUnitEvents(unit.id);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('created');
  });

  it('updates a unit and appends an updated event', () => {
    const unit = createUnit({
      title: 'Gate item shape',
      kind: 'invariant',
      topic: 'gate',
      regions: ['packages/backend/src/gate'],
      body: 'original body',
      at: '2026-01-01T00:00:00Z',
    });

    const updated = updateUnit(
      unit.id,
      { body: 'revised body', status: 'deferred' },
      '2026-01-02T00:00:00Z',
    );

    expect(updated.body).toBe('revised body');
    expect(updated.status).toBe('deferred');
    expect(updated.updatedAt).toBe('2026-01-02T00:00:00Z');

    const events = getUnitEvents(unit.id);
    expect(events.map((e) => e.eventType)).toEqual(['created', 'updated']);
  });

  it('supersedes a unit: old retained as superseded, new unit created linking back', () => {
    const original = createUnit({
      title: 'Old decision',
      kind: 'decision',
      topic: 'architecture-store',
      regions: ['packages/backend/src/architecture'],
      body: 'old decision body',
      at: '2026-01-01T00:00:00Z',
    });

    const { previous, next } = supersedeUnit(
      original.id,
      {
        title: 'New decision',
        kind: 'decision',
        topic: 'architecture-store',
        regions: ['packages/backend/src/architecture'],
        body: 'new decision body',
        at: '2026-01-03T00:00:00Z',
      },
      '2026-01-03T00:00:00Z',
    );

    expect(previous.status).toBe('superseded');
    expect(previous.supersededBy).toBe(next.id);
    expect(next.supersedes).toBe(original.id);
    expect(next.status).toBe('active');

    const oldEvents = getUnitEvents(original.id);
    expect(oldEvents.map((e) => e.eventType)).toEqual([
      'created',
      'superseded',
    ]);
    const newEvents = getUnitEvents(next.id);
    expect(newEvents.map((e) => e.eventType)).toEqual(['created']);
  });
});

describe('queryUnits', () => {
  beforeEach(() => {
    createUnit({
      title: 'Sessions subsystem',
      kind: 'subsystem',
      topic: 'sessions',
      regions: ['packages/backend/src/sessions'],
      body: 'a',
      at: '2026-01-01T00:00:00Z',
    });
    createUnit({
      title: 'Gate invariant',
      kind: 'invariant',
      topic: 'gate',
      regions: ['packages/backend/src/gate'],
      body: 'b',
      at: '2026-01-01T00:00:00Z',
    });
    const deferred = createUnit({
      title: 'Deferred reference',
      kind: 'reference',
      topic: 'gate',
      regions: ['packages/backend/src/gate'],
      status: 'deferred',
      body: 'c',
      at: '2026-01-01T00:00:00Z',
    });
    void deferred;
    const superseded = createUnit({
      title: 'Old contract',
      kind: 'contract',
      topic: 'sessions',
      regions: ['packages/backend/src/sessions'],
      body: 'd',
      at: '2026-01-01T00:00:00Z',
    });
    supersedeUnit(
      superseded.id,
      {
        title: 'New contract',
        kind: 'contract',
        topic: 'sessions',
        regions: ['packages/backend/src/sessions'],
        body: 'e',
        at: '2026-01-02T00:00:00Z',
      },
      '2026-01-02T00:00:00Z',
    );
  });

  it('returns the active set by default, excluding superseded', () => {
    const all = queryUnits();
    expect(all.every((u) => u.status !== 'superseded')).toBe(true);
    expect(all.map((u) => u.title).sort()).toEqual(
      [
        'Deferred reference',
        'Gate invariant',
        'New contract',
        'Sessions subsystem',
      ].sort(),
    );
  });

  it('filters by topic', () => {
    const gateUnits = queryUnits({ topic: 'gate' });
    expect(gateUnits.map((u) => u.title).sort()).toEqual([
      'Deferred reference',
      'Gate invariant',
    ]);
  });

  it('filters by kind', () => {
    const subsystems = queryUnits({ kind: 'subsystem' });
    expect(subsystems.map((u) => u.title)).toEqual(['Sessions subsystem']);
  });

  it('filters by region substring', () => {
    const sessionUnits = queryUnits({ region: 'sessions' });
    expect(sessionUnits.map((u) => u.title).sort()).toEqual(
      ['New contract', 'Sessions subsystem'].sort(),
    );
  });

  it('filters by status explicitly, including superseded when requested', () => {
    const deferredOnly = queryUnits({ status: 'deferred' });
    expect(deferredOnly.map((u) => u.title)).toEqual(['Deferred reference']);

    const supersededOnly = queryUnits({ status: 'superseded' });
    expect(supersededOnly.map((u) => u.title)).toEqual(['Old contract']);
  });

  it('includes superseded when includeSuperseded is set with no status filter', () => {
    const all = queryUnits({ includeSuperseded: true });
    expect(all.some((u) => u.status === 'superseded')).toBe(true);
  });
});
