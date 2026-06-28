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
  sessionType = 'standard',
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
    session_type: sessionType as 'standard',
    task_name: null,
  });
}

function makePRRow(
  prNumber: number,
  sessionId: string | null,
  state: 'merged' | 'closed' | 'open',
  repo = 'owner/repo',
  reviewSessionId: string | null = null,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO pull_requests
       (pr_number, pr_url, task_id, session_id, review_session_id, repo, title, body,
        head_branch, base_branch, state, draft,
        created_at, updated_at, synced_at)
     VALUES (?, ?, NULL, ?, ?, ?, 'feat: test', NULL,
             'feature/test', 'dev', ?, 0, ?, ?, ?)`,
  ).run(
    prNumber,
    `https://github.com/${repo}/pull/${prNumber}`,
    sessionId,
    reviewSessionId,
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

  it('marks running sessions as error (dead at boot) even with merged PR', () => {
    makeSession(
      'sess-running',
      'running',
      'https://github.com/owner/repo/pull/30',
    );
    makePRRow(30, 'sess-running', 'merged');

    runBootIdleReconciliation();

    expect(getSession('sess-running')?.status).toBe('error');
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

describe('runBootIdleReconciliation — pass 2: idle review sessions', () => {
  it('transitions idle review session to done when coding session is done', () => {
    makeSession('code-sess', 'done');
    makeSession('review-sess', 'idle', null, 'review');
    makePRRow(100, 'code-sess', 'open', 'owner/repo', 'review-sess');

    runBootIdleReconciliation();

    expect(getSession('review-sess')?.status).toBe('done');
  });

  it('transitions idle review session to error when coding session is error', () => {
    makeSession('code-sess', 'error');
    makeSession('review-sess', 'idle', null, 'review');
    makePRRow(101, 'code-sess', 'open', 'owner/repo', 'review-sess');

    runBootIdleReconciliation();

    expect(getSession('review-sess')?.status).toBe('error');
  });

  it('transitions idle review session to error when coding session is killed', () => {
    makeSession('code-sess', 'killed');
    makeSession('review-sess', 'idle', null, 'review');
    makePRRow(102, 'code-sess', 'open', 'owner/repo', 'review-sess');

    runBootIdleReconciliation();

    expect(getSession('review-sess')?.status).toBe('error');
  });

  it('transitions idle review session to done when PR is merged (no terminal coding session)', () => {
    makeSession('review-sess', 'idle', null, 'review');
    makePRRow(103, null, 'merged', 'owner/repo', 'review-sess');

    runBootIdleReconciliation();

    expect(getSession('review-sess')?.status).toBe('done');
  });

  it('transitions idle review session to error when PR is closed (no terminal coding session)', () => {
    makeSession('review-sess', 'idle', null, 'review');
    makePRRow(104, null, 'closed', 'owner/repo', 'review-sess');

    runBootIdleReconciliation();

    expect(getSession('review-sess')?.status).toBe('error');
  });

  it('does not touch review session when coding session is idle (open PR)', () => {
    makeSession('code-sess', 'idle');
    makeSession('review-sess', 'idle', null, 'review');
    makePRRow(105, 'code-sess', 'open', 'owner/repo', 'review-sess');

    runBootIdleReconciliation();

    expect(getSession('review-sess')?.status).toBe('idle');
  });

  it('does not touch already-terminal review session', () => {
    makeSession('code-sess', 'done');
    makeSession('review-sess', 'done', null, 'review');
    makePRRow(106, 'code-sess', 'open', 'owner/repo', 'review-sess');

    runBootIdleReconciliation();

    expect(getSession('review-sess')?.status).toBe('done');
  });

  it('sets ended_at when transitioning idle review session to done', () => {
    makeSession('code-sess', 'done');
    makeSession('review-sess-ea', 'idle', null, 'review');
    makePRRow(107, 'code-sess', 'open', 'owner/repo', 'review-sess-ea');

    runBootIdleReconciliation();

    expect(getSession('review-sess-ea')?.ended_at).not.toBeNull();
  });

  it('both passes run: idle coding session with merged PR AND idle review session both get transitioned', () => {
    makeSession('code-sess', 'idle', 'https://github.com/owner/repo/pull/108');
    makeSession('review-sess', 'idle', null, 'review');
    makePRRow(108, 'code-sess', 'merged', 'owner/repo', 'review-sess');

    runBootIdleReconciliation();

    // Pass 1 transitions the coding session (idle + merged → done),
    // then pass 2 sees coding session as done → review session → done.
    expect(getSession('code-sess')?.status).toBe('done');
    expect(getSession('review-sess')?.status).toBe('done');
  });

  it('running coding session at boot becomes error and cascades to idle review session', () => {
    makeSession('code-sess', 'running');
    makeSession('review-sess', 'idle', null, 'review');
    makePRRow(109, 'code-sess', 'open', 'owner/repo', 'review-sess');

    runBootIdleReconciliation();

    // Pass 0: running coding session → error
    expect(getSession('code-sess')?.status).toBe('error');
    // Pass 2: idle review with terminal coding session → error
    expect(getSession('review-sess')?.status).toBe('error');
  });
});

describe('runBootIdleReconciliation — pass 0: dead sessions at boot', () => {
  it('marks a coding session at starting as error', () => {
    makeSession('sess-starting', 'starting');

    runBootIdleReconciliation();

    expect(getSession('sess-starting')?.status).toBe('error');
  });

  it('marks a coding session at running as error', () => {
    makeSession('sess-running-boot', 'running');

    runBootIdleReconciliation();

    expect(getSession('sess-running-boot')?.status).toBe('error');
  });

  it('marks a review session at starting as error', () => {
    makeSession('review-starting', 'starting', null, 'review');

    runBootIdleReconciliation();

    expect(getSession('review-starting')?.status).toBe('error');
  });

  it('marks a review session at running as error', () => {
    makeSession('review-running', 'running', null, 'review');

    runBootIdleReconciliation();

    expect(getSession('review-running')?.status).toBe('error');
  });

  it('sets ended_at when marking a running session as error', () => {
    makeSession('sess-ea-running', 'running');

    runBootIdleReconciliation();

    expect(getSession('sess-ea-running')?.ended_at).not.toBeNull();
  });

  it('does not touch idle sessions', () => {
    makeSession('sess-idle-boot', 'idle');

    runBootIdleReconciliation();

    expect(getSession('sess-idle-boot')?.status).toBe('idle');
  });

  it('does not touch already-terminal sessions (done)', () => {
    makeSession('sess-done-boot', 'done');

    runBootIdleReconciliation();

    expect(getSession('sess-done-boot')?.status).toBe('done');
  });

  it('does not touch already-terminal sessions (error)', () => {
    makeSession('sess-error-boot', 'error');

    runBootIdleReconciliation();

    expect(getSession('sess-error-boot')?.status).toBe('error');
  });

  it('does not touch already-terminal sessions (killed)', () => {
    makeSession('sess-killed-boot', 'killed');

    runBootIdleReconciliation();

    expect(getSession('sess-killed-boot')?.status).toBe('killed');
  });

  it('handles multiple dead sessions in one pass', () => {
    makeSession('sess-boot-a', 'starting');
    makeSession('sess-boot-b', 'running');

    runBootIdleReconciliation();

    expect(getSession('sess-boot-a')?.status).toBe('error');
    expect(getSession('sess-boot-b')?.status).toBe('error');
  });
});
