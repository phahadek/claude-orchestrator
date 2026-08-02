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
  foldOpsTransitionChain,
  InvalidOpsTransitionChainError,
} from '../opsJournal.js';
import {
  upsertOpsJournalEntry,
  getCapabilityDisqualification,
} from '../../db/queries.js';
import { recordDisqualification } from '../../audit/capabilityDispositionMining.js';

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

  it('allows candidate -> resolved directly (Investigation with no applied change)', () => {
    expect(isValidOpsTransition('candidate', 'resolved')).toBe(true);
  });

  it('allows staged-proposal -> resolved directly (the no-change terminal — a proposal that concludes no change is needed)', () => {
    expect(isValidOpsTransition('staged-proposal', 'resolved')).toBe(true);
  });

  it('still rejects pending -> resolved (an entry never worked cannot be closed)', () => {
    expect(isValidOpsTransition('pending', 'resolved')).toBe(false);
  });

  it('every pre-existing allowed transition still holds', () => {
    expect(isValidOpsTransition('pending', 'candidate')).toBe(true);
    expect(isValidOpsTransition('pending', 'blocked')).toBe(true);
    expect(isValidOpsTransition('pending', 'incident-frozen')).toBe(true);
    expect(isValidOpsTransition('candidate', 'staged-proposal')).toBe(true);
    expect(isValidOpsTransition('candidate', 'pending')).toBe(true);
    expect(isValidOpsTransition('candidate', 'blocked')).toBe(true);
    expect(isValidOpsTransition('candidate', 'incident-frozen')).toBe(true);
    expect(
      isValidOpsTransition('staged-proposal', 'applied-pending-confirm'),
    ).toBe(true);
    expect(isValidOpsTransition('staged-proposal', 'candidate')).toBe(true);
    expect(isValidOpsTransition('staged-proposal', 'blocked')).toBe(true);
    expect(isValidOpsTransition('staged-proposal', 'incident-frozen')).toBe(
      true,
    );
    expect(isValidOpsTransition('applied-pending-confirm', 'resolved')).toBe(
      true,
    );
    expect(
      isValidOpsTransition('applied-pending-confirm', 'staged-proposal'),
    ).toBe(true);
    expect(isValidOpsTransition('applied-pending-confirm', 'blocked')).toBe(
      true,
    );
    expect(
      isValidOpsTransition('applied-pending-confirm', 'incident-frozen'),
    ).toBe(true);
    expect(isValidOpsTransition('blocked', 'pending')).toBe(true);
    expect(isValidOpsTransition('blocked', 'candidate')).toBe(true);
    expect(isValidOpsTransition('blocked', 'staged-proposal')).toBe(true);
    expect(isValidOpsTransition('blocked', 'applied-pending-confirm')).toBe(
      true,
    );
    expect(isValidOpsTransition('blocked', 'incident-frozen')).toBe(true);
    expect(isValidOpsTransition('blocked', 'resolved')).toBe(true);
    expect(isValidOpsTransition('incident-frozen', 'pending')).toBe(true);
    expect(isValidOpsTransition('incident-frozen', 'candidate')).toBe(true);
    expect(isValidOpsTransition('incident-frozen', 'staged-proposal')).toBe(
      true,
    );
    expect(
      isValidOpsTransition('incident-frozen', 'applied-pending-confirm'),
    ).toBe(true);
    expect(isValidOpsTransition('incident-frozen', 'blocked')).toBe(true);
    expect(isValidOpsTransition('incident-frozen', 'resolved')).toBe(true);
  });

  it('resolved remains terminal (its transition list stays empty)', () => {
    expect(isValidOpsTransition('resolved', 'pending')).toBe(false);
    expect(isValidOpsTransition('resolved', 'candidate')).toBe(false);
    expect(isValidOpsTransition('resolved', 'staged-proposal')).toBe(false);
    expect(isValidOpsTransition('resolved', 'applied-pending-confirm')).toBe(
      false,
    );
    expect(isValidOpsTransition('resolved', 'blocked')).toBe(false);
    expect(isValidOpsTransition('resolved', 'incident-frozen')).toBe(false);
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

describe('setEntryState resolves a capability disqualification', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM capability_disqualification').run();
  });

  it('lifts the disqualification when the resolution declares "lifted"', () => {
    seedEntry('investigation-1', { state: 'candidate' });
    recordDisqualification(
      {
        projectId: 'polimarket-analyser',
        capability: 'Bash(sqlite3:*)',
        denialCount: 5,
        taskIds: ['task-1', 'task-2'],
      },
      'investigation-1',
      new Date(0).toISOString(),
    );

    setEntryState('investigation-1', 'resolved', {
      resolution: { capabilityDisqualificationVerdict: 'lifted' },
    });

    const row = getCapabilityDisqualification(
      'polimarket-analyser',
      'Bash(sqlite3:*)',
    );
    expect(row?.state).toBe('lifted');
    expect(row?.lifted_at).toBeTruthy();
  });

  it('hardens the disqualification when the resolution declares "hardened"', () => {
    seedEntry('investigation-2', { state: 'candidate' });
    recordDisqualification(
      {
        projectId: 'polimarket-analyser',
        capability: 'Bash(curl:*)',
        denialCount: 5,
        taskIds: ['task-1', 'task-2'],
      },
      'investigation-2',
      new Date(0).toISOString(),
    );

    setEntryState('investigation-2', 'resolved', {
      resolution: { capabilityDisqualificationVerdict: 'hardened' },
    });

    const row = getCapabilityDisqualification(
      'polimarket-analyser',
      'Bash(curl:*)',
    );
    expect(row?.state).toBe('hardened');
    expect(row?.lifted_at).toBeNull();
  });

  it('is a no-op for a resolved task not tied to a disqualification', () => {
    seedEntry('plain-investigation', { state: 'candidate' });
    expect(() =>
      setEntryState('plain-investigation', 'resolved', {
        resolution: { summary: 'nothing capability-related here' },
      }),
    ).not.toThrow();
  });
});

describe('foldOpsTransitionChain', () => {
  it('returns the starting state unchanged for an empty chain', () => {
    expect(foldOpsTransitionChain('pending', [])).toBe('pending');
  });

  it('folds a legal multi-hop chain to its final state', () => {
    expect(
      foldOpsTransitionChain('pending', ['candidate', 'resolved']),
    ).toBe('resolved');
  });

  it('folds a single legal hop', () => {
    expect(foldOpsTransitionChain('pending', ['candidate'])).toBe(
      'candidate',
    );
  });

  it('throws when a hop in the chain is illegal from the state the prior hop produced', () => {
    expect(() =>
      foldOpsTransitionChain('pending', [
        'candidate',
        'applied-pending-confirm',
      ]),
    ).toThrow(InvalidOpsTransitionChainError);
  });

  it('throws naming the illegal hop, not the chain start', () => {
    try {
      foldOpsTransitionChain('pending', ['candidate', 'applied-pending-confirm']);
      throw new Error('expected foldOpsTransitionChain to throw');
    } catch (err) {
      expect((err as Error).message).toContain(
        'candidate -> applied-pending-confirm',
      );
    }
  });
});
