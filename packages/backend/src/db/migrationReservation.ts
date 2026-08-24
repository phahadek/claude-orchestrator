import crypto from 'crypto';
import { db } from './db';
import { recordEvent } from '../audit/AuditLog';
import {
  getMaxMigrationReservationNumber,
  insertMigrationReservation,
  insertMigrationReservationEvent,
  getMigrationReservationByTask,
  getMigrationReservationByTaskDirSuffix,
  getMigrationReservationByNumber,
} from './queries';
import type { MigrationReservationRow } from './types';

/**
 * Orchestrator-owned migration-number ledger. One row per (project, number)
 * pair, allocated at Ready-flip apply time (see stagedIntents.ts's
 * commitGroupIntents) for the task whose `## Files / paths affected`
 * *(new)* migration entry claimed it. Mirrors the arch_unit/gate_item
 * shape: a materialized current-state row per reservation, plus an
 * append-only event log for its history.
 *
 * Write authority: reservations are made only from the Ready-flip apply
 * path, never a session-callable API — this module is the orchestrator's
 * own read+write surface.
 */
export interface MigrationReservation {
  id: string;
  /** Owning project's registry id — numbering is per-project (per-repo). */
  project: string;
  number: number;
  taskId: string;
  /** Migration directory the number was claimed within, e.g. `packages/backend/migrations/`. */
  dir: string;
  /** Filename suffix (everything after the leading number and underscore). */
  suffix: string;
  createdAt: string;
  updatedAt: string;
}

function toReservation(row: MigrationReservationRow): MigrationReservation {
  return {
    id: row.id,
    project: row.project,
    number: row.number,
    taskId: row.task_id,
    dir: row.dir,
    suffix: row.suffix,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * better-sqlite3 surfaces a UNIQUE violation with the offending column names
 * in the message (e.g. "UNIQUE constraint failed: migration_reservation.task_id,
 * migration_reservation.dir, migration_reservation.suffix") — classified here
 * so the two constraints on migration_reservation get two different
 * remedies: a (project, number) collision means "the number is taken, try
 * the next one"; a (task_id, dir, suffix) collision means "someone else
 * already reserved this exact placeholder, read their reservation back"
 * (see reserveMigrationNumber).
 */
function classifyUniqueConstraintError(
  err: unknown,
): 'project_number' | 'task_placeholder' | 'other' {
  if (!(err instanceof Error) || !/UNIQUE constraint failed/i.test(err.message)) {
    return 'other';
  }
  if (/migration_reservation\.task_id/i.test(err.message)) {
    return 'task_placeholder';
  }
  if (/migration_reservation\.project/i.test(err.message)) {
    return 'project_number';
  }
  return 'other';
}

export interface ReserveMigrationNumberInput {
  project: string;
  taskId: string;
  dir: string;
  suffix: string;
  at: string;
}

/** Bounded retry ceiling for the UNIQUE-constraint backstop — see reserveMigrationNumber. */
const MAX_RESERVE_ATTEMPTS = 20;

/**
 * Allocates the next free migration number for a project and durably
 * reserves it for taskId, idempotent per (taskId, dir, suffix) — a task
 * that already holds a reservation for that exact placeholder entry gets it
 * back rather than a second number, while a second distinct *(new)*
 * migration entry on the same task still gets its own.
 *
 * Concurrent-write safety: reading the current max and writing the new row
 * happens with no `await` anywhere in between (this function is fully
 * synchronous, same as every better-sqlite3 call it makes) — the same
 * no-await-between-read-and-write guarantee the tasks.yaml write path
 * relies on (see SessionManager's pendingStarts reservation). That's the
 * primary safety net for same-process concurrent Ready-flip applies; the
 * table's two UNIQUE constraints are the backstop for any writer outside
 * that guarantee (e.g. a second process sharing the same sqlite file), and
 * each gets a different remedy on collision: UNIQUE(project, number) means
 * a sibling allocation beat this one to that number, so this retries with
 * the next one; UNIQUE(task_id, dir, suffix) means a sibling allocation for
 * this *exact* placeholder landed between this call's initial existence
 * check and its own insert, so this reads that reservation back and returns
 * it rather than minting (and silently orphaning) a second number for the
 * same placeholder.
 */
export function reserveMigrationNumber(
  input: ReserveMigrationNumberInput,
): MigrationReservation {
  const existing = getMigrationReservationByTaskDirSuffix(
    input.taskId,
    input.dir,
    input.suffix,
  );
  if (existing) return toReservation(existing);

  for (let attempt = 0; attempt < MAX_RESERVE_ATTEMPTS; attempt++) {
    const currentMax = getMaxMigrationReservationNumber(input.project);
    const number = (currentMax ?? 0) + 1;
    const id = crypto.randomUUID();
    try {
      db.transaction(() => {
        insertMigrationReservation({
          id,
          project: input.project,
          number,
          task_id: input.taskId,
          dir: input.dir,
          suffix: input.suffix,
          created_at: input.at,
          updated_at: input.at,
        });
        insertMigrationReservationEvent({
          migration_reservation_id: id,
          event_type: 'reserved',
          payload: JSON.stringify({ number, taskId: input.taskId }),
          at: input.at,
        });
      })();
    } catch (err) {
      const kind = classifyUniqueConstraintError(err);
      if (kind === 'project_number') continue;
      if (kind === 'task_placeholder') {
        const race = getMigrationReservationByTaskDirSuffix(
          input.taskId,
          input.dir,
          input.suffix,
        );
        if (race) return toReservation(race);
      }
      throw err;
    }
    recordEvent({
      event_type: 'migration_reservation_reserved',
      actor_type: 'system',
      project_id: input.project,
      task_id: input.taskId,
      payload: { number, dir: input.dir, suffix: input.suffix },
    });
    return {
      id,
      project: input.project,
      number,
      taskId: input.taskId,
      dir: input.dir,
      suffix: input.suffix,
      createdAt: input.at,
      updatedAt: input.at,
    };
  }
  throw new Error(
    `migration_reservation: failed to allocate a number for project ${input.project} after ${MAX_RESERVE_ATTEMPTS} attempts`,
  );
}

/** The reservation a given task currently holds, if any (a task claims at most one number). */
export function getReservationForTask(
  taskId: string,
): MigrationReservation | undefined {
  const row = getMigrationReservationByTask(taskId);
  return row ? toReservation(row) : undefined;
}

/** The reservation holding a given (project, number) pair, if any — the live-truth lookup a review-gate override validates against. */
export function getReservationByNumber(
  project: string,
  number: number,
): MigrationReservation | undefined {
  const row = getMigrationReservationByNumber(project, number);
  return row ? toReservation(row) : undefined;
}
