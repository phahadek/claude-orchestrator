/**
 * Tests for OrphanedTaskSweeper.
 *
 * Verifies:
 * - Clean orphan revert: In Progress task with no live session → reverted to Ready
 * - Anti-race skip: task whose latest session started < 5 min ago → skipped
 * - Already-failed skip: task whose latest session is error|killed → skipped
 * - No-task-id edge case: tasks with empty id → skipped
 * - recordEvent and broadcast fire on revert
 * - Idle session → enqueueFeedback nudge (inbox), no task revert, worktree intact
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
  getLatestOpsSessionByTaskId: vi.fn(() => undefined),
  getLatestDocsSessionByTaskId: vi.fn(() => undefined),
  hasActiveSessionForTask: vi.fn(),
  hasNonTerminalPlanningSessionForTask: vi.fn(() => false),
  isSessionAwaitingCapabilityDisposition: vi.fn(() => false),
  getPRByNotionTaskId: vi.fn(() => null),
  // sessionLifecycle.ts's sessionDidWork (called by the sweeper's
  // ops/docs fallback path) is keyed on session id, not task id — kept
  // separate from getPRByNotionTaskId above, which is the sweeper's own
  // task-id-based PR resolution.
  getPRBySessionId: vi.fn(() => null),
  getTaskRepoAssignment: vi.fn(() => undefined),
  getLocalBranchBySession: vi.fn(() => undefined),
  setSessionPauseReason: vi.fn(),
  getSessionLastActivityMs: vi.fn(() => null),
  upsertPullRequest: vi.fn(() => null),
  getOpsJournalEntry: vi.fn(() => undefined),
  getSession: vi.fn(() => undefined),
  listStagedIntentsBySession: vi.fn(() => []),
  isNoOpSuppressed: vi.fn(() => false),
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

vi.mock('../orchestration/usageAdmission.js', () => ({
  isUsageAdmitted: vi.fn(() => ({ allowed: true })),
}));

import fs from 'node:fs';
import {
  getLatestCodeSessionByNotionTaskId,
  getLatestOpsSessionByTaskId,
  getLatestDocsSessionByTaskId,
  hasActiveSessionForTask,
  hasNonTerminalPlanningSessionForTask,
  isSessionAwaitingCapabilityDisposition,
  getPRByNotionTaskId,
  getLocalBranchBySession,
  setSessionPauseReason,
  getSessionLastActivityMs,
  upsertPullRequest,
  getOpsJournalEntry,
  getSession,
  listStagedIntentsBySession,
  isNoOpSuppressed,
  getTaskRepoAssignment,
} from '../db/queries.js';
import {
  recordEvent,
  countNudgeEvents,
  getLatestNudgeTimestamp,
} from '../audit/AuditLog.js';
import { getAllProjects } from '../config.js';
import { isUsageAdmitted } from '../orchestration/usageAdmission.js';
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

function makeDocsSession(
  status: string,
  startedAtOffsetMs: number,
  endedAt?: number,
  archived = 0,
) {
  return {
    ...makeSession(
      status,
      startedAtOffsetMs,
      endedAt,
      '/fake/worktree',
      archived,
    ),
    session_type: 'docs',
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
    vi.mocked(hasNonTerminalPlanningSessionForTask).mockReturnValue(false);
    vi.mocked(isSessionAwaitingCapabilityDisposition).mockReturnValue(false);
    vi.mocked(getPRByNotionTaskId).mockReturnValue(null);
    vi.mocked(getLocalBranchBySession).mockReturnValue(undefined);
    vi.mocked(setSessionPauseReason).mockClear();
    vi.mocked(recordEvent).mockClear();
    vi.mocked(countNudgeEvents).mockReturnValue(0);
    vi.mocked(getSessionLastActivityMs).mockReturnValue(null);
    vi.mocked(getLatestNudgeTimestamp).mockReturnValue(null);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(upsertPullRequest).mockClear();
    vi.mocked(getOpsJournalEntry).mockReset().mockReturnValue(undefined);
    vi.mocked(getLatestOpsSessionByTaskId)
      .mockReset()
      .mockReturnValue(undefined);
    vi.mocked(getLatestDocsSessionByTaskId)
      .mockReset()
      .mockReturnValue(undefined);
    vi.mocked(getSession).mockReset().mockReturnValue(undefined);
    vi.mocked(listStagedIntentsBySession).mockReset().mockReturnValue([]);
    vi.mocked(isUsageAdmitted).mockReset().mockReturnValue({ allowed: true });
    vi.mocked(isNoOpSuppressed).mockReset().mockReturnValue(false);
    vi.mocked(getTaskRepoAssignment).mockReset().mockReturnValue(undefined);
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

  it('does not revert a task whose most recent planning.noOp still stands', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    vi.mocked(isNoOpSuppressed).mockReturnValueOnce(true);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(isNoOpSuppressed).toHaveBeenCalledWith('notion:abc');
    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
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
    vi.mocked(getPRByNotionTaskId).mockReturnValue({
      id: 1,
      pr_number: 504,
      pr_url: 'https://github.com/o/r/pull/504',
      session_id: 'sess-1',
      state: 'merged',
    } as ReturnType<typeof getPRByNotionTaskId>);

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
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'task_orphan_reverted',
        payload: expect.objectContaining({ reason: 'merged' }),
      }),
    );
  });

  it('reverts to Ready (not Done) when the latest session has a closed, unmerged GitHub PR', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('done', 10 * 60 * 1000) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    vi.mocked(getPRByNotionTaskId).mockReturnValue({
      id: 2,
      pr_number: 505,
      pr_url: 'https://github.com/o/r/pull/505',
      session_id: 'sess-1',
      state: 'closed',
    } as ReturnType<typeof getPRByNotionTaskId>);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(backend.updateStatus).toHaveBeenCalledWith('notion:abc', '🗂️ Ready');
    expect(backend.updateStatus).not.toHaveBeenCalledWith(
      'notion:abc',
      '✅ Done',
    );
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'task_orphan_reverted',
        payload: expect.objectContaining({ reason: 'closed_unmerged' }),
      }),
    );
  });

  it('marks Done — not Ready — when the PR reports closed but its local_branches row records a merge (squash-merge case)', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('done', 10 * 60 * 1000) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    vi.mocked(getPRByNotionTaskId).mockReturnValue({
      id: 2,
      pr_number: 505,
      pr_url: 'https://github.com/o/r/pull/505',
      session_id: 'sess-1',
      state: 'closed',
    } as ReturnType<typeof getPRByNotionTaskId>);
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
    expect(backend.updateStatus).not.toHaveBeenCalledWith(
      'notion:abc',
      '🗂️ Ready',
    );
  });

  it('reverts to Ready when the local_branches row is abandoned (no GitHub PR)', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('done', 10 * 60 * 1000) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    vi.mocked(getPRByNotionTaskId).mockReturnValue(null);
    vi.mocked(getLocalBranchBySession).mockReturnValue({
      id: 1,
      session_id: 'sess-1',
      project_id: 'proj-1',
      branch_name: 'feature/x',
      base_branch: 'dev',
      status: 'abandoned',
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

    expect(backend.updateStatus).toHaveBeenCalledWith('notion:abc', '🗂️ Ready');
  });

  it('marks Done (not Ready) when the latest session has a merged local branch (local-only case)', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('done', 10 * 60 * 1000) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    // No GitHub PR, but local branch is merged
    vi.mocked(getPRByNotionTaskId).mockReturnValue(null);
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
    vi.mocked(getPRByNotionTaskId).mockReturnValue({
      id: 3,
      pr_number: 506,
      pr_url: 'https://github.com/o/r/pull/506',
      session_id: 'sess-1',
      state: 'open',
    } as ReturnType<typeof getPRByNotionTaskId>);

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
    vi.mocked(getPRByNotionTaskId).mockReturnValue(null);

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
    const enqueueFeedback = vi.fn().mockResolvedValue(undefined);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      enqueueFeedback,
    });

    await sweeper.sweepOnce();

    // Must nudge, not revert — no-PR path keeps the "open a draft PR" wording
    expect(enqueueFeedback).toHaveBeenCalledWith(
      'sess-1',
      'system:nudge',
      expect.stringContaining('no PR was opened'),
    );
    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'task_orphan_nudged',
        task_id: 'notion:abc',
      }),
    );
  });

  it('withholds a nudge while plan usage is exhausted — no delivery, no budget spend, no operator escalation', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    const endedAt = Date.now() - 10 * 60 * 1000; // ended 10 min ago (past grace)
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('idle', 30 * 60 * 1000, endedAt) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    vi.mocked(isUsageAdmitted).mockReturnValue({
      allowed: false,
      window: 'five_hour',
      reason: 'usage_deferral',
    });
    const enqueueFeedback = vi.fn().mockResolvedValue(undefined);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      enqueueFeedback,
    });

    await sweeper.sweepOnce();

    // Withheld entirely — the item stays outstanding for the next sweep tick
    // rather than being sent (and failing) and burning a nudge slot.
    expect(enqueueFeedback).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'task_orphan_nudged' }),
    );
    expect(setSessionPauseReason).not.toHaveBeenCalled();
    expect(backend.updateStatus).not.toHaveBeenCalled();
  });

  it('delivers the withheld nudge once plan usage is admitted again', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    const endedAt = Date.now() - 10 * 60 * 1000;
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('idle', 30 * 60 * 1000, endedAt) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    const enqueueFeedback = vi.fn().mockResolvedValue(undefined);
    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      enqueueFeedback,
    });

    vi.mocked(isUsageAdmitted).mockReturnValue({
      allowed: false,
      window: 'five_hour',
      reason: 'usage_deferral',
    });
    await sweeper.sweepOnce();
    expect(enqueueFeedback).not.toHaveBeenCalled();

    vi.mocked(isUsageAdmitted).mockReturnValue({ allowed: true });
    await sweeper.sweepOnce();
    expect(enqueueFeedback).toHaveBeenCalledWith(
      'sess-1',
      'system:nudge',
      expect.stringContaining('no PR was opened'),
    );
  });

  it('never nudges or reverts an idle session parked awaiting a capability disposition', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    const endedAt = Date.now() - 10 * 60 * 1000; // ended 10 min ago (past grace)
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('idle', 30 * 60 * 1000, endedAt) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    vi.mocked(isSessionAwaitingCapabilityDisposition).mockReturnValue(true);
    const enqueueFeedback = vi.fn().mockResolvedValue(undefined);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      enqueueFeedback,
    });

    await sweeper.sweepOnce();

    expect(enqueueFeedback).not.toHaveBeenCalled();
    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(setSessionPauseReason).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
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
    const enqueueFeedback = vi.fn().mockResolvedValue(undefined);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      enqueueFeedback,
    });

    await sweeper.sweepOnce();

    // No more nudges, no revert
    expect(enqueueFeedback).not.toHaveBeenCalled();
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
    const enqueueFeedback = vi.fn().mockResolvedValue(undefined);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      enqueueFeedback,
    });

    await sweeper.sweepOnce();

    expect(enqueueFeedback).not.toHaveBeenCalled();
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
    const enqueueFeedback = vi.fn().mockResolvedValue(undefined);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      enqueueFeedback,
    });

    await sweeper.sweepOnce();

    // Archived idle session must NOT be nudged
    expect(enqueueFeedback).not.toHaveBeenCalled();
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
    vi.mocked(getSessionLastActivityMs).mockReturnValue(
      Date.now() - 5 * 60 * 1000,
    );
    const enqueueFeedback = vi.fn().mockResolvedValue(undefined);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      enqueueFeedback,
    });

    await sweeper.sweepOnce();

    expect(enqueueFeedback).not.toHaveBeenCalled();
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
    vi.mocked(getSessionLastActivityMs).mockReturnValue(
      Date.now() - 15 * 60 * 1000,
    );
    const enqueueFeedback = vi.fn().mockResolvedValue(undefined);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      enqueueFeedback,
    });

    await sweeper.sweepOnce();

    expect(enqueueFeedback).toHaveBeenCalledWith(
      'sess-1',
      'system:nudge',
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
    vi.mocked(getSessionLastActivityMs).mockReturnValue(
      Date.now() - 20 * 60 * 1000,
    );
    // Last nudge was only 5 minutes ago — under 15-minute spacing
    vi.mocked(getLatestNudgeTimestamp).mockReturnValue(
      Date.now() - 5 * 60 * 1000,
    );
    const enqueueFeedback = vi.fn().mockResolvedValue(undefined);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      enqueueFeedback,
    });

    await sweeper.sweepOnce();

    expect(enqueueFeedback).not.toHaveBeenCalled();
  });

  it('two sweep ticks 60s apart produce at most one nudge (spacing enforced)', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    const endedAt = Date.now() - 30 * 60 * 1000;
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('idle', 60 * 60 * 1000, endedAt) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    vi.mocked(getSessionLastActivityMs).mockReturnValue(
      Date.now() - 30 * 60 * 1000,
    );
    vi.mocked(getLatestNudgeTimestamp).mockReturnValue(null);
    const enqueueFeedback = vi.fn().mockResolvedValue(undefined);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      enqueueFeedback,
    });

    // First tick nudges
    await sweeper.sweepOnce();
    expect(enqueueFeedback).toHaveBeenCalledTimes(1);

    // Simulate 60s elapsed — nudge was recorded 60s ago (under 15-min spacing)
    vi.mocked(getLatestNudgeTimestamp).mockReturnValue(Date.now() - 60 * 1000);

    // Second tick is blocked by spacing gate
    await sweeper.sweepOnce();
    expect(enqueueFeedback).toHaveBeenCalledTimes(1);
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
    vi.mocked(getSessionLastActivityMs).mockReturnValue(
      Date.now() - 20 * 60 * 1000,
    );
    // Total nudge count = NUDGE_LIMIT — should surface regardless of session activity
    vi.mocked(countNudgeEvents).mockReturnValue(2);
    const enqueueFeedback = vi.fn().mockResolvedValue(undefined);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      enqueueFeedback,
    });

    await sweeper.sweepOnce();

    // Should surface to operator, NOT nudge again, even though session responded
    expect(enqueueFeedback).not.toHaveBeenCalled();
    expect(setSessionPauseReason).toHaveBeenCalledWith(
      'sess-1',
      'stalled_idle',
    );
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
    vi.mocked(getSessionLastActivityMs).mockReturnValue(
      Date.now() - 60 * 60 * 1000,
    );
    // 2 total nudges — limit reached
    vi.mocked(countNudgeEvents).mockReturnValue(2);
    const enqueueFeedback = vi.fn().mockResolvedValue(undefined);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      enqueueFeedback,
    });

    await sweeper.sweepOnce();

    expect(enqueueFeedback).not.toHaveBeenCalled();
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
    vi.mocked(getSessionLastActivityMs).mockReturnValue(
      Date.now() - 60 * 60 * 1000,
    );
    vi.mocked(countNudgeEvents).mockReturnValue(2);
    const enqueueFeedback = vi.fn().mockResolvedValue(undefined);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      enqueueFeedback,
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

  it.each(['📋 Planning', '🧪 Testing', '🛠️ Tooling', '🚦 Gate', '📐 Design'])(
    'does not revert or nudge a non-Code In-Progress task with no session (type: %s)',
    async (taskType) => {
      const backend = makeBackend([
        makeTask('notion:abc', '🔄 In Progress', taskType),
      ]);
      const enqueueFeedback = vi.fn().mockResolvedValue(undefined);

      const sweeper = new OrphanedTaskSweeper(broadcast, {
        listProjects: () => [
          { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
        ],
        resolveBackend: () => backend,
        enqueueFeedback,
      });

      await sweeper.sweepOnce();

      expect(backend.updateStatus).not.toHaveBeenCalled();
      expect(enqueueFeedback).not.toHaveBeenCalled();
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

  // Session-anchor-durability: an open PR references the task even after its
  // implementing session row has been deleted entirely (not merely absent
  // from the "latest" lookup — getLatestCodeSessionByNotionTaskId returns
  // undefined because there is truly no row left in `sessions`). Resolving
  // the PR by the task's own id (not solely via latestSession.session_id)
  // must still protect the task from revert.
  it('does not revert a task with an open PR when its session row has been deleted', async () => {
    const backend = makeBackend([
      makeTask('notion:abc', '🔄 In Progress', '💻 Code'),
    ]);
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(undefined);
    vi.mocked(getPRByNotionTaskId).mockReturnValue({
      id: 4,
      pr_number: 1031,
      pr_url: 'https://github.com/o/r/pull/1031',
      task_id: 'notion:abc',
      session_id: 'deleted-session-1',
      state: 'open',
    } as ReturnType<typeof getPRByNotionTaskId>);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'task_orphan_reverted' }),
    );
  });

  // Companion to the "records the correct projectId from session.project_id"
  // test above, for the case that project_id source (latestSession) no
  // longer exists: the task's own durable repo assignment must be preferred
  // over the sweep loop's current project, not just latestSession.project_id.
  it('records the project from task_repo_assignments, not the loop project, when no session row is available', async () => {
    const backend = makeBackend([
      makeTask('notion:abc', '🔄 In Progress', '💻 Code'),
    ]);
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(undefined);
    vi.mocked(getTaskRepoAssignment).mockReturnValue({
      task_id: 'notion:abc',
      project_id: 'polimarket',
      repo: 'o/r',
      assigned_by: 'auto_launcher',
      assigned_at: Date.now(),
    });

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'claude-dashboard' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(backend.updateStatus).toHaveBeenCalledWith('notion:abc', '🗂️ Ready');
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'task_orphan_reverted',
        project_id: 'polimarket',
      }),
    );
  });

  it('skips a task whose only session is a parked (idle) planning session', async () => {
    // getLatestCodeSessionByNotionTaskId/hasActiveSessionForTask only ever see
    // 'standard' sessions, so they report nothing for a task whose only
    // session is a groom/design one — hasNonTerminalPlanningSessionForTask is
    // the dedicated exclusion for that case.
    const backend = makeBackend([
      makeTask('notion:abc', '🔄 In Progress', '💻 Code'),
    ]);
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(undefined);
    vi.mocked(hasActiveSessionForTask).mockReturnValue(false);
    vi.mocked(hasNonTerminalPlanningSessionForTask).mockReturnValue(true);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'task_orphan_reverted' }),
    );
  });

  // ── Ops/Investigation sweep (widened type filter) ─────────────────────────

  it.each(['🔧 Operational', '🔎 Investigation'])(
    'reverts a %s task at In Progress whose only session is killed',
    async (taskType) => {
      const backend = makeBackend([
        makeTask('notion:abc', '🔄 In Progress', taskType),
      ]);
      // getLatestCodeSessionByNotionTaskId only ever sees 'standard' sessions,
      // so an ops session (even a killed one) never surfaces here — it's undefined.
      vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(undefined);
      vi.mocked(hasActiveSessionForTask).mockReturnValue(false);
      // The ops session is killed (terminal), so the planning-session guard
      // correctly reports no non-terminal planning session.
      vi.mocked(hasNonTerminalPlanningSessionForTask).mockReturnValue(false);

      const sweeper = new OrphanedTaskSweeper(broadcast, {
        listProjects: () => [
          { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
        ],
        resolveBackend: () => backend,
      });

      await sweeper.sweepOnce();

      expect(backend.updateStatus).toHaveBeenCalledWith(
        'notion:abc',
        '🗂️ Ready',
      );
      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'task_orphan_reverted',
          task_id: 'notion:abc',
        }),
      );
    },
  );

  it('does not revert an Operational task whose ops session is idle (parked awaiting disposition)', async () => {
    const backend = makeBackend([
      makeTask('notion:abc', '🔄 In Progress', '🔧 Operational'),
    ]);
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(undefined);
    vi.mocked(hasActiveSessionForTask).mockReturnValue(false);
    // The parked ops session is idle — non-terminal — so the guard reports true.
    vi.mocked(hasNonTerminalPlanningSessionForTask).mockReturnValue(true);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'task_orphan_reverted' }),
    );
  });

  it.each(['🔧 Operational', '🔎 Investigation'])(
    'does not revert a %s task whose ops_journal entry is beyond pending',
    async (taskType) => {
      const backend = makeBackend([
        makeTask('notion:abc', '🔄 In Progress', taskType),
      ]);
      vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(undefined);
      vi.mocked(hasActiveSessionForTask).mockReturnValue(false);
      vi.mocked(hasNonTerminalPlanningSessionForTask).mockReturnValue(false);
      vi.mocked(getLatestOpsSessionByTaskId).mockReturnValue(
        makeSession('done', 30 * 60 * 1000) as ReturnType<
          typeof getLatestOpsSessionByTaskId
        >,
      );
      vi.mocked(getSession).mockReturnValue({
        session_id: 'sess-1',
        session_type: 'ops',
        task_id: 'notion:abc',
      } as ReturnType<typeof getSession>);
      vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
      vi.mocked(getOpsJournalEntry).mockReturnValue({
        task_id: 'notion:abc',
        project: 'proj-1',
        milestone: 'm1',
        state: 'candidate',
        disposition: null,
        worked_in: null,
        evidence: null,
        finding_or_proposal: 'found it',
        falsification: null,
        filed_followons: null,
        needs_from_operator: null,
        resolution: null,
        updated_at: new Date().toISOString(),
      });

      const sweeper = new OrphanedTaskSweeper(broadcast, {
        listProjects: () => [
          { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
        ],
        resolveBackend: () => backend,
      });

      await sweeper.sweepOnce();

      expect(backend.updateStatus).not.toHaveBeenCalled();
      expect(recordEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ event_type: 'task_orphan_reverted' }),
      );
      expect(setSessionPauseReason).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it('still reverts a %s task whose ops_journal entry is still pending', async () => {
    const backend = makeBackend([
      makeTask('notion:abc', '🔄 In Progress', '🔎 Investigation'),
    ]);
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(undefined);
    vi.mocked(hasActiveSessionForTask).mockReturnValue(false);
    vi.mocked(hasNonTerminalPlanningSessionForTask).mockReturnValue(false);
    vi.mocked(getOpsJournalEntry).mockReturnValue({
      task_id: 'notion:abc',
      project: 'proj-1',
      milestone: 'm1',
      state: 'pending',
      disposition: null,
      worked_in: null,
      evidence: null,
      finding_or_proposal: null,
      falsification: null,
      filed_followons: null,
      needs_from_operator: null,
      resolution: null,
      updated_at: new Date().toISOString(),
    });

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

  it('does not revert an Investigation task that staged a decision even though its ops_journal is still pending', async () => {
    const backend = makeBackend([
      makeTask('notion:abc', '🔄 In Progress', '🔎 Investigation'),
    ]);
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(undefined);
    vi.mocked(hasActiveSessionForTask).mockReturnValue(false);
    vi.mocked(hasNonTerminalPlanningSessionForTask).mockReturnValue(false);
    vi.mocked(getLatestOpsSessionByTaskId).mockReturnValue(
      makeSession('done', 30 * 60 * 1000) as ReturnType<
        typeof getLatestOpsSessionByTaskId
      >,
    );
    vi.mocked(getSession).mockReturnValue({
      session_id: 'sess-1',
      session_type: 'ops',
      task_id: 'notion:abc',
    } as ReturnType<typeof getSession>);
    // Staged a decision — sessionDidWork must count this even with the
    // journal still at its initial 'pending' state (or missing).
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      { id: 'intent-1', kind: 'task.updateBody', state: 'staged' },
    ] as ReturnType<typeof listStagedIntentsBySession>);
    vi.mocked(getOpsJournalEntry).mockReturnValue(undefined);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'task_orphan_reverted' }),
    );
  });

  it('reverts an Investigation task whose only intents are superseded/withdrawn/rejected (nothing dispositionable)', async () => {
    const backend = makeBackend([
      makeTask('notion:abc', '🔄 In Progress', '🔎 Investigation'),
    ]);
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(undefined);
    vi.mocked(hasActiveSessionForTask).mockReturnValue(false);
    vi.mocked(hasNonTerminalPlanningSessionForTask).mockReturnValue(false);
    vi.mocked(getLatestOpsSessionByTaskId).mockReturnValue(
      makeSession('done', 30 * 60 * 1000) as ReturnType<
        typeof getLatestOpsSessionByTaskId
      >,
    );
    vi.mocked(getSession).mockReturnValue({
      session_id: 'sess-1',
      session_type: 'ops',
      task_id: 'notion:abc',
    } as ReturnType<typeof getSession>);
    // All rows exist but none are still on (or landed on) the decision
    // surface — expired/superseded, withdrawn, and rejected respectively.
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      { id: 'intent-1', kind: 'task.updateBody', state: 'superseded' },
      { id: 'intent-2', kind: 'task.updateBody', state: 'withdrawn' },
      { id: 'intent-3', kind: 'task.updateBody', state: 'rejected' },
    ] as ReturnType<typeof listStagedIntentsBySession>);
    vi.mocked(getOpsJournalEntry).mockReturnValue({
      task_id: 'notion:abc',
      project: 'proj-1',
      milestone: 'm1',
      state: 'pending',
      disposition: null,
      worked_in: null,
      evidence: null,
      finding_or_proposal: null,
      falsification: null,
      filed_followons: null,
      needs_from_operator: null,
      resolution: null,
      updated_at: new Date().toISOString(),
    });

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

  it('does not consult ops_journal for a Code task and still reverts a genuine orphan', async () => {
    const backend = makeBackend([
      makeTask('notion:abc', '🔄 In Progress', '💻 Code'),
    ]);
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('done', 30 * 60 * 1000) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    vi.mocked(getOpsJournalEntry).mockReturnValue({
      task_id: 'notion:abc',
      project: 'proj-1',
      milestone: 'm1',
      state: 'candidate',
      disposition: null,
      worked_in: null,
      evidence: null,
      finding_or_proposal: null,
      falsification: null,
      filed_followons: null,
      needs_from_operator: null,
      resolution: null,
      updated_at: new Date().toISOString(),
    });

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(getOpsJournalEntry).not.toHaveBeenCalled();
    expect(backend.updateStatus).toHaveBeenCalledWith('notion:abc', '🗂️ Ready');
  });

  it('never touches an Operational task already at In Review or Done', async () => {
    // listTasksByStatus is scoped to IN_PROGRESS_STATUS, so a task already past
    // In Progress never appears in the sweep's candidate list at all.
    const backend = makeBackend([]);
    vi.mocked(getAllProjects).mockReturnValue([
      { id: 'proj-1', name: 'P1' } as ReturnType<typeof getAllProjects>[number],
    ]);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(backend.listTasksByStatus).toHaveBeenCalledWith('🔄 In Progress');
    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'task_orphan_reverted' }),
    );
  });

  // ── Docs sweep (widened type filter) ───────────────────────────────────────

  it('reverts a Docs task at In Progress whose only session is terminal and produced nothing dispositionable', async () => {
    const backend = makeBackend([
      makeTask('notion:abc', '🔄 In Progress', '📝 Docs'),
    ]);
    vi.mocked(getLatestDocsSessionByTaskId).mockReturnValue(
      makeDocsSession('done', 30 * 60 * 1000) as ReturnType<
        typeof getLatestDocsSessionByTaskId
      >,
    );
    vi.mocked(hasNonTerminalPlanningSessionForTask).mockReturnValue(false);
    vi.mocked(getPRByNotionTaskId).mockReturnValue(null);
    vi.mocked(getLocalBranchBySession).mockReturnValue(undefined);
    vi.mocked(getSession).mockReturnValue({
      session_id: 'sess-1',
      session_type: 'docs',
      task_id: 'notion:abc',
    } as ReturnType<typeof getSession>);
    vi.mocked(listStagedIntentsBySession).mockReturnValue([]);

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
        task_id: 'notion:abc',
      }),
    );
  });

  it('leaves a Docs task at In Progress whose session staged live work', async () => {
    const backend = makeBackend([
      makeTask('notion:abc', '🔄 In Progress', '📝 Docs'),
    ]);
    vi.mocked(getLatestDocsSessionByTaskId).mockReturnValue(
      makeDocsSession('done', 30 * 60 * 1000) as ReturnType<
        typeof getLatestDocsSessionByTaskId
      >,
    );
    vi.mocked(hasNonTerminalPlanningSessionForTask).mockReturnValue(false);
    vi.mocked(getPRByNotionTaskId).mockReturnValue(null);
    vi.mocked(getLocalBranchBySession).mockReturnValue(undefined);
    vi.mocked(getSession).mockReturnValue({
      session_id: 'sess-1',
      session_type: 'docs',
      task_id: 'notion:abc',
    } as ReturnType<typeof getSession>);
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      { id: 'intent-1', kind: 'notion.pageEdit', state: 'staged' },
    ] as ReturnType<typeof listStagedIntentsBySession>);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'task_orphan_reverted' }),
    );
  });

  it('does not revert or nudge a Docs task whose session opened a human_merge_only PR still awaiting human merge', async () => {
    const backend = makeBackend([
      makeTask('notion:abc', '🔄 In Progress', '📝 Docs'),
    ]);
    vi.mocked(getLatestDocsSessionByTaskId).mockReturnValue(
      makeDocsSession('done', 30 * 60 * 1000) as ReturnType<
        typeof getLatestDocsSessionByTaskId
      >,
    );
    vi.mocked(hasNonTerminalPlanningSessionForTask).mockReturnValue(false);
    vi.mocked(getPRByNotionTaskId).mockReturnValue({
      id: 9,
      pr_number: 512,
      pr_url: 'https://github.com/o/r/pull/512',
      session_id: 'sess-1',
      state: 'open',
      human_merge_only: 1,
    } as ReturnType<typeof getPRByNotionTaskId>);
    const enqueueFeedback = vi.fn().mockResolvedValue(undefined);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      enqueueFeedback,
    });

    await sweeper.sweepOnce();

    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(enqueueFeedback).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'task_orphan_reverted' }),
    );
  });

  it('never sweeps a Design task at In Progress (exclusion not widened)', async () => {
    const backend = makeBackend([
      makeTask('notion:abc', '🔄 In Progress', '📐 Design'),
    ]);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(getLatestDocsSessionByTaskId).not.toHaveBeenCalled();
    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'task_orphan_reverted' }),
    );
  });

  it('resolves a docs session via getLatestDocsSessionByTaskId for the non-Code session lookup', async () => {
    // Guards the fall-through hazard: the non-Code branch must resolve a
    // docs-type session rather than always seeing undefined (which would
    // fall straight through to an unconditional revert).
    const backend = makeBackend([
      makeTask('notion:abc', '🔄 In Progress', '📝 Docs'),
    ]);
    vi.mocked(getLatestDocsSessionByTaskId).mockReturnValue(
      makeDocsSession('done', 30 * 60 * 1000) as ReturnType<
        typeof getLatestDocsSessionByTaskId
      >,
    );
    vi.mocked(hasNonTerminalPlanningSessionForTask).mockReturnValue(false);
    vi.mocked(getPRByNotionTaskId).mockReturnValue(null);
    vi.mocked(getLocalBranchBySession).mockReturnValue(undefined);
    vi.mocked(getSession).mockReturnValue({
      session_id: 'sess-1',
      session_type: 'docs',
      task_id: 'notion:abc',
    } as ReturnType<typeof getSession>);
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      { id: 'intent-1', kind: 'notion.pageEdit', state: 'staged' },
    ] as ReturnType<typeof listStagedIntentsBySession>);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });

    await sweeper.sweepOnce();

    expect(getLatestDocsSessionByTaskId).toHaveBeenCalledWith('notion:abc');
    // getLatestOpsSessionByTaskId is the ops-only lookup — must not be
    // consulted for a Docs task.
    expect(getLatestOpsSessionByTaskId).not.toHaveBeenCalled();
    expect(backend.updateStatus).not.toHaveBeenCalled();
  });

  it('leaves a Docs task alone when its only session is currently running (non-terminal)', async () => {
    // hasNonTerminalPlanningSessionForTask now includes 'docs' — a live
    // (non-terminal) docs session must never fall through to a revert, which
    // would re-dispatch a task actively being worked on.
    const backend = makeBackend([
      makeTask('notion:abc', '🔄 In Progress', '📝 Docs'),
    ]);
    vi.mocked(getLatestDocsSessionByTaskId).mockReturnValue(
      makeDocsSession('running', 30 * 60 * 1000) as ReturnType<
        typeof getLatestDocsSessionByTaskId
      >,
    );
    vi.mocked(hasNonTerminalPlanningSessionForTask).mockReturnValue(true);
    const enqueueFeedback = vi.fn().mockResolvedValue(undefined);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      enqueueFeedback,
    });

    await sweeper.sweepOnce();

    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(enqueueFeedback).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalledWith(
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
    vi.mocked(getPRByNotionTaskId).mockReturnValue(null);
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
    const enqueueFeedback = vi.fn().mockResolvedValue(undefined);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      enqueueFeedback,
      githubClient,
    });

    await sweeper.sweepOnce();

    // Nudge suppressed — PR already open on GitHub
    expect(enqueueFeedback).not.toHaveBeenCalled();
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
    vi.mocked(getPRByNotionTaskId).mockReturnValue(null);
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
    const enqueueFeedback = vi.fn().mockResolvedValue(undefined);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      enqueueFeedback,
      githubClient,
    });

    await sweeper.sweepOnce();

    // No matching PR — nudge proceeds normally
    expect(enqueueFeedback).toHaveBeenCalledWith(
      'sess-1',
      'system:nudge',
      expect.stringContaining('PR'),
    );
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
    vi.mocked(getPRByNotionTaskId).mockReturnValue(null);
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
    const enqueueFeedback = vi.fn().mockResolvedValue(undefined);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      enqueueFeedback,
      githubClient,
    });

    await sweeper.sweepOnce();

    // Fail-open: GitHub error doesn't prevent the nudge
    expect(enqueueFeedback).toHaveBeenCalledWith(
      'sess-1',
      'system:nudge',
      expect.stringContaining('PR'),
    );
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
    vi.mocked(getPRByNotionTaskId).mockReturnValue({
      id: 7,
      pr_number: 510,
      pr_url: 'https://github.com/o/r/pull/510',
      session_id: 'sess-1',
      state: 'open',
    } as ReturnType<typeof getPRByNotionTaskId>);
    const enqueueFeedback = vi.fn().mockResolvedValue(undefined);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      enqueueFeedback,
    });

    await sweeper.sweepOnce();

    // Stalled-PR idle path: session IS nudged (to act on review feedback),
    // referencing the existing PR rather than claiming none was opened.
    expect(enqueueFeedback).toHaveBeenCalledWith(
      'sess-1',
      'system:nudge',
      expect.stringContaining('#510'),
    );
    const [, , message] = enqueueFeedback.mock.calls[0];
    expect(message).not.toContain('no PR was opened');
    // Task is NOT reverted — open PR means session did its job
    expect(backend.updateStatus).not.toHaveBeenCalled();
  });

  it('idle session with an open human_merge_only PR is never nudged (legitimately waiting for a human merge)', async () => {
    const backend = makeBackend([makeTask('notion:abc')]);
    const endedAt = Date.now() - 10 * 60 * 1000;
    vi.mocked(getLatestCodeSessionByNotionTaskId).mockReturnValue(
      makeSession('idle', 30 * 60 * 1000, endedAt) as ReturnType<
        typeof getLatestCodeSessionByNotionTaskId
      >,
    );
    vi.mocked(getPRByNotionTaskId).mockReturnValue({
      id: 8,
      pr_number: 511,
      pr_url: 'https://github.com/o/r/pull/511',
      session_id: 'sess-1',
      state: 'open',
      human_merge_only: 1,
    } as ReturnType<typeof getPRByNotionTaskId>);
    const enqueueFeedback = vi.fn().mockResolvedValue(undefined);

    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
      enqueueFeedback,
    });

    await sweeper.sweepOnce();

    expect(enqueueFeedback).not.toHaveBeenCalled();
    expect(backend.updateStatus).not.toHaveBeenCalled();
  });
});
