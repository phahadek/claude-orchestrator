import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import { insertSession, getSession } from '../db/queries.js';
import { runBootIdleReconciliation } from '../session/bootIdleReconciliation.js';

function makeSession(
  sessionId: string,
  status: string,
  prUrl: string | null = null,
): void {
  insertSession({
    session_id: sessionId,
    task_id: null,
    task_url: null,
    project_context_url: null,
    project_id: null,
    status: status as 'running',
    started_at: Date.now() - 60_000,
    ended_at: null,
    pr_url: prUrl,
    worktree_path: '/worktrees/w1/feature/test',
    session_type: 'standard',
    task_name: null,
  });
}

function makePRRow(
  prNumber: number,
  sessionId: string | null,
  state: 'merged' | 'closed' | 'open',
  repo = 'owner/repo',
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO pull_requests
       (pr_number, pr_url, task_id, session_id, repo, title, body,
        head_branch, base_branch, state, draft,
        created_at, updated_at, synced_at)
     VALUES (?, ?, NULL, ?, ?, 'feat: test', NULL,
             'feature/test', 'dev', ?, 0, ?, ?, ?)`,
  ).run(
    prNumber,
    `https://github.com/${repo}/pull/${prNumber}`,
    sessionId,
    repo,
    state,
    now,
    now,
    now,
  );
}

beforeEach(() => {
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM pull_requests');
});

describe('runBootIdleReconciliation', () => {
  it('transitions idle session with merged PR to done', () => {
    makeSession(
      'sess-merged-1',
      'idle',
      'https://github.com/owner/repo/pull/10',
    );
    makePRRow(10, 'sess-merged-1', 'merged');

    runBootIdleReconciliation();

    expect(getSession('sess-merged-1')?.status).toBe('done');
  });

  it('transitions idle session with closed PR to error', () => {
    makeSession(
      'sess-closed-1',
      'idle',
      'https://github.com/owner/repo/pull/20',
    );
    makePRRow(20, 'sess-closed-1', 'closed');

    runBootIdleReconciliation();

    expect(getSession('sess-closed-1')?.status).toBe('error');
  });

  it('does not touch running sessions with merged PR', () => {
    makeSession(
      'sess-running',
      'running',
      'https://github.com/owner/repo/pull/30',
    );
    makePRRow(30, 'sess-running', 'merged');

    runBootIdleReconciliation();

    expect(getSession('sess-running')?.status).toBe('running');
  });

  it('does not touch idle sessions with open PR', () => {
    makeSession(
      'sess-open-pr',
      'idle',
      'https://github.com/owner/repo/pull/40',
    );
    makePRRow(40, 'sess-open-pr', 'open');

    runBootIdleReconciliation();

    expect(getSession('sess-open-pr')?.status).toBe('idle');
  });

  it('does not touch idle sessions with no PR row', () => {
    makeSession('sess-no-pr', 'idle');

    runBootIdleReconciliation();

    expect(getSession('sess-no-pr')?.status).toBe('idle');
  });

  it('does not touch already-terminal sessions (done)', () => {
    makeSession('sess-done', 'done', 'https://github.com/owner/repo/pull/50');
    makePRRow(50, 'sess-done', 'merged');

    runBootIdleReconciliation();

    expect(getSession('sess-done')?.status).toBe('done');
  });

  it('does not touch already-terminal sessions (error)', () => {
    makeSession('sess-error', 'error', 'https://github.com/owner/repo/pull/60');
    makePRRow(60, 'sess-error', 'closed');

    runBootIdleReconciliation();

    expect(getSession('sess-error')?.status).toBe('error');
  });

  it('handles multiple sessions in one pass', () => {
    makeSession(
      'sess-multi-m',
      'idle',
      'https://github.com/owner/repo/pull/70',
    );
    makeSession(
      'sess-multi-c',
      'idle',
      'https://github.com/owner/repo/pull/71',
    );
    makePRRow(70, 'sess-multi-m', 'merged');
    makePRRow(71, 'sess-multi-c', 'closed');

    runBootIdleReconciliation();

    expect(getSession('sess-multi-m')?.status).toBe('done');
    expect(getSession('sess-multi-c')?.status).toBe('error');
  });

  it('sets ended_at when transitioning merged idle session to done', () => {
    makeSession(
      'sess-ended-at',
      'idle',
      'https://github.com/owner/repo/pull/80',
    );
    makePRRow(80, 'sess-ended-at', 'merged');

    runBootIdleReconciliation();

    expect(getSession('sess-ended-at')?.ended_at).not.toBeNull();
  });

  it('is a no-op when no idle sessions with resolved PRs exist', () => {
    makeSession('sess-unrelated', 'idle');

    expect(() => runBootIdleReconciliation()).not.toThrow();
  });
});
