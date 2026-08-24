/**
 * Tests for the awaiting-operator-decision state — extends the
 * isSessionAwaitingCapabilityDisposition precedent to any operator-only
 * question, not just a capability grant. See queries.ts's "awaiting-operator-
 * decision" section. Tracked in the session_operator_questions side table
 * (not new sessions columns — see that section's comment for why).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  insertSession,
  setSessionAwaitingOperatorDecision,
  clearSessionAwaitingOperatorDecision,
  getSessionOperatorQuestion,
  isSessionAwaitingOperatorDecision,
  isOperatorDecisionPastWindow,
  getSession,
  hasActiveSessionForTask,
} from '../queries.js';

beforeEach(() => {
  db.prepare('DELETE FROM session_operator_questions').run();
  db.prepare('DELETE FROM sessions').run();
});

function seedSession(sessionId: string, status = 'idle'): void {
  insertSession({
    session_id: sessionId,
    task_id: `task:${sessionId}`,
    task_url: null,
    project_context_url: null,
    status,
    started_at: 0,
    session_type: 'standard',
    task_name: null,
    metadata: null,
    review_result: null,
    pause_reason: null,
    last_error_detail: null,
    events_pruned_at: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    compaction_count: 0,
    context_occupancy_tokens: 0,
  } as never);
}

describe('awaiting-operator-decision state', () => {
  it('is retrievable from orchestrator state after being set — not only from an external surface', () => {
    seedSession('sess-1');
    setSessionAwaitingOperatorDecision(
      'sess-1',
      'Do you authorize migration 0112?',
      1000,
    );

    const pending = getSessionOperatorQuestion('sess-1');
    expect(pending).toEqual({
      question: 'Do you authorize migration 0112?',
      askedAt: 1000,
    });
  });

  it('is distinguishable from stalled_idle in the session row', () => {
    seedSession('sess-1');
    setSessionAwaitingOperatorDecision('sess-1', 'Question?', 1000);

    const row = getSession('sess-1')!;
    expect(row.pause_reason).not.toBe('stalled_idle');
    expect(getSessionOperatorQuestion('sess-1')?.question).toBe('Question?');
    expect(isSessionAwaitingOperatorDecision(row)).toBe(true);
  });

  it('returns null when no question is pending', () => {
    seedSession('sess-1');
    expect(getSessionOperatorQuestion('sess-1')).toBeNull();
    expect(isSessionAwaitingOperatorDecision(getSession('sess-1')!)).toBe(
      false,
    );
  });

  it('requires status idle — a running session with a pending question does not read as awaiting', () => {
    seedSession('sess-1', 'running');
    setSessionAwaitingOperatorDecision('sess-1', 'Question?', 1000);

    const row = getSession('sess-1')!;
    expect(isSessionAwaitingOperatorDecision(row)).toBe(false);
  });

  it('is discharged when the operator answers', () => {
    seedSession('sess-1');
    setSessionAwaitingOperatorDecision('sess-1', 'Question?', 1000);
    expect(isSessionAwaitingOperatorDecision(getSession('sess-1')!)).toBe(
      true,
    );

    clearSessionAwaitingOperatorDecision('sess-1');

    expect(getSessionOperatorQuestion('sess-1')).toBeNull();
    expect(isSessionAwaitingOperatorDecision(getSession('sess-1')!)).toBe(
      false,
    );
  });

  it('re-parking overwrites the previous question rather than accumulating rows', () => {
    seedSession('sess-1');
    setSessionAwaitingOperatorDecision('sess-1', 'First question?', 1000);
    setSessionAwaitingOperatorDecision('sess-1', 'Second question?', 2000);

    expect(getSessionOperatorQuestion('sess-1')).toEqual({
      question: 'Second question?',
      askedAt: 2000,
    });
  });

  it('isOperatorDecisionPastWindow is false within the window and true once elapsed', () => {
    seedSession('sess-1');
    setSessionAwaitingOperatorDecision('sess-1', 'Question?', 1000);

    expect(
      isOperatorDecisionPastWindow('sess-1', 60_000, 1000 + 30_000),
    ).toBe(false);
    expect(
      isOperatorDecisionPastWindow('sess-1', 60_000, 1000 + 60_001),
    ).toBe(true);
  });

  it('isOperatorDecisionPastWindow is false when nothing is pending', () => {
    seedSession('sess-1');
    expect(isOperatorDecisionPastWindow('sess-1', 60_000, 10_000_000)).toBe(
      false,
    );
  });

  it('a session awaiting an operator decision still reports as holding its task, with the reason retrievable rather than silent', () => {
    seedSession('sess-1');
    setSessionAwaitingOperatorDecision('sess-1', 'Question?', 1000);

    expect(hasActiveSessionForTask('task:sess-1')).toBe(true);
    // The "reason" is not silent — it's the retrievable pending question
    // itself, distinguishable from a plain idle/stalled park.
    expect(getSessionOperatorQuestion('sess-1')?.question).toBe('Question?');
  });
});
