/**
 * AutoLauncher repo-assignment tests.
 *
 * AC:
 * - Single-repo project launches without an assignment (auto-resolved).
 * - Multi-repo task without assignment is skipped (needs_repo pause reason set).
 * - Multi-repo task with assignment launches into the correct repo.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedTask } from '../../notion/types';
import type { ProjectConfig } from '../../config';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../config.js', () => ({
  getAllProjects: vi.fn(),
  runtimeSettings: {
    auto_launch_concurrency: 2,
    auto_launch_poll_interval_ms: 60_000,
  },
}));

vi.mock('../../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi.fn(),
}));

vi.mock('../../db/queries.js', () => ({
  hasActiveSessionForTask: vi.fn().mockReturnValue(false),
  getPausedPrReasonForTask: vi.fn().mockReturnValue(null),
  getMergedPRForTask: vi.fn().mockReturnValue(null),
  setPauseReason: vi.fn(),
  setTaskPauseReason: vi.fn(),
  getTaskPauseReason: vi.fn().mockReturnValue(null),
  clearTaskPauseReason: vi.fn(),
  getTaskRepoAssignment: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../../projects/ProjectService.js', () => ({
  getProjectRepos: vi.fn().mockReturnValue([]),
}));

import { runtimeSettings } from '../../config.js';
import { getProjectRepos } from '../../projects/ProjectService.js';
import {
  hasActiveSessionForTask,
  getTaskPauseReason,
  setTaskPauseReason,
  getTaskRepoAssignment,
} from '../../db/queries.js';
import { AutoLauncher } from '../AutoLauncher.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeResolvedTask(id = 'task-1'): ResolvedTask {
  return {
    task: {
      id,
      title: 'Test Task',
      status: '🗂️ Ready',
      type: '💻 Code',
      dependsOn: [],
      notionUrl: '',
    },
    blocked: false,
  };
}

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: 'proj-1',
    name: 'Test Project',
    projectDir: '/fake/project',
    contextUrl: 'https://notion.so/ctx',
    boardId: 'board-1',
    taskSource: 'notion',
    gitMode: 'github',
    autoLaunchEnabled: true,
    autoLaunchMilestoneId: 'milestone-1',
    autoMergeEnabled: false,
    boards: [{ id: 'milestone-1', sourceId: 'notion-db-id', name: 'M1' }],
    ...overrides,
  };
}

function makeNotionBackend(tasks: ResolvedTask[]) {
  return {
    type: 'notion' as const,
    fetchReadyTasks: vi.fn().mockResolvedValue(tasks),
  };
}

function makeSessionManager() {
  return {
    getLiveCodeSessionCount: vi.fn().mockReturnValue(0),
    hasLiveSessionForTask: vi.fn().mockReturnValue(false),
    findLiveSessionIdForTask: vi.fn().mockReturnValue(undefined),
    start: vi.fn().mockResolvedValue('session-abc'),
    on: vi.fn(),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AutoLauncher — repo assignment at launch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasActiveSessionForTask).mockReturnValue(false);
    vi.mocked(getTaskPauseReason).mockReturnValue(null);
    vi.mocked(getTaskRepoAssignment).mockReturnValue(undefined);
    vi.mocked(getProjectRepos).mockReturnValue([]);
    (
      runtimeSettings as { auto_launch_concurrency: number }
    ).auto_launch_concurrency = 2;
  });

  it('single-repo project: launches without an assignment, auto-resolves to sole repo', async () => {
    vi.mocked(getProjectRepos).mockReturnValue(['owner/solo-repo']);
    const task = makeResolvedTask('task-single');
    const sm = makeSessionManager();
    const backend = makeNotionBackend([task]);

    const launcher = new AutoLauncher(sm as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(sm.start).toHaveBeenCalledOnce();
    const callArgs = sm.start.mock.calls[0][2];
    expect(callArgs.repo).toBe('owner/solo-repo');
    expect(setTaskPauseReason).not.toHaveBeenCalled();
  });

  it('multi-repo project with no assignment: skipped and needs_repo pause reason set', async () => {
    vi.mocked(getProjectRepos).mockReturnValue([
      'owner/repo-a',
      'owner/repo-b',
    ]);
    vi.mocked(getTaskRepoAssignment).mockReturnValue(undefined);

    const task = makeResolvedTask('task-multi-no-assign');
    const sm = makeSessionManager();
    const backend = makeNotionBackend([task]);

    const launcher = new AutoLauncher(sm as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(sm.start).not.toHaveBeenCalled();
    expect(setTaskPauseReason).toHaveBeenCalledWith(
      'task-multi-no-assign',
      'needs_repo',
      '',
    );
  });

  it('multi-repo project with assignment: launches with the assigned repo', async () => {
    vi.mocked(getProjectRepos).mockReturnValue([
      'owner/repo-a',
      'owner/repo-b',
    ]);
    vi.mocked(getTaskRepoAssignment).mockReturnValue({
      task_id: 'task-multi-assigned',
      project_id: 'proj-1',
      repo: 'owner/repo-b',
      assigned_by: 'user',
      assigned_at: Date.now(),
    });

    const task = makeResolvedTask('task-multi-assigned');
    const sm = makeSessionManager();
    const backend = makeNotionBackend([task]);

    const launcher = new AutoLauncher(sm as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(sm.start).toHaveBeenCalledOnce();
    const callArgs = sm.start.mock.calls[0][2];
    expect(callArgs.repo).toBe('owner/repo-b');
    expect(setTaskPauseReason).not.toHaveBeenCalled();
  });

  it('no-repo project (empty repos): launches without a resolved repo (repo is undefined)', async () => {
    vi.mocked(getProjectRepos).mockReturnValue([]);
    const task = makeResolvedTask('task-no-repo');
    const sm = makeSessionManager();
    const backend = makeNotionBackend([task]);

    const launcher = new AutoLauncher(sm as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(sm.start).toHaveBeenCalledOnce();
    const callArgs = sm.start.mock.calls[0][2];
    expect(callArgs.repo).toBeUndefined();
    expect(setTaskPauseReason).not.toHaveBeenCalled();
  });
});
