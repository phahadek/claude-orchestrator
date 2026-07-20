/**
 * Tests for the ops_journal backend store (packages/backend/src/ops/opsJournal.ts).
 *
 * AC: setEntryState walks an entry through each state and rejects an invalid
 * transition; reconcileJournal drops Done/Deferred/removed entries and
 * preserves worked fields for still-open tasks; the full worked-field set
 * round-trips through the store helpers.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import {
  getEntry,
  setEntryState,
  reconcileJournal,
  isValidOpsTransition,
} from '../opsJournal.js';
import { upsertOpsJournalEntry } from '../../db/queries.js';

beforeEach(() => {
  db.prepare('DELETE FROM ops_journal').run();
  db.prepare('DELETE FROM audit_log').run();
});

function seedEntry(
  taskId: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  upsertOpsJournalEntry({
    task_id: taskId,
    project: 'polimarket-analyser',
    milestone: 'M12',
    state: 'pending',
    disposition: null,
    worked_in: null,
    evidence: null,
    finding_or_proposal: null,
    falsification: null,
    filed_followons: null,
    needs_from_operator: null,
    resolution: null,
    updated_at: new Date(0).toISOString(),
    ...overrides,
  } as any);
}

describe('ops_journal table', () => {
  it('table exists in the schema', () => {
    const row = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='ops_journal'`,
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('ops_journal');
  });
});

describe('setEntryState', () => {
  it('moves an entry through each state along the primary progression', () => {
    seedEntry('task-1');

    setEntryState('task-1', 'candidate');
    expect(getEntry('task-1')?.state).toBe('candidate');

    setEntryState('task-1', 'staged-proposal');
    expect(getEntry('task-1')?.state).toBe('staged-proposal');

    setEntryState('task-1', 'applied-pending-confirm');
    expect(getEntry('task-1')?.state).toBe('applied-pending-confirm');

    setEntryState('task-1', 'resolved', { resolution: { outcome: 'fixed' } });
    const final = getEntry('task-1');
    expect(final?.state).toBe('resolved');
    expect(final?.resolution).toEqual({ outcome: 'fixed' });
  });

  it('allows freeze states (blocked / incident-frozen) from and back to any open state', () => {
    seedEntry('task-2');
    setEntryState('task-2', 'blocked');
    expect(getEntry('task-2')?.state).toBe('blocked');
    setEntryState('task-2', 'candidate');
    expect(getEntry('task-2')?.state).toBe('candidate');
    setEntryState('task-2', 'incident-frozen');
    expect(getEntry('task-2')?.state).toBe('incident-frozen');
    setEntryState('task-2', 'staged-proposal');
    expect(getEntry('task-2')?.state).toBe('staged-proposal');
  });

  it('rejects an invalid transition (e.g. pending -> applied-pending-confirm)', () => {
    seedEntry('task-3');
    expect(() => setEntryState('task-3', 'applied-pending-confirm')).toThrow(
      /invalid transition/,
    );
    expect(getEntry('task-3')?.state).toBe('pending');
  });

  it('rejects any transition out of resolved (terminal)', () => {
    seedEntry('task-4', { state: 'resolved' });
    expect(() => setEntryState('task-4', 'pending')).toThrow(
      /invalid transition/,
    );
  });

  it('throws when the entry does not exist', () => {
    expect(() => setEntryState('missing-task', 'candidate')).toThrow(
      /no entry/,
    );
  });
});

describe('isValidOpsTransition', () => {
  it('allows self-transitions (idempotent set)', () => {
    expect(isValidOpsTransition('candidate', 'candidate')).toBe(true);
  });

  it('disallows resolved -> resolved-adjacent skips like resolved -> candidate', () => {
    expect(isValidOpsTransition('resolved', 'candidate')).toBe(false);
  });
});

describe('worked-field round-trip', () => {
  it('an ops_journal row round-trips the full worked-field set through the store helpers', () => {
    seedEntry('task-5');
    setEntryState('task-5', 'candidate', {
      workedIn: { branch: 'feature/x' },
      evidence: ['log line 1', 'log line 2'],
      findingOrProposal: { summary: 'looks fine' },
      falsification: { attempted: true, result: 'not falsified' },
      filedFollowons: ['task-99'],
      needsFromOperator: 'confirm deploy window',
      disposition: 'pass',
    });

    const entry = getEntry('task-5');
    expect(entry).toBeDefined();
    expect(entry?.workedIn).toEqual({ branch: 'feature/x' });
    expect(entry?.evidence).toEqual(['log line 1', 'log line 2']);
    expect(entry?.findingOrProposal).toEqual({ summary: 'looks fine' });
    expect(entry?.falsification).toEqual({
      attempted: true,
      result: 'not falsified',
    });
    expect(entry?.filedFollowons).toEqual(['task-99']);
    expect(entry?.needsFromOperator).toBe('confirm deploy window');
    expect(entry?.disposition).toBe('pass');
  });
});

describe('reconcileJournal', () => {
  it('drops entries for tasks no longer on the live board (Done/Deferred/removed)', () => {
    seedEntry('still-open');
    seedEntry('now-done');
    reconcileJournal([
      {
        taskId: 'still-open',
        project: 'polimarket-analyser',
        milestone: 'M12',
      },
    ]);
    expect(getEntry('still-open')).toBeDefined();
    expect(getEntry('now-done')).toBeUndefined();
  });

  it('preserves worked fields for still-open tasks across reconcile', () => {
    seedEntry('still-open', {
      state: 'staged-proposal',
      evidence: JSON.stringify(['proof']),
      finding_or_proposal: JSON.stringify({ summary: 'proposal text' }),
    });
    reconcileJournal([
      {
        taskId: 'still-open',
        project: 'polimarket-analyser',
        milestone: 'M12',
      },
    ]);
    const entry = getEntry('still-open');
    expect(entry?.state).toBe('staged-proposal');
    expect(entry?.evidence).toEqual(['proof']);
    expect(entry?.findingOrProposal).toEqual({ summary: 'proposal text' });
  });

  it('seeds newly-eligible tasks at state "pending"', () => {
    reconcileJournal([
      { taskId: 'new-task', project: 'polimarket-analyser', milestone: 'M12' },
    ]);
    const entry = getEntry('new-task');
    expect(entry?.state).toBe('pending');
    expect(entry?.project).toBe('polimarket-analyser');
    expect(entry?.milestone).toBe('M12');
  });
});
