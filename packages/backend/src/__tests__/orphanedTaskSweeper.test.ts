/**
 * Tests for OrphanedTaskSweeper.
 *
 * Verifies:
 * - Clean orphan revert: In Progress task with no live session → reverted to Ready
 * - Anti-race skip: task whose latest session started < 5 min ago → skipped
 * - Already-failed skip: task whose latest session is error|killed → skipped
 * - No-task-id edge case: tasks with empty id → skipped
 * - recordEvent and broadcast fire on revert
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () => ({
  getLatestCodeSessionByNotionTaskId: vi.fn(),
  hasActiveSessionForTask: vi.fn(),
  getPRBySessionId: vi.fn(() => null),
  getLocalBranchBySession: vi.fn(() => undefined),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../config.js', () => ({
  getAllProjects: vi.fn(),
  runtimeSettings: {
    auto_launch_poll_interval_ms: 60_000,
  },
}));

import {
  getLatestCodeSessionByNotionTaskId,
  hasActiveSessionForTask,
  getPRBySessionId,
  getLocalBranchBySession,
} from '../db/queries.js';
import { recordEvent } from '../audit/AuditLog.js';
import { getAllProjects } from '../config.js';
import { OrphanedTaskSweeper } from '../orchestration/OrphanedTaskSweeper.js';
import type { ServerMessage } from '../ws/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(id: string, status = '🔄 In Progress') {
  return {
    task: {
      id,
      title: 'Test Task',
      status,
      type: '💻 Code',
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
    vi.mocked(recordEvent).mockClear();
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

  it('skips tasks whose latest session is error', async () => {
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

    expect(backend.updateStatus).not.toHaveBeenCalled();
  });

  it('skips tasks whose latest session is killed', async () => {
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

    expect(backend.updateStatus).not.toHaveBeenCalled();
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
    expect(backend.updateStatus).not.toHaveBeenCalledWith('notion:abc', '🗂️ Ready');
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

  it('still reverts to Ready when the PR is open (genuinely incomplete orphan)', async () => {
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

    expect(backend.updateStatus).toHaveBeenCalledWith('notion:abc', '🗂️ Ready');
  });
});
