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
  if (
    !(err instanceof Error) ||
    !/UNIQUE constraint failed/i.test(err.message)
  ) {
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

/**
 * The reservation a given task holds for one specific *(new)* migration
 * placeholder entry, identified by (dir, suffix) — the same idempotency key
 * `reserveMigrationNumber` allocates against. The review-gate dimension
 * override (PRReviewService.ts) reads this to get the entry's authoritative
 * reserved number, independent of whichever number the entry's raw text
 * currently carries.
 */
export function getReservationForTaskDirSuffix(
  taskId: string,
  dir: string,
  suffix: string,
): MigrationReservation | undefined {
  const row = getMigrationReservationByTaskDirSuffix(taskId, dir, suffix);
  return row ? toReservation(row) : undefined;
}

/**
 * Marker embedded in a migration-number-reassignment report.file intent's
 * evidence_text (see stagedIntents.ts's report.file apply case) so a
 * committed investigation_report row can be recognized as this claim kind
 * downstream — e.g. investigationReconciler.ts's dispatch tick skips
 * auto-dispatching an investigate session onto one, since the claim was
 * already mechanically re-derived against the live reservation table at
 * file time and needs only operator disposition, not further investigation.
 */
export const MIGRATION_REASSIGNMENT_REPORT_MARKER =
  'claimKind: migration-number-reassignment';

export interface MigrationReassignmentClaim {
  project: string;
  taskId: string;
  /** The number the reservation table shows for this task's reservation, per the filing session's claim. */
  expectedNumber: number;
  /** The number the task's migration actually shipped as, per the filing session's claim. */
  actualNumber: number;
}

export interface MigrationReassignmentVerdict {
  confirmed: boolean;
  reason: string;
}

/**
 * Authoritative re-derivation for a filed migration-number-reassignment
 * claim (report.file with claimKind 'migration-number-reassignment' — see
 * stagedIntents.ts's report.file apply case). Independently re-checks the
 * claim against the live reservation table rather than trusting the filing
 * session's own arithmetic, mirroring PRReviewService.ts's
 * applyMigrationReservationOverride precedent of never trusting an LLM's
 * self-reported number. A claim only stays visible for operator disposition
 * when this confirms it; otherwise it is auto-dismissed and the discrepancy
 * is recorded in the returned reason.
 *
 * Two independent checks, both required to confirm:
 *  1. Stale-claim check: the task's live reservation must still show
 *     `expectedNumber` — a claim filed against a reservation that has since
 *     moved on (e.g. already reassigned by an earlier disposition) is stale.
 *  2. Collision check: `actualNumber` must not already be claimed by a
 *     *different* task's live reservation — reassigning onto an
 *     already-taken number would just create a new collision.
 *  3. Genuine-next-free-number check: absent an outright collision,
 *     `actualNumber` must not leap beyond the project's current allocation
 *     frontier (max reserved number + 1) — a claim proposing an
 *     unallocated, non-adjacent number isn't a legitimate renumber, it's a
 *     fabrication.
 */
export function rederiveMigrationReassignment(
  claim: MigrationReassignmentClaim,
): MigrationReassignmentVerdict {
  const existing = getReservationForTask(claim.taskId);
  if (!existing) {
    return {
      confirmed: false,
      reason: `task ${claim.taskId} holds no migration reservation — nothing to reassign`,
    };
  }
  if (existing.number !== claim.expectedNumber) {
    return {
      confirmed: false,
      reason: `task ${claim.taskId}'s live reservation is ${existing.number}, not the claimed expectedNumber ${claim.expectedNumber} — stale claim`,
    };
  }

  const collision = getReservationByNumber(claim.project, claim.actualNumber);
  if (collision && collision.taskId !== claim.taskId) {
    return {
      confirmed: false,
      reason: `actualNumber ${claim.actualNumber} is already reserved by a different task (${collision.taskId}) — reassigning would collide`,
    };
  }

  if (!collision) {
    const currentMax = getMaxMigrationReservationNumber(claim.project) ?? 0;
    if (claim.actualNumber > currentMax + 1) {
      return {
        confirmed: false,
        reason: `actualNumber ${claim.actualNumber} exceeds the project's current allocation frontier (max reserved is ${currentMax}) — not a genuine next-free number`,
      };
    }
  }

  return {
    confirmed: true,
    reason: `confirmed: task ${claim.taskId}'s reservation reassigns from ${claim.expectedNumber} to ${claim.actualNumber} — no collision, within the allocation frontier`,
  };
}
