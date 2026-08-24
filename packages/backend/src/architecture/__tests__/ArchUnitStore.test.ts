/**
 * Tests for the architecture-information store (packages/backend/src/architecture/ArchUnitStore.ts).
 *
 * AC: arch_unit + arch_unit_event tables exist via forward migration; a unit
 * round-trips create -> read -> update -> supersede; each change appends an
 * event-log row; query-by-topic/kind/region/status returns the correct
 * active set with superseded excluded by default.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import * as queries from '../../db/queries.js';
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
      project: 'proj-1',
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
      project: 'proj-1',
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

  it('retains the genuine pre-edit body in the updated event payload, distinct from the post-edit body', () => {
    const unit = createUnit({
      project: 'proj-1',
      title: 'Gate item shape',
      kind: 'invariant',
      topic: 'gate',
      regions: ['packages/backend/src/gate'],
      body: 'original body',
      at: '2026-01-01T00:00:00Z',
    });

    updateUnit(
      unit.id,
      { body: 'revised body' },
      '2026-01-02T00:00:00Z',
    );

    const events = getUnitEvents(unit.id);
    const updatedEvent = events.find((e) => e.eventType === 'updated');
    const payload = updatedEvent?.payload as {
      before: { body: string; version: number };
      after: { body: string; version: number };
    };

    expect(payload.before.body).toBe('original body');
    expect(payload.after.body).toBe('revised body');
    expect(payload.before.body).not.toBe(payload.after.body);
    expect(payload.before).not.toBe(payload.after);
    // before must reflect the version the intent staged against (baseVersion), not the post-edit version.
    expect(payload.before.version).toBe(unit.version);
    expect(payload.after.version).toBe(unit.version + 1);
  });

  it('supersedes a unit: old retained as superseded, new unit created linking back', () => {
    const original = createUnit({
      project: 'proj-1',
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
        project: 'proj-1',
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

  it('retains the genuine pre-supersede state in the superseded event payload', () => {
    const original = createUnit({
      project: 'proj-1',
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
        project: 'proj-1',
        title: 'New decision',
        kind: 'decision',
        topic: 'architecture-store',
        regions: ['packages/backend/src/architecture'],
        body: 'new decision body',
        at: '2026-01-03T00:00:00Z',
      },
      '2026-01-03T00:00:00Z',
    );

    const oldEvents = getUnitEvents(original.id);
    const supersededEvent = oldEvents.find((e) => e.eventType === 'superseded');
    const payload = supersededEvent?.payload as {
      before: { body: string; status: string; version: number };
      after: { body: string; status: string; version: number };
    };

    expect(payload.before.body).toBe('old decision body');
    expect(payload.after.body).toBe('old decision body');
    expect(payload.before.status).toBe('active');
    expect(payload.after.status).toBe('superseded');
    expect(payload.before).not.toBe(payload.after);
    expect(payload.before.version).toBe(original.version);
    expect(payload.after.version).toBe(previous.version);
    expect(next.supersedes).toBe(original.id);
  });
});

describe('atomicity of multi-statement writes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rolls back the whole createUnit apply when the event insert throws', () => {
    vi.spyOn(queries, 'insertArchUnitEvent').mockImplementation(() => {
      throw new Error('simulated mid-sequence failure');
    });

    expect(() =>
      createUnit({
        project: 'proj-1',
        title: 'Should not persist',
        kind: 'subsystem',
        topic: 'sessions',
        regions: [],
        body: 'body',
        at: '2026-01-01T00:00:00Z',
      }),
    ).toThrow('simulated mid-sequence failure');

    const rows = db.prepare('SELECT * FROM arch_unit').all();
    expect(rows).toHaveLength(0);
  });

  it('rolls back the whole updateUnit apply when recordEvent throws', () => {
    const unit = createUnit({
      project: 'proj-1',
      title: 'Original title',
      kind: 'subsystem',
      topic: 'sessions',
      regions: [],
      body: 'original body',
      at: '2026-01-01T00:00:00Z',
    });

    vi.spyOn(queries, 'insertArchUnitEvent').mockImplementation(() => {
      throw new Error('simulated mid-sequence failure');
    });

    expect(() =>
      updateUnit(unit.id, { body: 'revised body' }, '2026-01-02T00:00:00Z'),
    ).toThrow('simulated mid-sequence failure');

    const persisted = getUnit(unit.id);
    expect(persisted?.body).toBe('original body');
    expect(persisted?.version).toBe(1);
    const events = getUnitEvents(unit.id);
    expect(events).toHaveLength(1);
  });

  it('rolls back the whole supersedeUnit apply when the second event insert throws', () => {
    const original = createUnit({
      project: 'proj-1',
      title: 'Old decision',
      kind: 'decision',
      topic: 'architecture-store',
      regions: [],
      body: 'old decision body',
      at: '2026-01-01T00:00:00Z',
    });

    const realInsertArchUnitEvent = queries.insertArchUnitEvent;
    let calls = 0;
    vi.spyOn(queries, 'insertArchUnitEvent').mockImplementation((row) => {
      calls += 1;
      if (calls === 2) {
        throw new Error('simulated mid-sequence failure');
      }
      return realInsertArchUnitEvent(row);
    });

    expect(() =>
      supersedeUnit(
        original.id,
        {
          project: 'proj-1',
          title: 'New decision',
          kind: 'decision',
          topic: 'architecture-store',
          regions: [],
          body: 'new decision body',
          at: '2026-01-03T00:00:00Z',
        },
        '2026-01-03T00:00:00Z',
      ),
    ).toThrow('simulated mid-sequence failure');

    const rows = db
      .prepare('SELECT * FROM arch_unit WHERE id != ?')
      .all(original.id);
    expect(rows).toHaveLength(0);
    const persisted = getUnit(original.id);
    expect(persisted?.status).toBe('active');
    expect(persisted?.version).toBe(1);
  });
});

describe('queryUnits', () => {
  beforeEach(() => {
    createUnit({
      project: 'proj-1',
      title: 'Sessions subsystem',
      kind: 'subsystem',
      topic: 'sessions',
      regions: ['packages/backend/src/sessions'],
      body: 'a',
      at: '2026-01-01T00:00:00Z',
    });
    createUnit({
      project: 'proj-1',
      title: 'Gate invariant',
      kind: 'invariant',
      topic: 'gate',
      regions: ['packages/backend/src/gate'],
      body: 'b',
      at: '2026-01-01T00:00:00Z',
    });
    const deferred = createUnit({
      project: 'proj-1',
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
      project: 'proj-1',
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
        project: 'proj-1',
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

describe('project scoping', () => {
  it('stamps a created unit with its project and filters queryUnits by project', () => {
    createUnit({
      project: 'proj-a',
      title: 'Proj A unit',
      kind: 'subsystem',
      topic: 'x',
      regions: [],
      body: 'body',
      at: '2026-01-01T00:00:00Z',
    });
    createUnit({
      project: 'proj-b',
      title: 'Proj B unit',
      kind: 'subsystem',
      topic: 'x',
      regions: [],
      body: 'body',
      at: '2026-01-01T00:00:00Z',
    });

    const projA = queryUnits({ project: 'proj-a' });
    expect(projA.map((u) => u.title)).toEqual(['Proj A unit']);

    const all = queryUnits();
    expect(all.map((u) => u.title).sort()).toEqual(
      ['Proj A unit', 'Proj B unit'].sort(),
    );
  });
});
