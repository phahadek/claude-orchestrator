/**
 * Canonical-PR resolution: "oldest open wins". A task/session's canonical PR
 * is the oldest still-open row; only when nothing is open does the
 * highest-id (most recent terminal) row win. Guards against the old
 * "newest wins outright" behavior, which let a session's second PR (closed)
 * displace its still-open first PR — see the task's Context section.
 */

import { describe, it, expect, beforeEach } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { vi } from 'vitest';
import { db } from '../db.js';
import {
  getPRByNotionTaskId,
  getPRBySessionId,
  insertSession,
  markSessionIdle,
  markSessionDone,
  getSession,
} from '../queries.js';

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM pull_requests').run();
});

function insertPR(opts: {
  id: number;
  prNumber: number;
  taskId?: string | null;
  sessionId?: string | null;
  state: 'open' | 'merged' | 'closed';
}): void {
  const now = new Date(2024, 0, 1 + opts.id).toISOString();
  db.prepare(
    `INSERT INTO pull_requests
       (id, pr_number, pr_url, task_id, session_id, repo, state, created_at, updated_at, synced_at)
     VALUES (@id, @pr_number, @pr_url, @task_id, @session_id, 'owner/repo', @state, @now, @now, @now)`,
  ).run({
    id: opts.id,
    pr_number: opts.prNumber,
    pr_url: `https://github.com/owner/repo/pull/${opts.prNumber}`,
    task_id: opts.taskId ?? null,
    session_id: opts.sessionId ?? null,
    state: opts.state,
    now,
  });
}

describe('getPRByNotionTaskId — oldest open wins', () => {
  it('returns the older open row over a newer closed row', () => {
    insertPR({ id: 1, prNumber: 1756, taskId: 'task-1', state: 'open' });
    insertPR({ id: 2, prNumber: 1766, taskId: 'task-1', state: 'closed' });

    const result = getPRByNotionTaskId('task-1');
    expect(result?.pr_number).toBe(1756);
    expect(result?.state).toBe('open');
  });

  it('returns the lower-id row when two rows are both open', () => {
    insertPR({ id: 5, prNumber: 1800, taskId: 'task-2', state: 'open' });
    insertPR({ id: 3, prNumber: 1790, taskId: 'task-2', state: 'open' });

    const result = getPRByNotionTaskId('task-2');
    expect(result?.id).toBe(3);
    expect(result?.pr_number).toBe(1790);
  });

  it('returns the highest-id row when no row is open', () => {
    insertPR({ id: 1, prNumber: 1700, taskId: 'task-3', state: 'closed' });
    insertPR({ id: 2, prNumber: 1710, taskId: 'task-3', state: 'merged' });

    const result = getPRByNotionTaskId('task-3');
    expect(result?.id).toBe(2);
    expect(result?.pr_number).toBe(1710);
  });
});

describe('getPRBySessionId — same oldest-open-wins rules', () => {
  it('returns the older open row over a newer closed row', () => {
    insertPR({ id: 1, prNumber: 1756, sessionId: 'sess-1', state: 'open' });
    insertPR({ id: 2, prNumber: 1766, sessionId: 'sess-1', state: 'closed' });

    const result = getPRBySessionId('sess-1');
    expect(result?.pr_number).toBe(1756);
    expect(result?.state).toBe('open');
  });

  it('returns the lower-id row when two rows are both open', () => {
    insertPR({ id: 5, prNumber: 1800, sessionId: 'sess-2', state: 'open' });
    insertPR({ id: 3, prNumber: 1790, sessionId: 'sess-2', state: 'open' });

    const result = getPRBySessionId('sess-2');
    expect(result?.id).toBe(3);
  });

  it('returns the highest-id row when no row is open', () => {
    insertPR({ id: 1, prNumber: 1700, sessionId: 'sess-3', state: 'closed' });
    insertPR({ id: 2, prNumber: 1710, sessionId: 'sess-3', state: 'merged' });

    const result = getPRBySessionId('sess-3');
    expect(result?.id).toBe(2);
  });
});

describe('markSessionIdle / markSessionDone — pr_url write guard', () => {
  function makeSession(sessionId: string, storedPrUrl: string | null): void {
    insertSession({
      session_id: sessionId,
      task_id: 'task-1',
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });
    if (storedPrUrl) {
      db.prepare(
        `UPDATE sessions SET pr_url = @pr_url WHERE session_id = @session_id`,
      ).run({
        session_id: sessionId,
        pr_url: storedPrUrl,
      });
    }
  }

  it('does not overwrite sessions.pr_url while the stored PR row is open', () => {
    insertPR({
      id: 1,
      prNumber: 1756,
      sessionId: 'sess-idle-1',
      state: 'open',
    });
    makeSession('sess-idle-1', 'https://github.com/owner/repo/pull/1756');

    markSessionIdle(
      'sess-idle-1',
      Date.now(),
      'https://github.com/owner/repo/pull/1766',
    );

    expect(getSession('sess-idle-1')?.pr_url).toBe(
      'https://github.com/owner/repo/pull/1756',
    );
  });

  it('overwrites sessions.pr_url once the stored PR row is merged or closed', () => {
    insertPR({
      id: 1,
      prNumber: 1756,
      sessionId: 'sess-idle-2',
      state: 'closed',
    });
    makeSession('sess-idle-2', 'https://github.com/owner/repo/pull/1756');

    markSessionIdle(
      'sess-idle-2',
      Date.now(),
      'https://github.com/owner/repo/pull/1766',
    );

    expect(getSession('sess-idle-2')?.pr_url).toBe(
      'https://github.com/owner/repo/pull/1766',
    );
  });

  it('markSessionDone likewise does not overwrite an open stored PR', () => {
    insertPR({
      id: 1,
      prNumber: 1756,
      sessionId: 'sess-done-1',
      state: 'open',
    });
    makeSession('sess-done-1', 'https://github.com/owner/repo/pull/1756');

    markSessionDone(
      'sess-done-1',
      Date.now(),
      'https://github.com/owner/repo/pull/1766',
      'test',
      { skipInFlightGuard: true },
    );

    expect(getSession('sess-done-1')?.pr_url).toBe(
      'https://github.com/owner/repo/pull/1756',
    );
  });
});
