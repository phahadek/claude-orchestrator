/**
 * Tests for the migration-number reservation store
 * (packages/backend/src/db/migrationReservation.ts).
 *
 * AC: migration_reservation + migration_reservation_event tables exist via
 * forward migration; numbers allocate sequentially per project; a task
 * re-reserving the same (dir, suffix) placeholder gets the same number back
 * rather than a new one; two concurrently-applying Ready-flip groups for the
 * same project can never both reserve the same number.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import * as queries from '../queries.js';
import {
  reserveMigrationNumber,
  getReservationForTask,
  getReservationByNumber,
} from '../migrationReservation.js';

beforeEach(() => {
  vi.restoreAllMocks();
  db.prepare('DELETE FROM migration_reservation_event').run();
  db.prepare('DELETE FROM migration_reservation').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('migration_reservation schema', () => {
  it('creates the two tables', () => {
    const names = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('migration_reservation','migration_reservation_event')`,
      )
      .all() as { name: string }[];
    expect(names.map((r) => r.name).sort()).toEqual([
      'migration_reservation',
      'migration_reservation_event',
    ]);
  });
});

describe('reserveMigrationNumber', () => {
  it('allocates sequential numbers per project, starting at 1', () => {
    const first = reserveMigrationNumber({
      project: 'proj-1',
      taskId: 'notion:task-a',
      dir: 'packages/backend/migrations/',
      suffix: 'add_thing.sql',
      at: '2026-01-01T00:00:00Z',
    });
    const second = reserveMigrationNumber({
      project: 'proj-1',
      taskId: 'notion:task-b',
      dir: 'packages/backend/migrations/',
      suffix: 'add_other_thing.sql',
      at: '2026-01-01T00:00:01Z',
    });

    expect(first.number).toBe(1);
    expect(second.number).toBe(2);
  });

  it('numbers a second project independently, starting at 1 again', () => {
    reserveMigrationNumber({
      project: 'proj-1',
      taskId: 'notion:task-a',
      dir: 'packages/backend/migrations/',
      suffix: 'add_thing.sql',
      at: '2026-01-01T00:00:00Z',
    });
    const otherProject = reserveMigrationNumber({
      project: 'proj-2',
      taskId: 'notion:task-c',
      dir: 'packages/backend/migrations/',
      suffix: 'add_thing.sql',
      at: '2026-01-01T00:00:00Z',
    });

    expect(otherProject.number).toBe(1);
  });

  it('is idempotent per (taskId, dir, suffix) — a re-reservation of the same placeholder returns the same number', () => {
    const first = reserveMigrationNumber({
      project: 'proj-1',
      taskId: 'notion:task-a',
      dir: 'packages/backend/migrations/',
      suffix: 'add_thing.sql',
      at: '2026-01-01T00:00:00Z',
    });
    const again = reserveMigrationNumber({
      project: 'proj-1',
      taskId: 'notion:task-a',
      dir: 'packages/backend/migrations/',
      suffix: 'add_thing.sql',
      at: '2026-01-01T00:00:05Z',
    });

    expect(again.number).toBe(first.number);
    expect(again.id).toBe(first.id);
    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM migration_reservation')
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('gives a task two distinct *(new)* migration entries two distinct numbers', () => {
    const first = reserveMigrationNumber({
      project: 'proj-1',
      taskId: 'notion:task-multi',
      dir: 'packages/backend/migrations/',
      suffix: 'add_thing.sql',
      at: '2026-01-01T00:00:00Z',
    });
    const second = reserveMigrationNumber({
      project: 'proj-1',
      taskId: 'notion:task-multi',
      dir: 'packages/backend/migrations/',
      suffix: 'add_other_thing.sql',
      at: '2026-01-01T00:00:01Z',
    });

    expect(second.number).not.toBe(first.number);
  });

  it('appends a reserved event and an audit_log row for each allocation', () => {
    const reservation = reserveMigrationNumber({
      project: 'proj-1',
      taskId: 'notion:task-a',
      dir: 'packages/backend/migrations/',
      suffix: 'add_thing.sql',
      at: '2026-01-01T00:00:00Z',
    });

    const events = db
      .prepare(
        'SELECT * FROM migration_reservation_event WHERE migration_reservation_id = ?',
      )
      .all(reservation.id) as { event_type: string }[];
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('reserved');

    const auditRows = db
      .prepare(
        "SELECT * FROM audit_log WHERE event_type = 'migration_reservation_reserved'",
      )
      .all() as { task_id: string | null }[];
    expect(auditRows).toHaveLength(1);
  });

  it('never lets two concurrently-applying Ready-flip groups for the same project reserve the same number', async () => {
    const [a, b] = await Promise.all([
      Promise.resolve().then(() =>
        reserveMigrationNumber({
          project: 'proj-race',
          taskId: 'notion:task-race-a',
          dir: 'packages/backend/migrations/',
          suffix: 'add_thing.sql',
          at: '2026-01-01T00:00:00Z',
        }),
      ),
      Promise.resolve().then(() =>
        reserveMigrationNumber({
          project: 'proj-race',
          taskId: 'notion:task-race-b',
          dir: 'packages/backend/migrations/',
          suffix: 'add_other_thing.sql',
          at: '2026-01-01T00:00:00Z',
        }),
      ),
    ]);

    expect(a.number).not.toBe(b.number);
    expect(new Set([a.number, b.number]).size).toBe(2);
  });

  it('retries past a UNIQUE(project, number) collision instead of surfacing it to the caller', () => {
    // Simulate a race window: getMaxMigrationReservationNumber answers as if
    // no reservation exists yet for this project, even though number 1 was
    // already committed a moment earlier by a different allocation — the
    // UNIQUE constraint backstop this test exercises.
    reserveMigrationNumber({
      project: 'proj-collide',
      taskId: 'notion:task-first',
      dir: 'packages/backend/migrations/',
      suffix: 'first.sql',
      at: '2026-01-01T00:00:00Z',
    });

    const spy = vi
      .spyOn(queries, 'getMaxMigrationReservationNumber')
      .mockReturnValueOnce(0);

    const second = reserveMigrationNumber({
      project: 'proj-collide',
      taskId: 'notion:task-second',
      dir: 'packages/backend/migrations/',
      suffix: 'second.sql',
      at: '2026-01-01T00:00:01Z',
    });

    expect(second.number).toBe(2);
    spy.mockRestore();
  });

  it('idempotently returns the existing reservation on a (task_id, dir, suffix) race instead of minting a second number', () => {
    // Simulate a race window: a first call already committed a reservation
    // for this exact placeholder, but the idempotency existence check
    // answers as if none exists yet — the UNIQUE(task_id, dir, suffix)
    // backstop this test exercises. Without it, this would silently mint a
    // second, different number for the same *(new)* migration entry.
    const first = reserveMigrationNumber({
      project: 'proj-placeholder-race',
      taskId: 'notion:task-race-same',
      dir: 'packages/backend/migrations/',
      suffix: 'same.sql',
      at: '2026-01-01T00:00:00Z',
    });

    const spy = vi
      .spyOn(queries, 'getMigrationReservationByTaskDirSuffix')
      .mockReturnValueOnce(undefined);

    const second = reserveMigrationNumber({
      project: 'proj-placeholder-race',
      taskId: 'notion:task-race-same',
      dir: 'packages/backend/migrations/',
      suffix: 'same.sql',
      at: '2026-01-01T00:00:01Z',
    });

    expect(second.id).toBe(first.id);
    expect(second.number).toBe(first.number);
    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM migration_reservation WHERE task_id = ?')
      .get('notion:task-race-same') as { n: number };
    expect(rows.n).toBe(1);
    spy.mockRestore();
  });
});

describe('getReservationForTask / getReservationByNumber', () => {
  it('reads back a reservation by task id and by (project, number)', () => {
    const reservation = reserveMigrationNumber({
      project: 'proj-1',
      taskId: 'notion:task-a',
      dir: 'packages/backend/migrations/',
      suffix: 'add_thing.sql',
      at: '2026-01-01T00:00:00Z',
    });

    expect(getReservationForTask('notion:task-a')).toEqual(reservation);
    expect(getReservationByNumber('proj-1', reservation.number)).toEqual(
      reservation,
    );
    expect(getReservationByNumber('proj-1', 999)).toBeUndefined();
  });
});
