/**
 * Tests for OrphanedTaskSweeper.
 *
 * Verifies:
 * - Clean orphan revert: In Progress task with no live session → reverted to Ready
 * - Anti-race skip: task whose latest session started < 5 min ago → skipped
 * - Already-failed skip: task whose latest session is error|killed → skipped
 * - No-task-id edge case: tasks with empty id → skipped
 * - recordEvent and broadcast fire on revert
 * - Idle session → sendOrResume nudge, no task revert, worktree intact
 * - Nudge limit: after NUDGE_LIMIT nudges → operator surface (setSessionPauseReason), no revert
 * - Missing worktree → operator surface immediately
 * - Open PR → still skipped (unchanged)
 * - Non-Code In-Progress task with no session → not reverted, not nudged (type filter)
 * - Failed-launch Code task (latestSession === undefined) → still reverts to Ready
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ────────────────────────────────────────────────────────────

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
  },
}));

vi.mock('../db/queries.js', () => ({
  getLatestCodeSessionByNotionTaskId: vi.fn(),
  hasActiveSessionForTask: vi.fn(),
  getPRBySessionId: vi.fn(() => null),
  getLocalBranchBySession: vi.fn(() => undefined),
  setSessionPauseReason: vi.fn(),
  getLatestSessionEventTimestamp: vi.fn(() => null),
  upsertPullRequest: vi.fn(() => null),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
  countNudgeEvents: vi.fn(() => 0),
  getLatestNudgeTimestamp: vi.fn(() => null),
  countNudgeEventsSince: vi.fn(() => 0),
}));

vi.mock('../config.js', () => ({
  getAllProjects: vi.fn(),
  GITHUB_REPO: 'owner/repo',
  runtimeSettings: {
    auto_launch_poll_interval_ms: 60_000,
  },
}));

import fs from 'node:fs';
import {
  getLatestCodeSessionByNotionTaskId,
  hasActiveSessionForTask,
  getPRBySessionId,
  getLocalBranchBySession,
  setSessionPauseReason,
  getLatestSessionEventTimestamp,
  upsertPullRequest,
} from '../db/queries.js';
import {
  recordEvent,
  countNudgeEvents,
  getLatestNudgeTimestamp,
  countNudgeEventsSince,
} from '../audit/AuditLog.js';
import { getAllProjects } from '../config.js';
import { OrphanedTaskSweeper } from '../orchestration/OrphanedTaskSweeper.js';
import type { ServerMessage } from '../ws/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(id: string, status = '🔄 In Progress', type = '💻 Code') {
  return {
    task: {
      id,
      title: 'Test Task',
      status,
      type,
      dependsOn: [],
      notionUrl: '',
    },
    source: 'notion' as const,
    blocked: false,
    blockers: [],
    nonCode: false,
    wave: 0,
  };
}

function makeBackend(tasks: ReturnType<typeof makeTask>[]) {
  return {
    type: 'notion' as const,
    fetchReadyTasks: vi.fn(),
    attachPR: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    fetchTaskPage: vi.fn(),
    fetchNonMilestoneReadyTasks: vi.fn(),
    updateNotes: vi.fn(),
    appendImplementationNote: vi.fn(),
    listTasksByStatus: vi.fn().mockResolvedValue(tasks),
  };
}

function makeSession(
  status: string,
  startedAtOffsetMs: number,
  endedAt?: number,
  worktreePath?: string | null,
  archived = 0,
) {
  const started_at = Date.now() - startedAtOffsetMs;
  return {
    session_id: 'sess-1',
    task_id: 'notion:abc',
    project_id: 'proj-1',
    status,
    started_at,
    ended_at: endedAt ?? null,
    session_type: 'standard',
    worktree_path: worktreePath !== undefined ? worktreePath : '/fake/worktree',
    archived,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OrphanedTaskSweeper', () => {
  let broadcast: ReturnType<typeof vi.fn<[ServerMessage], void>>;

  beforeEach(() => {
    broadcast = vi.fn();
    vi.mocked(getAllProjects).mockReturnValue([
      { id: 'proj-1', name: 'P1' } as ReturnType<typeof getAllProjects>[number],
    ]);
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(undefined);
    vi.mocked(hasActiveSessionForTask).mockReturnValue(false);
    vi.mocked(getPRBySessionId).mockReturnValue(null);
    vi.mocked(getLocalBranchBySession).mockReturnValue(undefined);
    vi.mocked(setSessionPauseReason).mockClear();
    vi.mocked(recordEvent).mockClear();
    vi.mocked(countNudgeEvents).mockReturnValue(0);
    vi.mocked(getLatestSessionEventTimestamp).mockReturnValue(null);
    vi.mocked(getLatestNudgeTimestamp).mockReturnValue(null);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(upsertPullRequest).mockClear();
    broadcast.mockClear();
  });

  it('reverts a clean orphan (In Progress, no session)', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(backend.updateStatus).toHaveBeenCalledWith('notion:abc', '🗂️ Ready');
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'task_orphan_reverted',
        actor_type: 'system',
        project_id: 'proj-1',
        task_id: 'notion:abc',
      }),
    );
    expect(broadcast).toHaveBeenCalledWith({
      type: 'task_status_changed',
      notionTaskId: 'notion:abc',
      newStatus: '🗂️ Ready',
    });
  });

  it('skips tasks whose latest session started < 5 minutes ago (anti-race)', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    // Session started 2 minutes ago
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('done', 2 * 60 * 1000) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('reverts tasks whose latest session is error (terminal — falls through to revert)', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('error', 10 * 60 * 1000) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    // error/killed sessions are terminal — they skip the anti-race window and fall through
    // to revert so the task can be re-dispatched.
    expect(backend.updateStatus).toHaveBeenCalledWith('notion:abc', '🗂️ Ready');
  });

  it('reverts tasks whose latest session is killed (terminal — falls through to revert)', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('killed', 10 * 60 * 1000) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(backend.updateStatus).toHaveBeenCalledWith('notion:abc', '🗂️ Ready');
  });

  it('skips tasks with an active (running) session', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    vi.mocked(hasActiveSessionForTask).mockReturnValue(true);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(backend.updateStatus).not.toHaveBeenCalled();
  });

  it('skips tasks with no task id', async () => {
    const backend = makeBackend([makeTask('')]);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('deduplicates tasks across projects (Notion backend shared)', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
        { id: 'proj-2' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    // Should only revert once despite two projects returning the same task
    expect(backend.updateStatus).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledTimes(1);
  });

  it('reverts an orphan after > 5 minutes and uses lastSeenAt from ended_at', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    const endedAt = Date.now() - 30 * 60 * 1000;
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue({
      ...makeSession('done', 60 * 60 * 1000, endedAt),
    } as ReturnType<typeof getLatestCodeSessionByNotionTaskId>);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(backend.updateStatus).toHaveBeenCalledWith('notion:abc', '🗂️ Ready');
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ lastSeenAt: endedAt }),
      }),
    );
  });

  // AC4: merged-PR guard — do NOT revert to Ready when the PR is merged/closed
  it('marks Done (not Ready) when the latest session has a merged GitHub PR', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('done', 10 * 60 * 1000) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    vi.mocked(getPRBySessionId).mockReturnValue({
      id: 1,
      pr_number: 504,
      pr_url: 'https://github.com/o/r/pull/504',
      session_id: 'sess-1',
      state: 'merged',
    } as ReturnType<typeof getPRBySessionId>);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(backend.updateStatus).toHaveBeenCalledWith('notion:abc', '✅ Done');
    expect(backend.updateStatus).not.toHaveBeenCalledWith(
      'notion:abc',
      '🗂️ Ready',
    );
  });

  it('marks Done (not Ready) when the latest session has a closed GitHub PR', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('done', 10 * 60 * 1000) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    vi.mocked(getPRBySessionId).mockReturnValue({
      id: 2,
      pr_number: 505,
      pr_url: 'https://github.com/o/r/pull/505',
      session_id: 'sess-1',
      state: 'closed',
    } as ReturnType<typeof getPRBySessionId>);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(backend.updateStatus).toHaveBeenCalledWith('notion:abc', '✅ Done');
  });

  it('marks Done (not Ready) when the latest session has a merged local branch (local-only case)', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('done', 10 * 60 * 1000) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    // No GitHub PR, but local branch is merged
    vi.mocked(getPRBySessionId).mockReturnValue(null);
    vi.mocked(getLocalBranchBySession).mockReturnValue({
      id: 1,
      session_id: 'sess-1',
      project_id: 'proj-1',
      branch_name: 'feature/x',
      base_branch: 'dev',
      status: 'merged',
      review_result: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as ReturnType<typeof getLocalBranchBySession>);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(backend.updateStatus).toHaveBeenCalledWith('notion:abc', '✅ Done');
  });

  it('skips (does not revert) a task whose session has an open PR', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('done', 10 * 60 * 1000) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    vi.mocked(getPRBySessionId).mockReturnValue({
      id: 3,
      pr_number: 506,
      pr_url: 'https://github.com/o/r/pull/506',
      session_id: 'sess-1',
      state: 'open',
    } as ReturnType<typeof getPRBySessionId>);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('skips an idle session that ended within the post-clean-exit grace window', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    // Session ended 30 seconds ago (within 2-minute grace window)
    const endedAt = Date.now() - 30 * 1000;
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue({
      ...makeSession('idle', 10 * 60 * 1000, endedAt),
    } as ReturnType<typeof getLatestCodeSessionByNotionTaskId>);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('records the correct projectId from session.project_id, not the loop project', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    // Session's project_id is 'polimarket', but the loop project is 'claude-dashboard'
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue({
      ...makeSession('done', 60 * 60 * 1000, Date.now() - 30 * 60 * 1000),
      project_id: 'polimarket',
    } as ReturnType<typeof getLatestCodeSessionByNotionTaskId>);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'claude-dashboard' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'polimarket',
        payload: expect.objectContaining({ projectId: 'polimarket' }),
      }),
    );
  });

  it('still reverts a genuinely abandoned session (no PR, not done, outside anti-race)', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    // Session is in 'running' status (not done/error/killed), started long ago
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('running', 30 * 60 * 1000) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    vi.mocked(hasActiveSessionForTask).mockReturnValue(false);
    vi.mocked(getPRBySessionId).mockReturnValue(null);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(backend.updateStatus).toHaveBeenCalledWith('notion:abc', '🗂️ Ready');
  });

  // ── Nudge path (idle sessions) ────────────────────────────────────────────

  it('nudges a stalled idle session instead of reverting', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    const endedAt = Date.now() - 10 * 60 * 1000; // ended 10 min ago (past grace)
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('idle', 30 * 60 * 1000, endedAt) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    vi.mocked(countNudgeEvents).mockReturnValue(0);
    const sendOrResume = vi.fn().mockResolvedValue('sess-1');

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      sendOrResume,
    });

    await sweeper.sweepOnce();

    // Must nudge, not revert
    expect(sendOrResume).toHaveBeenCalledWith(
      'sess-1',
      expect.stringContaining('PR'),
    );
    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'task_orphan_nudged',
        task_id: 'notion:abc',
      }),
    );
  });

  it('surfaces to operator after nudge limit is reached (no revert)', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    const endedAt = Date.now() - 10 * 60 * 1000;
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('idle', 30 * 60 * 1000, endedAt) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    // Already nudged NUDGE_LIMIT times
    vi.mocked(countNudgeEvents).mockReturnValue(2);
    const sendOrResume = vi.fn().mockResolvedValue('sess-1');

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      sendOrResume,
    });

    await sweeper.sweepOnce();

    // No more nudges, no revert
    expect(sendOrResume).not.toHaveBeenCalled();
    expect(backend.updateStatus).not.toHaveBeenCalled();
    // Surfaced to operator via session pause_reason
    expect(setSessionPauseReason).toHaveBeenCalledWith(
      'sess-1',
      'stalled_idle',
    );
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'task_orphan_surfaced',
        task_id: 'notion:abc',
      }),
    );
  });

  it('surfaces to operator immediately when worktree is missing', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    const endedAt = Date.now() - 10 * 60 * 1000;
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession(
        'idle',
        30 * 60 * 1000,
        endedAt,
        '/gone/worktree',
      ) as ReturnType<typeof getLatestCodeSessionByNotionTaskId>,
    );
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const sendOrResume = vi.fn().mockResolvedValue('sess-1');

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      sendOrResume,
    });

    await sweeper.sweepOnce();

    expect(sendOrResume).not.toHaveBeenCalled();
    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(setSessionPauseReason).toHaveBeenCalledWith(
      'sess-1',
      'stalled_idle',
    );
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'task_orphan_surfaced',
        task_id: 'notion:abc',
        payload: expect.objectContaining({ reason: 'worktree_missing' }),
      }),
    );
  });

  it('reverts task to Ready for idle+archived=1 session (not nudged)', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    const endedAt = Date.now() - 10 * 60 * 1000;
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession(
        'idle',
        30 * 60 * 1000,
        endedAt,
        '/fake/worktree',
        1,
      ) as ReturnType<typeof getLatestCodeSessionByNotionTaskId>,
    );
    const sendOrResume = vi.fn().mockResolvedValue('sess-1');

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      sendOrResume,
    });

    await sweeper.sweepOnce();

    // Archived idle session must NOT be nudged
    expect(sendOrResume).not.toHaveBeenCalled();
    // Treat as a genuine orphan — revert to Ready
    expect(backend.updateStatus).toHaveBeenCalledWith('notion:abc', '🗂️ Ready');
  });

  // ── Recency gate (AC1 / AC2) ──────────────────────────────────────────────

  it('does not nudge when session has recent events (recency gate)', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    const endedAt = Date.now() - 30 * 60 * 1000;
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('idle', 60 * 60 * 1000, endedAt) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    // Last event was 5 minutes ago — under 10-minute recency gate
    vi.mocked(getLatestSessionEventTimestamp).mockReturnValue(
      Date.now() - 5 * 60 * 1000,
    );
    const sendOrResume = vi.fn().mockResolvedValue('sess-1');

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      sendOrResume,
    });

    await sweeper.sweepOnce();

    expect(sendOrResume).not.toHaveBeenCalled();
    expect(backend.updateStatus).not.toHaveBeenCalled();
  });

  it('nudges when session events are stale (beyond recency gate)', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    const endedAt = Date.now() - 30 * 60 * 1000;
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('idle', 60 * 60 * 1000, endedAt) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    // Last event was 15 minutes ago — beyond 10-minute recency gate
    vi.mocked(getLatestSessionEventTimestamp).mockReturnValue(
      Date.now() - 15 * 60 * 1000,
    );
    const sendOrResume = vi.fn().mockResolvedValue('sess-1');

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      sendOrResume,
    });

    await sweeper.sweepOnce();

    expect(sendOrResume).toHaveBeenCalledWith(
      'sess-1',
      expect.stringContaining('PR'),
    );
  });

  // ── Minimum nudge spacing (AC6) ───────────────────────────────────────────

  it('skips nudge when last nudge was too recent (minimum spacing)', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    const endedAt = Date.now() - 30 * 60 * 1000;
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('idle', 60 * 60 * 1000, endedAt) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    vi.mocked(getLatestSessionEventTimestamp).mockReturnValue(
      Date.now() - 20 * 60 * 1000,
    );
    // Last nudge was only 5 minutes ago — under 15-minute spacing
    vi.mocked(getLatestNudgeTimestamp).mockReturnValue(
      Date.now() - 5 * 60 * 1000,
    );
    const sendOrResume = vi.fn().mockResolvedValue('sess-1');

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      sendOrResume,
    });

    await sweeper.sweepOnce();

    expect(sendOrResume).not.toHaveBeenCalled();
  });

  it('two sweep ticks 60s apart produce at most one nudge (spacing enforced)', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    const endedAt = Date.now() - 30 * 60 * 1000;
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('idle', 60 * 60 * 1000, endedAt) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    vi.mocked(getLatestSessionEventTimestamp).mockReturnValue(
      Date.now() - 30 * 60 * 1000,
    );
    vi.mocked(getLatestNudgeTimestamp).mockReturnValue(null);
    const sendOrResume = vi.fn().mockResolvedValue('sess-1');

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      sendOrResume,
    });

    // First tick nudges
    await sweeper.sweepOnce();
    expect(sendOrResume).toHaveBeenCalledTimes(1);

    // Simulate 60s elapsed — nudge was recorded 60s ago (under 15-min spacing)
    vi.mocked(getLatestNudgeTimestamp).mockReturnValue(Date.now() - 60 * 1000);

    // Second tick is blocked by spacing gate
    await sweeper.sweepOnce();
    expect(sendOrResume).toHaveBeenCalledTimes(1);
  });

  // ── Total-count cap (fixes livelock) ─────────────────────────────────────

  it('responding-but-never-resolving session still reaches NUDGE_LIMIT (total count)', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    const endedAt = Date.now() - 60 * 60 * 1000;
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('idle', 90 * 60 * 1000, endedAt) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    // Session has responded to nudges (latestEventTs advances), but still no PR
    vi.mocked(getLatestSessionEventTimestamp).mockReturnValue(
      Date.now() - 20 * 60 * 1000,
    );
    // Total nudge count = NUDGE_LIMIT — should surface regardless of session activity
    vi.mocked(countNudgeEvents).mockReturnValue(2);
    const sendOrResume = vi.fn().mockResolvedValue('sess-1');

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      sendOrResume,
    });

    await sweeper.sweepOnce();

    // Should surface to operator, NOT nudge again, even though session responded
    expect(sendOrResume).not.toHaveBeenCalled();
    expect(setSessionPauseReason).toHaveBeenCalledWith('sess-1', 'stalled_idle');
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'task_orphan_surfaced' }),
    );
  });

  // ── Genuine stall still surfaces (AC5) ───────────────────────────────────

  it('genuinely stalled session surfaces to operator after nudge limit', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    const endedAt = Date.now() - 60 * 60 * 1000;
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('idle', 90 * 60 * 1000, endedAt) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    vi.mocked(getLatestSessionEventTimestamp).mockReturnValue(
      Date.now() - 60 * 60 * 1000,
    );
    // 2 total nudges — limit reached
    vi.mocked(countNudgeEvents).mockReturnValue(2);
    const sendOrResume = vi.fn().mockResolvedValue('sess-1');

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      sendOrResume,
    });

    await sweeper.sweepOnce();

    expect(sendOrResume).not.toHaveBeenCalled();
    expect(setSessionPauseReason).toHaveBeenCalledWith(
      'sess-1',
      'stalled_idle',
    );
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'task_orphan_surfaced' }),
    );
  });

  // ── Surface-once (AC7) ────────────────────────────────────────────────────

  it('task_orphan_surfaced not emitted again when session already paused stalled_idle', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    const endedAt = Date.now() - 60 * 60 * 1000;
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue({
      ...makeSession('idle', 90 * 60 * 1000, endedAt),
      pause_reason: 'stalled_idle',
    } as ReturnType<typeof getLatestCodeSessionByNotionTaskId>);
    vi.mocked(getLatestSessionEventTimestamp).mockReturnValue(
      Date.now() - 60 * 60 * 1000,
    );
    vi.mocked(countNudgeEvents).mockReturnValue(2);
    const sendOrResume = vi.fn().mockResolvedValue('sess-1');

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      sendOrResume,
    });

    await sweeper.sweepOnce();
    await sweeper.sweepOnce();
    await sweeper.sweepOnce();

    expect(setSessionPauseReason).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'task_orphan_surfaced' }),
    );
  });

  // ── Type filter (non-Code tasks must be skipped) ──────────────────────────

  it.each(['📋 Planning', '🧪 Testing', '🛠️ Tooling'])(
    'does not revert or nudge a non-Code In-Progress task with no session (type: %s)',
    async (taskType) => {
      const backend = makeBackend([
        makeTask('notion:abc', '🔄 In Progress', taskType),
      ]);
      const sendOrResume = vi.fn().mockResolvedValue('sess-1');

      const sweeper = new OrphanedTaskSweeper(broadcast, {
        listProjects: () => [
          { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
        ],
        resolveBackend: () => backend,
        sendOrResume,
      });

      await sweeper.sweepOnce();

      expect(backend.updateStatus).not.toHaveBeenCalled();
      expect(sendOrResume).not.toHaveBeenCalled();
      expect(recordEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ event_type: 'task_orphan_reverted' }),
      );
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it('still reverts a Code genuine orphan (In Progress, session dead, no PR)', async () => {
    const backend = makeBackend([
      makeTask('notion:abc', '🔄 In Progress', '💻 Code'),
    ]);
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('done', 30 * 60 * 1000) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(backend.updateStatus).toHaveBeenCalledWith('notion:abc', '🗂️ Ready');
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'task_orphan_reverted' }),
    );
  });

  it('still reverts a failed-launch Code task (In Progress, latestSession === undefined)', async () => {
    // latestSession is undefined: task was marked In Progress before its session row was created
    // (e.g. launch failed). Must still revert to Ready so it can be re-dispatched.
    const backend = makeBackend([
      makeTask('notion:abc', '🔄 In Progress', '💻 Code'),
    ]);
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(undefined);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(backend.updateStatus).toHaveBeenCalledWith('notion:abc', '🗂️ Ready');
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'task_orphan_reverted' }),
    );
  });

  // ── GitHub PR-existence gate ──────────────────────────────────────────────

  it('suppresses "no PR opened" nudge when GitHub API finds open PR for session head branch', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    const endedAt = Date.now() - 10 * 60 * 1000;
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('idle', 30 * 60 * 1000, endedAt) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    vi.mocked(getPRBySessionId).mockReturnValue(null);
    vi.mocked(getLocalBranchBySession).mockReturnValue({
      id: 1,
      session_id: 'sess-1',
      project_id: 'proj-1',
      branch_name: 'feature/my-task',
      base_branch: 'dev',
      status: 'open',
      review_result: null,
      pause_reason: null,
      merge_commit_sha: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as ReturnType<typeof getLocalBranchBySession>);

    const githubClient = {
      listOpenPRs: vi.fn().mockResolvedValue([
        {
          id: 99,
          nodeId: 'node-99',
          title: 'My Task',
          body: null,
          url: 'https://github.com/owner/repo/pull/99',
          apiUrl: 'https://api.github.com/repos/owner/repo/pulls/99',
          headBranch: 'feature/my-task',
          headSha: 'abc123',
          baseBranch: 'dev',
          state: 'open',
          draft: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          mergeableState: null,
        },
      ]),
    };
    const sendOrResume = vi.fn().mockResolvedValue('sess-1');

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      sendOrResume,
      githubClient,
    });

    await sweeper.sweepOnce();

    // Nudge suppressed — PR already open on GitHub
    expect(sendOrResume).not.toHaveBeenCalled();
    // PR row backfilled
    expect(upsertPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        pr_number: 99,
        head_branch: 'feature/my-task',
        session_id: 'sess-1',
      }),
    );
    // Task not reverted
    expect(backend.updateStatus).not.toHaveBeenCalled();
  });

  it('does not suppress nudge when no open PR found on GitHub for session head branch', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    const endedAt = Date.now() - 10 * 60 * 1000;
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('idle', 30 * 60 * 1000, endedAt) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    vi.mocked(getPRBySessionId).mockReturnValue(null);
    vi.mocked(getLocalBranchBySession).mockReturnValue({
      id: 1,
      session_id: 'sess-1',
      project_id: 'proj-1',
      branch_name: 'feature/my-task',
      base_branch: 'dev',
      status: 'open',
      review_result: null,
      pause_reason: null,
      merge_commit_sha: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as ReturnType<typeof getLocalBranchBySession>);

    const githubClient = {
      listOpenPRs: vi.fn().mockResolvedValue([
        {
          id: 88,
          nodeId: 'node-88',
          title: 'Other Task',
          body: null,
          url: 'https://github.com/owner/repo/pull/88',
          apiUrl: 'https://api.github.com/repos/owner/repo/pulls/88',
          headBranch: 'feature/other-task', // different branch
          headSha: 'def456',
          baseBranch: 'dev',
          state: 'open',
          draft: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          mergeableState: null,
        },
      ]),
    };
    const sendOrResume = vi.fn().mockResolvedValue('sess-1');

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      sendOrResume,
      githubClient,
    });

    await sweeper.sweepOnce();

    // No matching PR — nudge proceeds normally
    expect(sendOrResume).toHaveBeenCalledWith('sess-1', expect.stringContaining('PR'));
    expect(upsertPullRequest).not.toHaveBeenCalled();
  });

  it('falls back to nudging when GitHub API throws (fail-open)', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    const endedAt = Date.now() - 10 * 60 * 1000;
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('idle', 30 * 60 * 1000, endedAt) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    vi.mocked(getPRBySessionId).mockReturnValue(null);
    vi.mocked(getLocalBranchBySession).mockReturnValue({
      id: 1,
      session_id: 'sess-1',
      project_id: 'proj-1',
      branch_name: 'feature/my-task',
      base_branch: 'dev',
      status: 'open',
      review_result: null,
      pause_reason: null,
      merge_commit_sha: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as ReturnType<typeof getLocalBranchBySession>);

    const githubClient = {
      listOpenPRs: vi.fn().mockRejectedValue(new Error('API rate limit')),
    };
    const sendOrResume = vi.fn().mockResolvedValue('sess-1');

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      sendOrResume,
      githubClient,
    });

    await sweeper.sweepOnce();

    // Fail-open: GitHub error doesn't prevent the nudge
    expect(sendOrResume).toHaveBeenCalledWith('sess-1', expect.stringContaining('PR'));
    expect(upsertPullRequest).not.toHaveBeenCalled();
  });

  it('idle session with open PR in DB is nudged (stalled-PR path) and not reverted', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    const endedAt = Date.now() - 10 * 60 * 1000;
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('idle', 30 * 60 * 1000, endedAt) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    vi.mocked(getPRBySessionId).mockReturnValue({
      id: 7,
      pr_number: 510,
      pr_url: 'https://github.com/o/r/pull/510',
      session_id: 'sess-1',
      state: 'open',
    } as ReturnType<typeof getPRBySessionId>);
    const sendOrResume = vi.fn().mockResolvedValue('sess-1');

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      sendOrResume,
    });

    await sweeper.sweepOnce();

    // Stalled-PR idle path: session IS nudged (to act on review feedback)
    expect(sendOrResume).toHaveBeenCalledWith('sess-1', expect.any(String));
    // Task is NOT reverted — open PR means session did its job
    expect(backend.updateStatus).not.toHaveBeenCalled();
  });
});
