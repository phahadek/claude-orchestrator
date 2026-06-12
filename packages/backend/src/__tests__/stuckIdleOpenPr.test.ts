/**
 * Tests for stuck-idle-with-open-PR lifecycle: operator notification,
 * no terminal transition.
 *
 * When scanForStuckSessions() finds a stuck session that already has an open
 * PR, it must transition to 'idle' (not 'done') and broadcast
 * stuck_session_idle_open_pr instead of calling recoverSession().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../session/sessionRecovery', () => ({
  recoverSession: vi.fn(async () => {}),
}));

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(() => ({
    type: 'notion',
    fetchReadyTasks: vi.fn(async () => []),
    attachPR: vi.fn(async () => {}),
    updateStatus: vi.fn(async () => {}),
    fetchTaskPage: vi.fn(async () => ''),
    fetchNonMilestoneTasks: vi.fn(async () => []),
  })),
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../db/queries', async () => {
  const actual =
    await vi.importActual<typeof import('../db/queries')>('../db/queries');
  return {
    ...actual,
    getPRBySessionId: vi.fn(() => null),
    setPauseReason: vi.fn(),
    insertPauseInterval: vi.fn(),
    closePauseInterval: vi.fn(),
    upsertStuckSessionTimer: vi.fn(),
    deleteStuckSessionTimer: vi.fn(),
    getAllStuckSessionTimers: vi.fn(() => []),
  };
});

import { StuckSessionMonitor } from '../orchestration/StuckSessionMonitor';
import type { SessionManager } from '../session/SessionManager';
import { recoverSession } from '../session/sessionRecovery';
import * as queries from '../db/queries';
import { db } from '../db/db.js';
import type { PullRequestRow } from '../db/types';

function makeMockSessionManager(): SessionManager {
  const sm = new EventEmitter() as unknown as SessionManager;
  (sm as unknown as { send: ReturnType<typeof vi.fn> }).send = vi.fn();
  (sm as unknown as { kill: ReturnType<typeof vi.fn> }).kill = vi
    .fn()
    .mockResolvedValue(undefined);
  return sm;
}

function insertStuckSession(
  sessionId: string,
  projectId: string,
  ageMs: number,
  prUrl?: string,
): void {
  const startedAt = Date.now() - ageMs;
  const lastEventTs = startedAt + Math.floor(ageMs / 2);
  db.prepare(
    `INSERT INTO sessions (session_id, project_id, task_id, task_url, project_context_url,
       status, started_at, session_type, worktree_path, pr_url)
     VALUES (?, ?, 'task-1', 'https://notion.so/task', 'https://notion.so/ctx',
       'running', ?, 'standard', '/fake/wt', ?)`,
  ).run(sessionId, projectId, startedAt, prUrl ?? null);
  db.prepare(
    `INSERT INTO session_events (session_id, event_type, payload, timestamp)
     VALUES (?, 'system', '{"type":"result"}', ?)`,
  ).run(sessionId, lastEventTs);
}

function makeOpenPrRow(sessionId: string, prUrl: string): PullRequestRow {
  return {
    id: 1,
    pr_number: 99,
    pr_url: prUrl,
    task_id: 'task-1',
    session_id: sessionId,
    repo: 'owner/repo',
    title: 'feat: test',
    body: null,
    head_branch: 'feature/test',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: null,
    review_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T01:00:00Z',
    synced_at: '2024-01-01T01:00:00Z',
    review_session_id: null,
    review_iteration: 0,
    head_sha: 'abc123',
    last_reviewed_sha: null,
    node_id: null,
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
    pending_push: 0,
    pause_reason: null,
    pause_reason_set_at: null,
    ci_remediation_attempted_sha: null,
    failing_checks: null,
  };
}

beforeEach(() => {
  db.prepare('DELETE FROM session_events').run();
  db.prepare('DELETE FROM sessions').run();
  vi.clearAllMocks();
});

describe('StuckSessionMonitor.scanForStuckSessions() — idle+open-PR path', () => {
  it('transitions to idle (not done) when session has an open PR', async () => {
    const prUrl = 'https://github.com/owner/repo/pull/99';
    insertStuckSession('sess-idle-pr', 'proj-1', 10 * 60 * 1000, prUrl);

    vi.mocked(queries.getPRBySessionId).mockReturnValue(
      makeOpenPrRow('sess-idle-pr', prUrl),
    );

    const sm = makeMockSessionManager();
    const monitor = new StuckSessionMonitor(sm, vi.fn());
    await monitor.scanForStuckSessions();

    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('sess-idle-pr') as { status: string } | undefined;
    expect(row?.status).toBe('idle');
  });

  it('does not call recoverSession when session has an open PR', async () => {
    const prUrl = 'https://github.com/owner/repo/pull/99';
    insertStuckSession('sess-skip-recover', 'proj-1', 10 * 60 * 1000, prUrl);

    vi.mocked(queries.getPRBySessionId).mockReturnValue(
      makeOpenPrRow('sess-skip-recover', prUrl),
    );

    const sm = makeMockSessionManager();
    const monitor = new StuckSessionMonitor(sm, vi.fn());
    await monitor.scanForStuckSessions();

    expect(recoverSession).not.toHaveBeenCalled();
  });

  it('broadcasts stuck_session_idle_open_pr with sessionId, taskId, and prUrl', async () => {
    const prUrl = 'https://github.com/owner/repo/pull/99';
    insertStuckSession('sess-broadcast', 'proj-1', 10 * 60 * 1000, prUrl);

    vi.mocked(queries.getPRBySessionId).mockReturnValue(
      makeOpenPrRow('sess-broadcast', prUrl),
    );

    const broadcast = vi.fn();
    const sm = makeMockSessionManager();
    const monitor = new StuckSessionMonitor(sm, broadcast);
    await monitor.scanForStuckSessions();

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'stuck_session_idle_open_pr',
        sessionId: 'sess-broadcast',
        prUrl,
      }),
    );
  });

  it('falls through to done + recoverSession when session has no PR URL', async () => {
    insertStuckSession('sess-no-pr', 'proj-1', 10 * 60 * 1000);

    vi.mocked(queries.getPRBySessionId).mockReturnValue(null);

    const sm = makeMockSessionManager();
    const monitor = new StuckSessionMonitor(sm, vi.fn());
    await monitor.scanForStuckSessions();

    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('sess-no-pr') as { status: string } | undefined;
    expect(row?.status).toBe('done');
    expect(recoverSession).toHaveBeenCalledWith(
      'sess-no-pr',
      expect.objectContaining({ scope: 'periodic' }),
    );
  });

  it('falls through to done when PR exists but is not open (merged)', async () => {
    const prUrl = 'https://github.com/owner/repo/pull/99';
    insertStuckSession('sess-merged-pr', 'proj-1', 10 * 60 * 1000, prUrl);

    vi.mocked(queries.getPRBySessionId).mockReturnValue({
      ...makeOpenPrRow('sess-merged-pr', prUrl),
      state: 'merged',
    });

    const sm = makeMockSessionManager();
    const monitor = new StuckSessionMonitor(sm, vi.fn());
    await monitor.scanForStuckSessions();

    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('sess-merged-pr') as { status: string } | undefined;
    expect(row?.status).toBe('done');
    expect(recoverSession).toHaveBeenCalledWith(
      'sess-merged-pr',
      expect.objectContaining({ scope: 'periodic' }),
    );
  });

  it('falls through to done when pr_url is set but no PR row exists in DB', async () => {
    const prUrl = 'https://github.com/owner/repo/pull/99';
    insertStuckSession('sess-orphan-pr', 'proj-1', 10 * 60 * 1000, prUrl);

    // getPRBySessionId returns null (no pull_requests row)
    vi.mocked(queries.getPRBySessionId).mockReturnValue(null);

    const sm = makeMockSessionManager();
    const monitor = new StuckSessionMonitor(sm, vi.fn());
    await monitor.scanForStuckSessions();

    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('sess-orphan-pr') as { status: string } | undefined;
    expect(row?.status).toBe('done');
  });

  it('transitions to idle when PR is in pull_requests but sessions.pr_url is null (marker-PR race)', async () => {
    // Race: handlePRBodyMarker called upsertPullRequest but markSessionIdle hasn't run yet,
    // so sessions.pr_url is null while pull_requests has an open PR for this session.
    insertStuckSession('sess-race-pr', 'proj-1', 10 * 60 * 1000); // no pr_url in sessions

    const pr = makeOpenPrRow(
      'sess-race-pr',
      'https://github.com/owner/repo/pull/99',
    );
    vi.mocked(queries.getPRBySessionId).mockReturnValue(pr);

    const broadcast = vi.fn();
    const sm = makeMockSessionManager();
    const monitor = new StuckSessionMonitor(sm, broadcast);
    await monitor.scanForStuckSessions();

    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('sess-race-pr') as { status: string } | undefined;
    expect(row?.status).toBe('idle');
    expect(recoverSession).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'stuck_session_idle_open_pr',
        sessionId: 'sess-race-pr',
        prUrl: 'https://github.com/owner/repo/pull/99',
      }),
    );
  });

  it('handles draft PR state as open (transitions to idle)', async () => {
    const prUrl = 'https://github.com/owner/repo/pull/99';
    insertStuckSession('sess-draft-pr', 'proj-1', 10 * 60 * 1000, prUrl);

    vi.mocked(queries.getPRBySessionId).mockReturnValue({
      ...makeOpenPrRow('sess-draft-pr', prUrl),
      state: 'draft',
    });

    const sm = makeMockSessionManager();
    const monitor = new StuckSessionMonitor(sm, vi.fn());
    await monitor.scanForStuckSessions();

    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('sess-draft-pr') as { status: string } | undefined;
    expect(row?.status).toBe('idle');
    expect(recoverSession).not.toHaveBeenCalled();
  });
});
