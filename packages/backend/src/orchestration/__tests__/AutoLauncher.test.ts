import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ResolvedTask } from '../../notion/types';
import type { ProjectConfig } from '../../config';
import { WorktreeSetupError } from '../../session/WorktreeSetupError.js';
import { mockDbQueries } from '../../__tests__/helpers/mockDbQueries';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../config.js', () => ({
  getAllProjects: vi.fn(),
  runtimeSettings: {
    auto_launch_concurrency: 2,
    auto_launch_poll_interval_ms: 60_000,
    min_host_free_memory_mb: 4096,
    per_session_reserve_mb: 3072,
  },
}));

vi.mock('../memoryAdmission.js', () => ({
  hasMemoryHeadroom: vi.fn().mockReturnValue(true),
}));

vi.mock('../../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi.fn(),
}));

vi.mock('../../db/queries.js', () =>
  mockDbQueries({
    hasActiveSessionForTask: vi.fn().mockReturnValue(false),
    getPausedPrReasonForTask: vi.fn().mockReturnValue(null),
    getMergedPRForTask: vi.fn().mockReturnValue(null),
    setPauseReason: vi.fn(),
    setTaskPauseReason: vi.fn(),
    getTaskPauseReason: vi.fn().mockReturnValue(null),
    clearTaskPauseReason: vi.fn(),
    clearPausedPrReasonForTask: vi.fn(),
    resetTaskCrashCount: vi.fn(),
    getTaskRepoAssignment: vi.fn().mockReturnValue(undefined),
  }),
);

vi.mock('../../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../../projects/ProjectService.js', () => ({
  getProjectRepos: vi.fn().mockReturnValue([]),
}));

import { runtimeSettings } from '../../config.js';
import {
  hasActiveSessionForTask,
  getPausedPrReasonForTask,
  getMergedPRForTask,
  setPauseReason,
  setTaskPauseReason,
  getTaskPauseReason,
  clearTaskPauseReason,
  clearPausedPrReasonForTask,
  resetTaskCrashCount,
} from '../../db/queries.js';
import { recordEvent } from '../../audit/AuditLog.js';
import {
  AutoLauncher,
  AutoLauncherFetchTimeoutError,
} from '../AutoLauncher.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeResolvedTask(
  overrides: Partial<ResolvedTask['task']> = {},
): ResolvedTask {
  return {
    task: {
      id: 'task-1',
      title: 'Test Task',
      status: '🗂️ Ready',
      type: '💻 Code',
      dependsOn: [],
      notionUrl: '',
      ...overrides,
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

function makeSessionManager(liveCount = 0) {
  return {
    getLiveCodeSessionCount: vi.fn().mockReturnValue(liveCount),
    hasLiveSessionForTask: vi.fn().mockReturnValue(false),
    findLiveSessionIdForTask: vi.fn().mockReturnValue(undefined),
    start: vi.fn().mockReturnValue('session-id-abc123'),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AutoLauncher — project-driven polling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasActiveSessionForTask).mockReturnValue(false);
    vi.mocked(getPausedPrReasonForTask).mockReturnValue(null);
    vi.mocked(getMergedPRForTask).mockReturnValue(null);
    vi.mocked(getTaskPauseReason).mockReturnValue(null);
    (
      runtimeSettings as { auto_launch_concurrency: number }
    ).auto_launch_concurrency = 2;
  });

  it('iterates projects with auto_launch_enabled=true and dispatches Ready+Code+unblocked tasks', async () => {
    const notionBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([makeResolvedTask()]),
    };
    const resolveBackend = vi.fn().mockReturnValue(notionBackend);
    const sessionManager = makeSessionManager(0);
    const proj = makeProject();

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [proj],
      resolveBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(resolveBackend).toHaveBeenCalledWith('proj-1');
    expect(notionBackend.fetchReadyTasks).toHaveBeenCalledWith(
      'milestone-1',
      true,
    );
    expect(sessionManager.start).toHaveBeenCalledOnce();
  });

  it('skips projects with auto_launch_enabled=false', async () => {
    const resolveBackend = vi.fn();
    const sessionManager = makeSessionManager(0);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject({ autoLaunchEnabled: false })],
      resolveBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(resolveBackend).not.toHaveBeenCalled();
    expect(sessionManager.start).not.toHaveBeenCalled();
  });

  it('skips YAML-mode (local backend) projects — AutoLauncher only handles notion/github backends', async () => {
    const localBackend = {
      type: 'local' as const,
      fetchReadyTasks: vi
        .fn()
        .mockResolvedValue([makeResolvedTask({ id: 'yaml-task-1' })]),
    };
    const resolveBackend = vi.fn().mockReturnValue(localBackend);
    const sessionManager = makeSessionManager(0);
    const proj = makeProject({
      taskSource: 'yaml',
      autoLaunchMilestoneId: null,
      boards: [],
    });

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [proj],
      resolveBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    // Local backends are skipped early — fetchReadyTasks and start are never called.
    expect(localBackend.fetchReadyTasks).not.toHaveBeenCalled();
    expect(sessionManager.start).not.toHaveBeenCalled();
  });

  it('fetches via NotionTaskBackend.fetchReadyTasks(milestoneId, true) for Notion-mode projects', async () => {
    const notionBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([makeResolvedTask()]),
    };
    const resolveBackend = vi.fn().mockReturnValue(notionBackend);
    const sessionManager = makeSessionManager(0);
    const proj = makeProject({ autoLaunchMilestoneId: 'milestone-42' });

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [proj],
      resolveBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(notionBackend.fetchReadyTasks).toHaveBeenCalledWith(
      'milestone-42',
      true,
    );
  });

  it('global concurrency cap throttles cross-source dispatch (cap=2, two in flight → no new launches)', async () => {
    const notionBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi
        .fn()
        .mockResolvedValue([makeResolvedTask({ id: 'notion-task-1' })]),
    };
    const resolveBackend = vi.fn().mockReturnValue(notionBackend);
    // cap=2, already 2 live sessions → no capacity
    const sessionManager = makeSessionManager(2);
    (
      runtimeSettings as { auto_launch_concurrency: number }
    ).auto_launch_concurrency = 2;

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(notionBackend.fetchReadyTasks).toHaveBeenCalledWith(
      'milestone-1',
      true,
    );
    expect(sessionManager.start).not.toHaveBeenCalled();
  });

  it('cap=2, one session in flight → launches up to cap using notion backend', async () => {
    const notionBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi
        .fn()
        .mockResolvedValue([
          makeResolvedTask({ id: 'notion-task-1' }),
          makeResolvedTask({ id: 'notion-task-2' }),
        ]),
    };
    const resolveBackend = vi.fn().mockReturnValue(notionBackend);
    // 1 session already in flight; cap=2 → can launch at least 1 more
    const sessionManager = makeSessionManager(1);
    (
      runtimeSettings as { auto_launch_concurrency: number }
    ).auto_launch_concurrency = 2;

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    // With cap=2 and liveCount=1, at least 1 task should be launched.
    expect(sessionManager.start).toHaveBeenCalled();
  });

  it('skips tasks that are blocked', async () => {
    const localBackend = {
      type: 'local' as const,
      fetchReadyTasks: vi
        .fn()
        .mockResolvedValue([{ task: makeResolvedTask().task, blocked: true }]),
    };
    const resolveBackend = vi.fn().mockReturnValue(localBackend);
    const sessionManager = makeSessionManager(0);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [
        makeProject({
          taskSource: 'yaml',
          autoLaunchMilestoneId: null,
          boards: [],
        }),
      ],
      resolveBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(sessionManager.start).not.toHaveBeenCalled();
  });

  it('skips tasks that have a PR pause reason', async () => {
    vi.mocked(getPausedPrReasonForTask).mockReturnValue('stuck_timeout');
    const localBackend = {
      type: 'local' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([makeResolvedTask()]),
    };
    const resolveBackend = vi.fn().mockReturnValue(localBackend);
    const sessionManager = makeSessionManager(0);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [
        makeProject({
          taskSource: 'yaml',
          autoLaunchMilestoneId: null,
          boards: [],
        }),
      ],
      resolveBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(sessionManager.start).not.toHaveBeenCalled();
  });

  it('Notion-mode project without milestone configured is skipped', async () => {
    const notionBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([]),
    };
    const resolveBackend = vi.fn().mockReturnValue(notionBackend);
    const sessionManager = makeSessionManager(0);
    const proj = makeProject({ autoLaunchMilestoneId: null, boards: [] });

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [proj],
      resolveBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(notionBackend.fetchReadyTasks).not.toHaveBeenCalled();
    expect(sessionManager.start).not.toHaveBeenCalled();
  });

  it('Notion-mode regression: dispatches Ready tasks via milestone (unchanged behavior)', async () => {
    const notionBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi
        .fn()
        .mockResolvedValue([makeResolvedTask({ id: 'notion-task-1' })]),
    };
    const resolveBackend = vi.fn().mockReturnValue(notionBackend);
    const sessionManager = makeSessionManager(0);
    const proj = makeProject({
      taskSource: 'notion',
      autoLaunchMilestoneId: 'milestone-1',
    });

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [proj],
      resolveBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(notionBackend.fetchReadyTasks).toHaveBeenCalledWith(
      'milestone-1',
      true,
    );
    expect(sessionManager.start).toHaveBeenCalledOnce();
  });

  it('launches a Ready, dependency-free Code task whose only prior session was an idle groom session', async () => {
    // findLiveSessionIdForTask excludes planning sessions (groom/design/ops)
    // even when idle/non-terminal — a dispatched groom session parking idle
    // after flipping the task to Ready must not block the coding launch.
    const notionBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi
        .fn()
        .mockResolvedValue([makeResolvedTask({ id: 'task-groomed' })]),
    };
    const resolveBackend = vi.fn().mockReturnValue(notionBackend);
    const sessionManager = makeSessionManager(0);
    sessionManager.findLiveSessionIdForTask = vi
      .fn()
      .mockReturnValue(undefined);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [
        makeProject({
          taskSource: 'notion',
          autoLaunchMilestoneId: 'milestone-1',
        }),
      ],
      resolveBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(sessionManager.start).toHaveBeenCalledOnce();
  });

  it('does not launch if session already active for task (in-memory check)', async () => {
    const localBackend = {
      type: 'local' as const,
      fetchReadyTasks: vi
        .fn()
        .mockResolvedValue([makeResolvedTask({ id: 'task-active' })]),
    };
    const resolveBackend = vi.fn().mockReturnValue(localBackend);
    const sessionManager = makeSessionManager(0);
    sessionManager.findLiveSessionIdForTask = vi
      .fn()
      .mockReturnValue('live-session-xyz');

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [
        makeProject({
          taskSource: 'yaml',
          autoLaunchMilestoneId: null,
          boards: [],
        }),
      ],
      resolveBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(sessionManager.start).not.toHaveBeenCalled();
  });

  it('logs task id and live session id when skipping a candidate due to an existing live session', async () => {
    // Use a notion-mode backend (not 'local') so processProject reaches
    // isLaunchCandidate/launchTask instead of short-circuiting at the
    // backend.type === 'local' guard.
    const notionBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi
        .fn()
        .mockResolvedValue([makeResolvedTask({ id: 'task-active' })]),
    };
    const resolveBackend = vi.fn().mockReturnValue(notionBackend);
    const sessionManager = makeSessionManager(0);
    sessionManager.findLiveSessionIdForTask = vi
      .fn()
      .mockReturnValue('live-session-xyz');

    const { logger } = await import('../../logger.js');
    const infoSpy = vi.spyOn(logger, 'info');

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [
        makeProject({
          taskSource: 'notion',
          autoLaunchMilestoneId: 'milestone-1',
        }),
      ],
      resolveBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(sessionManager.start).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('task-active'),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('live-session-xyz'),
    );
  });

  it('does not launch if session already active for task (DB check)', async () => {
    vi.mocked(hasActiveSessionForTask).mockReturnValue(true);
    const localBackend = {
      type: 'local' as const,
      fetchReadyTasks: vi
        .fn()
        .mockResolvedValue([makeResolvedTask({ id: 'task-db-active' })]),
    };
    const resolveBackend = vi.fn().mockReturnValue(localBackend);
    const sessionManager = makeSessionManager(0);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [
        makeProject({
          taskSource: 'yaml',
          autoLaunchMilestoneId: null,
          boards: [],
        }),
      ],
      resolveBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(sessionManager.start).not.toHaveBeenCalled();
  });

  // ── Merged PR skip tests ───────────────────────────────────────────────────

  it('skips task with merged PR and updates Notion status to Done', async () => {
    const mergedPR = {
      id: 1,
      pr_number: 117,
      pr_url: 'https://github.com/owner/repo/pull/117',
      task_id: 'task-1',
      state: 'merged',
      repo: 'owner/repo',
    };
    vi.mocked(getMergedPRForTask).mockReturnValue(mergedPR as never);

    const updateStatus = vi.fn().mockResolvedValue(undefined);
    const notionBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([makeResolvedTask()]),
      updateStatus,
    };
    const resolveBackend = vi.fn().mockReturnValue(notionBackend);
    const sessionManager = makeSessionManager(0);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(sessionManager.start).not.toHaveBeenCalled();
    expect(updateStatus).toHaveBeenCalledWith('task-1', '✅ Done');
  });

  it('launches task when PR exists but is open (not merged)', async () => {
    // getMergedPRForTask returns null for open PRs (already the default mock,
    // but explicitly set here for clarity)
    vi.mocked(getMergedPRForTask).mockReturnValue(null);

    const notionBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([makeResolvedTask()]),
    };
    const resolveBackend = vi.fn().mockReturnValue(notionBackend);
    const sessionManager = makeSessionManager(0);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(sessionManager.start).toHaveBeenCalledOnce();
  });

  it('launches task when no PR exists', async () => {
    vi.mocked(getMergedPRForTask).mockReturnValue(null);

    const notionBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([makeResolvedTask()]),
    };
    const resolveBackend = vi.fn().mockReturnValue(notionBackend);
    const sessionManager = makeSessionManager(0);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(sessionManager.start).toHaveBeenCalledOnce();
  });

  it('launches task when PR is closed (not merged) — treat as failed previous attempt', async () => {
    // getMergedPRForTask queries for state='merged' only, so closed returns null
    vi.mocked(getMergedPRForTask).mockReturnValue(null);

    const notionBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([makeResolvedTask()]),
    };
    const resolveBackend = vi.fn().mockReturnValue(notionBackend);
    const sessionManager = makeSessionManager(0);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(sessionManager.start).toHaveBeenCalledOnce();
  });

  it('catches task-backend update failure gracefully — does not throw, still skips launch', async () => {
    const mergedPR = {
      id: 1,
      pr_number: 117,
      pr_url: 'https://github.com/owner/repo/pull/117',
      task_id: 'task-1',
      state: 'merged',
      repo: 'owner/repo',
    };
    vi.mocked(getMergedPRForTask).mockReturnValue(mergedPR as never);

    const updateStatus = vi
      .fn()
      .mockRejectedValue(new Error('Notion API down'));
    const notionBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([makeResolvedTask()]),
      updateStatus,
    };
    const resolveBackend = vi.fn().mockReturnValue(notionBackend);
    const sessionManager = makeSessionManager(0);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend,
      pollOnStart: false,
    });

    // Should not throw even when updateStatus fails
    await expect(launcher.pollOnce()).resolves.toBeUndefined();
    expect(sessionManager.start).not.toHaveBeenCalled();
  });
});

// ── Timeout tests ─────────────────────────────────────────────────────────────

describe('AutoLauncher — fetch timeouts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(hasActiveSessionForTask).mockReturnValue(false);
    vi.mocked(getPausedPrReasonForTask).mockReturnValue(null);
    vi.mocked(getMergedPRForTask).mockReturnValue(null);
    (
      runtimeSettings as { auto_launch_concurrency: number }
    ).auto_launch_concurrency = 2;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetchReadyTasks timeout: AutoLauncherFetchTimeoutError caught at outer try, project loop continues to next project', async () => {
    const hangingBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockReturnValue(new Promise(() => {})),
    };
    const fastBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([]),
    };
    let callCount = 0;
    const resolveBackend = vi.fn().mockImplementation(() => {
      return callCount++ === 0 ? hangingBackend : fastBackend;
    });
    const sessionManager = makeSessionManager(0);

    const proj1 = makeProject({ id: 'proj-1' });
    const proj2 = makeProject({ id: 'proj-2' });

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [proj1, proj2],
      resolveBackend,
      pollOnStart: false,
    });

    const pollPromise = launcher.pollOnce();
    await vi.advanceTimersByTimeAsync(30_001);
    await pollPromise;

    // Both projects were attempted
    expect(resolveBackend).toHaveBeenCalledTimes(2);
    // fetchReadyTasks on first project hung and timed out
    expect(hangingBackend.fetchReadyTasks).toHaveBeenCalledOnce();
    // Second project completed normally
    expect(fastBackend.fetchReadyTasks).toHaveBeenCalledOnce();
    // No sessions launched
    expect(sessionManager.start).not.toHaveBeenCalled();
  });

  it('fetchReadyTasks timeout rejects with AutoLauncherFetchTimeoutError', async () => {
    let capturedError: unknown;
    const hangingBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockReturnValue(new Promise(() => {})),
    };
    const resolveBackend = vi.fn().mockReturnValue(hangingBackend);
    const sessionManager = makeSessionManager(0);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend,
      pollOnStart: false,
    });

    // Intercept the error logged at the outer try/catch
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation((...args) => {
        capturedError = args[1];
      });

    const pollPromise = launcher.pollOnce();
    await vi.advanceTimersByTimeAsync(30_001);
    await pollPromise;

    expect(capturedError).toBeInstanceOf(AutoLauncherFetchTimeoutError);
    expect((capturedError as AutoLauncherFetchTimeoutError).message).toContain(
      'timed out after 30000ms',
    );

    errorSpy.mockRestore();
  });

  it('updateStatus timeout: caught gracefully, project loop continues', async () => {
    const mergedPR = {
      id: 1,
      pr_number: 42,
      pr_url: 'https://github.com/x/y/pull/42',
      task_id: 'task-1',
      state: 'merged',
      repo: 'x/y',
    };
    vi.mocked(getMergedPRForTask).mockReturnValue(mergedPR as never);

    const hangingBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([makeResolvedTask()]),
      updateStatus: vi.fn().mockReturnValue(new Promise(() => {})),
    };
    const resolveBackend = vi.fn().mockReturnValue(hangingBackend);
    const sessionManager = makeSessionManager(0);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend,
      pollOnStart: false,
    });

    const pollPromise = launcher.pollOnce();
    await vi.advanceTimersByTimeAsync(30_001);
    await pollPromise;

    expect(hangingBackend.updateStatus).toHaveBeenCalledWith(
      'task-1',
      '✅ Done',
    );
    // pollOnce resolved without throwing
    expect(sessionManager.start).not.toHaveBeenCalled();
  });
});

// ── Tick log tests ────────────────────────────────────────────────────────────

describe('AutoLauncher — tick logs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasActiveSessionForTask).mockReturnValue(false);
    vi.mocked(getPausedPrReasonForTask).mockReturnValue(null);
    vi.mocked(getMergedPRForTask).mockReturnValue(null);
    (
      runtimeSettings as { auto_launch_concurrency: number }
    ).auto_launch_concurrency = 2;
    (
      runtimeSettings as { auto_launch_poll_interval_ms: number }
    ).auto_launch_poll_interval_ms = 60_000;
  });

  it('emits poll start and poll complete on every cycle', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const notionBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([]),
    };
    const resolveBackend = vi.fn().mockReturnValue(notionBackend);
    const sessionManager = makeSessionManager(0);
    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();
    await launcher.pollOnce();

    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(
      calls.some((c) => c.includes('[AutoLauncher] poll start cycle=1')),
    ).toBe(true);
    expect(
      calls.some((c) => c.includes('[AutoLauncher] poll complete cycle=1')),
    ).toBe(true);
    expect(
      calls.some((c) => c.includes('[AutoLauncher] poll start cycle=2')),
    ).toBe(true);
    expect(
      calls.some((c) => c.includes('[AutoLauncher] poll complete cycle=2')),
    ).toBe(true);

    logSpy.mockRestore();
  });

  it('poll complete log includes eligible, launched, skipped, and durationMs fields', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const notionBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([makeResolvedTask()]),
    };
    const resolveBackend = vi.fn().mockReturnValue(notionBackend);
    const sessionManager = makeSessionManager(0);
    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    const completeLog = calls.find((c) => c.includes('poll complete cycle=1'));
    expect(completeLog).toBeDefined();
    expect(completeLog).toMatch(/eligible=\d+/);
    expect(completeLog).toMatch(/launched=\d+/);
    expect(completeLog).toMatch(/skipped=\d+/);
    expect(completeLog).toMatch(/durationMs=\d+/);

    logSpy.mockRestore();
  });

  it('start log precedes complete log within the same cycle', async () => {
    const logOrder: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logOrder.push(String(args[0]));
    });
    const notionBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([]),
    };
    const resolveBackend = vi.fn().mockReturnValue(notionBackend);
    const sessionManager = makeSessionManager(0);
    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    const startIdx = logOrder.findIndex((l) =>
      l.includes('poll start cycle=1'),
    );
    const completeIdx = logOrder.findIndex((l) =>
      l.includes('poll complete cycle=1'),
    );
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(completeIdx).toBeGreaterThan(startIdx);

    logSpy.mockRestore();
  });

  it('does not run a poll cycle while one is already in progress', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let resolveFetch: (() => void) | undefined;
    const notionBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn(
        () =>
          new Promise<never[]>((res) => {
            resolveFetch = () => res([]);
          }),
      ),
    };
    const resolveBackend = vi.fn().mockReturnValue(notionBackend);
    const sessionManager = makeSessionManager(0);
    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend,
      pollOnStart: false,
    });

    const first = launcher.pollOnce();
    await launcher.pollOnce(); // skipped — a cycle is already running

    expect(notionBackend.fetchReadyTasks).toHaveBeenCalledTimes(1);

    resolveFetch?.();
    await first;

    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes('poll start cycle=1'))).toBe(true);
    expect(calls.some((c) => c.includes('poll complete cycle=1'))).toBe(true);
    // The skipped call never entered runPollCycle, so no cycle=2 appears.
    expect(calls.some((c) => c.includes('poll start cycle=2'))).toBe(false);

    logSpy.mockRestore();
  });
});

// ── Backoff + audit trail tests ───────────────────────────────────────────────

describe('AutoLauncher — Notion Done-update backoff', () => {
  const mergedPR = {
    id: 1,
    pr_number: 200,
    pr_url: 'https://github.com/owner/repo/pull/200',
    task_id: 'task-1',
    state: 'merged',
    repo: 'owner/repo',
  };

  function makeBackoffBackend(updateStatus: ReturnType<typeof vi.fn>) {
    return {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([makeResolvedTask()]),
      updateStatus,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(hasActiveSessionForTask).mockReturnValue(false);
    vi.mocked(getPausedPrReasonForTask).mockReturnValue(null);
    vi.mocked(getMergedPRForTask).mockReturnValue(mergedPR as never);
    (
      runtimeSettings as { auto_launch_concurrency: number }
    ).auto_launch_concurrency = 2;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('5 consecutive failures progress through backoff schedule with correct nextRetryAt', async () => {
    const BACKOFF = [60_000, 300_000, 900_000, 3_600_000];
    const updateStatus = vi.fn().mockRejectedValue(new Error('Notion down'));
    const backend = makeBackoffBackend(updateStatus);
    const resolveBackend = vi.fn().mockReturnValue(backend);
    const sessionManager = makeSessionManager(0);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend,
      pollOnStart: false,
    });

    const map = (launcher as unknown as Record<string, unknown>)
      .notionUpdateAttempts as Map<
      string,
      { count: number; nextRetryAt: number; lastError: string }
    >;

    for (let attempt = 1; attempt <= 5; attempt++) {
      const before = Date.now();
      await launcher.pollOnce();
      const entry = map.get('task-1');
      expect(entry).toBeDefined();
      expect(entry!.count).toBe(attempt);
      const expectedBackoff =
        BACKOFF[Math.min(attempt - 1, BACKOFF.length - 1)];
      expect(entry!.nextRetryAt).toBeGreaterThanOrEqual(
        before + expectedBackoff,
      );

      // Advance past the cooldown so next attempt fires
      await vi.advanceTimersByTimeAsync(expectedBackoff + 1);
    }
  });

  it('success clears the backoff entry', async () => {
    const updateStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('Notion down'))
      .mockResolvedValue(undefined);
    const backend = makeBackoffBackend(updateStatus);
    const resolveBackend = vi.fn().mockReturnValue(backend);
    const sessionManager = makeSessionManager(0);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend,
      pollOnStart: false,
    });

    const map = (launcher as unknown as Record<string, unknown>)
      .notionUpdateAttempts as Map<
      string,
      { count: number; nextRetryAt: number; lastError: string }
    >;

    // First poll: failure → entry created
    await launcher.pollOnce();
    expect(map.has('task-1')).toBe(true);

    // Advance past cooldown (60s after first failure)
    await vi.advanceTimersByTimeAsync(60_001);

    // Second poll: success → entry cleared
    await launcher.pollOnce();
    expect(map.has('task-1')).toBe(false);
  });

  it('audit row fires exactly once at attempt 5 and not at 6 or 7', async () => {
    const BACKOFF = [60_000, 300_000, 900_000, 3_600_000];
    const updateStatus = vi.fn().mockRejectedValue(new Error('Notion down'));
    const backend = makeBackoffBackend(updateStatus);
    const resolveBackend = vi.fn().mockReturnValue(backend);
    const sessionManager = makeSessionManager(0);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend,
      pollOnStart: false,
    });

    // Run 7 consecutive failures
    for (let i = 1; i <= 7; i++) {
      await launcher.pollOnce();
      const backoff = BACKOFF[Math.min(i - 1, BACKOFF.length - 1)];
      await vi.advanceTimersByTimeAsync(backoff + 1);
    }

    // recordEvent called exactly once (at attempt 5)
    expect(vi.mocked(recordEvent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'auto_launch_done_update_stuck',
        actor_type: 'system',
        task_id: 'task-1',
        payload: expect.objectContaining({ attempts: 5 }),
      }),
    );

    // setPauseReason called exactly once
    expect(vi.mocked(setPauseReason)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setPauseReason)).toHaveBeenCalledWith(
      mergedPR.pr_number,
      mergedPR.repo,
      'notion_done_update_stuck',
    );
  });

  it('tasks with nextRetryAt > now are skipped without calling updateStatus', async () => {
    const updateStatus = vi.fn().mockRejectedValue(new Error('Notion down'));
    const backend = makeBackoffBackend(updateStatus);
    const resolveBackend = vi.fn().mockReturnValue(backend);
    const sessionManager = makeSessionManager(0);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend,
      pollOnStart: false,
    });

    // First failure → enters 60s cooldown
    await launcher.pollOnce();
    expect(updateStatus).toHaveBeenCalledTimes(1);

    // Poll again immediately (still in cooldown) → updateStatus NOT called again
    await launcher.pollOnce();
    expect(updateStatus).toHaveBeenCalledTimes(1);

    // Advance past the cooldown
    await vi.advanceTimersByTimeAsync(60_001);

    // Now poll → updateStatus called again
    await launcher.pollOnce();
    expect(updateStatus).toHaveBeenCalledTimes(2);
  });

  it('warn log includes attempt count and next retry duration', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updateStatus = vi.fn().mockRejectedValue(new Error('Notion down'));
    const backend = makeBackoffBackend(updateStatus);
    const resolveBackend = vi.fn().mockReturnValue(backend);
    const sessionManager = makeSessionManager(0);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    const calls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(
      calls.some(
        (c) => c.includes('attempt 1') && c.includes('next retry in 60s'),
      ),
    ).toBe(true);

    warnSpy.mockRestore();
  });
});

// ── Launch-failure tracking tests ─────────────────────────────────────────────
//
// launch_failed is in UNCOUNTED_REASONS (SessionManager) so it never touches
// the crash budget. AutoLauncher owns per-task cooldown via onSessionLaunchFailed
// (triggered by session_launch_failed messages from SessionManager) and escalates
// to needs_attention after 3 consecutive failures.

describe('AutoLauncher — launch failure tracking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(hasActiveSessionForTask).mockReturnValue(false);
    vi.mocked(getPausedPrReasonForTask).mockReturnValue(null);
    vi.mocked(getMergedPRForTask).mockReturnValue(null);
    vi.mocked(getTaskPauseReason).mockReturnValue(null);
    (
      runtimeSettings as { auto_launch_concurrency: number }
    ).auto_launch_concurrency = 2;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeFailingBackend(task = makeResolvedTask()) {
    return {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([task]),
    };
  }

  interface TestCrashBudget {
    inCooldown(taskId: string): boolean;
  }

  function getCrashBudget(launcher: AutoLauncher): TestCrashBudget {
    return (launcher as unknown as { crashBudget: TestCrashBudget })
      .crashBudget;
  }

  function fireLaunchFailed(launcher: AutoLauncher, taskId: string): void {
    (
      launcher as unknown as {
        onSessionLaunchFailed: (id: string) => void;
      }
    ).onSessionLaunchFailed(taskId);
  }

  function fireSessionStarted(launcher: AutoLauncher, taskId: string): void {
    (
      launcher as unknown as {
        onSessionStarted: (id: string) => void;
      }
    ).onSessionStarted(taskId);
  }

  it('task is skipped during cooldown after launch_failed', async () => {
    const task = makeResolvedTask({ id: 'task-cooldown' });
    const backend = makeFailingBackend(task);
    const sessionManager = makeSessionManager(0);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend as never,
      pollOnStart: false,
    });

    // Simulate one launch_failed notification (as SessionManager would emit)
    fireLaunchFailed(launcher, 'task-cooldown');

    backend.fetchReadyTasks.mockResolvedValue([task]);
    await launcher.pollOnce();

    // Task is in cooldown → not launched
    expect(sessionManager.start).not.toHaveBeenCalled();
  });

  it('first launch_failed applies a cooldown longer than the poll interval', async () => {
    const task = makeResolvedTask({ id: 'task-backoff1' });
    const backend = makeFailingBackend(task);
    const sessionManager = makeSessionManager(0);
    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend as never,
      pollOnStart: false,
    });

    fireLaunchFailed(launcher, 'task-backoff1');

    const budget = getCrashBudget(launcher);
    expect(budget.inCooldown('task-backoff1')).toBe(true);
    // Still in cooldown just before 90s.
    await vi.advanceTimersByTimeAsync(89_999);
    expect(budget.inCooldown('task-backoff1')).toBe(true);
    // Cooldown clears once the 90s window elapses.
    await vi.advanceTimersByTimeAsync(2);
    expect(budget.inCooldown('task-backoff1')).toBe(false);
  });

  it('first-tier cooldown outlasts the configured auto-launch poll interval', () => {
    // Regression guard for the observed 95-session loop: a first-tier cooldown
    // shorter than the poll interval gates nothing, since the next poll always
    // arrives before the cooldown expires. Assert the relationship directly
    // rather than assuming the two independently-tuned constants stay aligned.
    const launcher = new AutoLauncher(
      makeSessionManager(0) as never,
      undefined,
      { listProjects: () => [], pollOnStart: false },
    );
    const firstTierCooldownMs = (
      launcher as unknown as {
        crashBudget: { recordEvent(id: string): { cooldownMs: number } };
      }
    ).crashBudget.recordEvent('task-poll-interval-check').cooldownMs;

    expect(firstTierCooldownMs).toBeGreaterThan(
      runtimeSettings.auto_launch_poll_interval_ms,
    );
  });

  it('second launch_failed applies 2m cooldown', async () => {
    const launcher = new AutoLauncher(
      makeSessionManager(0) as never,
      undefined,
      {
        listProjects: () => [],
        pollOnStart: false,
      },
    );

    fireLaunchFailed(launcher, 'task-backoff2');
    fireLaunchFailed(launcher, 'task-backoff2');

    const budget = getCrashBudget(launcher);
    // Still in cooldown just before 2m — the second event's longer window.
    await vi.advanceTimersByTimeAsync(2 * 60_000 - 1);
    expect(budget.inCooldown('task-backoff2')).toBe(true);
    await vi.advanceTimersByTimeAsync(2);
    expect(budget.inCooldown('task-backoff2')).toBe(false);
  });

  it('task is launched again after cooldown expires', async () => {
    const task = makeResolvedTask({ id: 'task-retry' });
    const backend = makeFailingBackend(task);
    const sessionManager = makeSessionManager(0);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend as never,
      pollOnStart: false,
    });

    fireLaunchFailed(launcher, 'task-retry');

    // Still in cooldown — skipped
    backend.fetchReadyTasks.mockResolvedValue([task]);
    await launcher.pollOnce();
    expect(sessionManager.start).not.toHaveBeenCalled();

    // Advance past the 90s cooldown
    await vi.advanceTimersByTimeAsync(90_001);

    // Now should launch
    await launcher.pollOnce();
    expect(sessionManager.start).toHaveBeenCalledOnce();
  });

  it('three consecutive launch failures produce counts 1, 2, 3 with escalating cooldowns and escalated:true on the third', () => {
    const launcher = new AutoLauncher(
      makeSessionManager(0) as never,
      undefined,
      { listProjects: () => [], pollOnStart: false },
    );
    const budget = (
      launcher as unknown as {
        crashBudget: {
          recordEvent(id: string): {
            count: number;
            escalated: boolean;
            cooldownMs: number;
          };
        };
      }
    ).crashBudget;

    const first = budget.recordEvent('task-escalate-counts');
    expect(first).toMatchObject({ count: 1, escalated: false });
    const second = budget.recordEvent('task-escalate-counts');
    expect(second).toMatchObject({ count: 2, escalated: false });
    expect(second.cooldownMs).toBeGreaterThan(first.cooldownMs);
    const third = budget.recordEvent('task-escalate-counts');
    expect(third).toMatchObject({ count: 3, escalated: true });
    expect(third.cooldownMs).toBeGreaterThan(second.cooldownMs);
  });

  it('after 3 consecutive launch_failed, escalates to needs_attention via setTaskPauseReason', () => {
    const launcher = new AutoLauncher(
      makeSessionManager(0) as never,
      undefined,
      {
        listProjects: () => [],
        pollOnStart: false,
      },
    );

    fireLaunchFailed(launcher, 'task-escalate');
    fireLaunchFailed(launcher, 'task-escalate');
    fireLaunchFailed(launcher, 'task-escalate');

    expect(setTaskPauseReason).toHaveBeenCalledWith(
      'task-escalate',
      'launch_failed',
      'launch_failed_escalated',
    );
  });

  it('deterministic repeatable launch failures produce at most escalateAfter sessions (regression for the 95-session loop)', async () => {
    // Mirrors the observed bug: dispatch succeeds synchronously (start()
    // resolves — the worktree-add failure only surfaces later, in the
    // fire-and-forget chain, as an async session_launch_failed message) but
    // the launch never actually succeeds, so session_started never fires and
    // the crash budget is never cleared. Each poll cycle that finds the task
    // still eligible re-dispatches and re-fails identically, at the observed
    // ~poll-interval cadence.
    const task = makeResolvedTask({ id: 'task-loop-guard' });
    const backend = makeFailingBackend(task);
    const sessionManager = makeSessionManager(0);
    sessionManager.start.mockResolvedValue('session-id-abc123');

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend as never,
      pollOnStart: false,
    });

    for (let i = 0; i < 20; i++) {
      backend.fetchReadyTasks.mockResolvedValue([task]);
      await launcher.pollOnce();
      // The launch never confirms success — simulate the async
      // session_launch_failed notification that follows every dispatch.
      fireLaunchFailed(launcher, 'task-loop-guard');
      // isLaunchCandidate must observe the escalated pause reason once set.
      if (vi.mocked(setTaskPauseReason).mock.calls.length > 0) {
        vi.mocked(getTaskPauseReason).mockImplementation((id) =>
          id === 'task-loop-guard' ? 'needs_attention' : null,
        );
      }
      await vi.advanceTimersByTimeAsync(
        runtimeSettings.auto_launch_poll_interval_ms,
      );
    }

    expect(sessionManager.start.mock.calls.length).toBeLessThanOrEqual(3);
    vi.mocked(getTaskPauseReason).mockReturnValue(null);
    vi.mocked(setTaskPauseReason).mockClear();
  });

  it('escalated task is skipped by isLaunchCandidate via getTaskPauseReason gate', async () => {
    const task = makeResolvedTask({ id: 'task-budget-blocked' });
    const backend = makeFailingBackend(task);
    const sessionManager = makeSessionManager(0);

    vi.mocked(getTaskPauseReason).mockImplementation((id) =>
      id === 'task-budget-blocked' ? 'needs_attention' : null,
    );

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend as never,
      pollOnStart: false,
    });

    backend.fetchReadyTasks.mockResolvedValue([task]);
    await launcher.pollOnce();

    expect(sessionManager.start).not.toHaveBeenCalled();

    vi.mocked(getTaskPauseReason).mockReturnValue(null);
  });

  it('dispatching a launch (start() resolving) does NOT clear the crash budget on its own', async () => {
    const task = makeResolvedTask({ id: 'task-dispatch-only' });
    const backend = makeFailingBackend(task);
    const sessionManager = makeSessionManager(0);
    sessionManager.start.mockResolvedValue('session-ok');

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend as never,
      pollOnStart: false,
    });

    // Simulate a prior launch_failed
    fireLaunchFailed(launcher, 'task-dispatch-only');
    expect(getCrashBudget(launcher).inCooldown('task-dispatch-only')).toBe(
      true,
    );

    // Advance past cooldown so the task is eligible again, then dispatch.
    await vi.advanceTimersByTimeAsync(90_001);
    backend.fetchReadyTasks.mockResolvedValue([task]);
    await launcher.pollOnce();

    expect(sessionManager.start).toHaveBeenCalledOnce();
    // Dispatch alone (start() resolving) must NOT clear the record of the
    // prior failure — only a confirmed session_started does. Clearing here
    // is exactly the bug: it wipes the failure history before the outcome
    // of this launch is known.
    expect(clearTaskPauseReason).not.toHaveBeenCalledWith('task-dispatch-only');
  });

  it('successful launch (confirmed via session_started) resets the count to zero and clears the persisted pause reason', async () => {
    const launcher = new AutoLauncher(
      makeSessionManager(0) as never,
      undefined,
      { listProjects: () => [], pollOnStart: false },
    );

    // Simulate a prior failure.
    fireLaunchFailed(launcher, 'task-confirmed-success');
    expect(getCrashBudget(launcher).inCooldown('task-confirmed-success')).toBe(
      true,
    );

    // The launch is later confirmed successful via session_started.
    fireSessionStarted(launcher, 'task-confirmed-success');

    expect(clearTaskPauseReason).toHaveBeenCalledWith('task-confirmed-success');
    expect(getCrashBudget(launcher).inCooldown('task-confirmed-success')).toBe(
      false,
    );

    // The count is truly reset to zero, not just out of cooldown: a
    // subsequent failure is treated as attempt 1 again with the first-tier
    // cooldown, not a continuation of the prior streak.
    const outcome = (
      launcher as unknown as {
        crashBudget: {
          recordEvent(id: string): { count: number; cooldownMs: number };
        };
      }
    ).crashBudget.recordEvent('task-confirmed-success');
    expect(outcome.count).toBe(1);
  });

  it('task is not retried when getTaskPauseReason returns non-null (needs_attention persisted)', async () => {
    const task = makeResolvedTask({ id: 'task-db-pause' });
    vi.mocked(getTaskPauseReason).mockImplementation((id) =>
      id === 'task-db-pause' ? 'needs_attention' : null,
    );
    const backend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([task]),
    };
    const sessionManager = makeSessionManager(0);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend as never,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(sessionManager.start).not.toHaveBeenCalled();

    vi.mocked(getTaskPauseReason).mockReturnValue(null);
  });

  it('warn log includes full stderr when a WorktreeSetupError is thrown synchronously', async () => {
    const task = makeResolvedTask({ id: 'task-stderr' });
    const backend = makeFailingBackend(task);
    const sessionManager = makeSessionManager(0);
    const stderrMsg = "fatal: A branch named 'feature/my-task' already exists.";
    sessionManager.start.mockImplementation(() => {
      throw new WorktreeSetupError(
        `Command failed: git worktree add -b\nstderr: ${stderrMsg}`,
        { isBranchAlreadyExists: true },
      );
    });

    const warnCalls: string[] = [];
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation((...args) => warnCalls.push(String(args[0])));

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend as never,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(warnCalls.some((w) => w.includes(stderrMsg))).toBe(true);
    warnSpy.mockRestore();
  });
});

// ── Parallel project iteration tests ─────────────────────────────────────────

describe('AutoLauncher — parallel project iteration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasActiveSessionForTask).mockReturnValue(false);
    vi.mocked(getPausedPrReasonForTask).mockReturnValue(null);
    vi.mocked(getMergedPRForTask).mockReturnValue(null);
    vi.mocked(getTaskPauseReason).mockReturnValue(null);
    (
      runtimeSettings as { auto_launch_concurrency: number }
    ).auto_launch_concurrency = 2;
  });

  it('project[0] rejection does not block project[1] and project[2] in the same cycle', async () => {
    const proj1Backend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockRejectedValue(new Error('proj-1 failure')),
    };
    const proj2Backend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([]),
    };
    const proj3Backend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([]),
    };

    const resolveBackend = vi.fn().mockImplementation((id: string) => {
      if (id === 'proj-1') return proj1Backend;
      if (id === 'proj-2') return proj2Backend;
      return proj3Backend;
    });
    const sessionManager = makeSessionManager(0);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [
        makeProject({ id: 'proj-1' }),
        makeProject({ id: 'proj-2' }),
        makeProject({ id: 'proj-3' }),
      ],
      resolveBackend,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(proj1Backend.fetchReadyTasks).toHaveBeenCalledOnce();
    expect(proj2Backend.fetchReadyTasks).toHaveBeenCalledOnce();
    expect(proj3Backend.fetchReadyTasks).toHaveBeenCalledOnce();

    errorSpy.mockRestore();
  });

  it('pollOnce resolves normally even when all projects fail', async () => {
    const failBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockRejectedValue(new Error('always fails')),
    };
    const sessionManager = makeSessionManager(0);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [
        makeProject({ id: 'proj-1' }),
        makeProject({ id: 'proj-2' }),
      ],
      resolveBackend: () => failBackend,
      pollOnStart: false,
    });

    await expect(launcher.pollOnce()).resolves.toBeUndefined();

    errorSpy.mockRestore();
  });
});

// ── Parallel merged-PR catch-up tests ────────────────────────────────────────

describe('AutoLauncher — parallel merged-PR catch-up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasActiveSessionForTask).mockReturnValue(false);
    vi.mocked(getPausedPrReasonForTask).mockReturnValue(null);
    vi.mocked(getTaskPauseReason).mockReturnValue(null);
    (
      runtimeSettings as { auto_launch_concurrency: number }
    ).auto_launch_concurrency = 2;
  });

  it('10 merged-PR tasks run with at most UPDATE_CONCURRENCY=3 concurrent updateStatus calls', async () => {
    const tasks = Array.from({ length: 10 }, (_, i) =>
      makeResolvedTask({ id: `task-${i}`, title: `Task ${i}` }),
    );

    vi.mocked(getMergedPRForTask).mockImplementation((taskId) => {
      const idx = parseInt(taskId.split('-')[1]);
      return {
        id: idx + 1,
        pr_number: idx + 100,
        pr_url: `https://github.com/x/y/pull/${idx + 100}`,
        task_id: taskId,
        state: 'merged',
        repo: 'x/y',
      } as never;
    });

    let concurrent = 0;
    let maxConcurrent = 0;

    const updateStatus = vi.fn().mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      concurrent--;
    });

    const notionBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue(tasks),
      updateStatus,
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const launcher = new AutoLauncher(
      makeSessionManager(0) as never,
      undefined,
      {
        listProjects: () => [makeProject()],
        resolveBackend: () => notionBackend as never,
        pollOnStart: false,
      },
    );

    await launcher.pollOnce();

    expect(updateStatus).toHaveBeenCalledTimes(10);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(maxConcurrent).toBeGreaterThan(0);

    warnSpy.mockRestore();
  });
});

// ── AC: AutoLauncher poll-cycle timing — fire-and-forget regression guard ─────
// Verifies that a poll cycle launching 3 sessions completes in <1s because
// start() is fire-and-forget (it returns after DB insert, not after git/spawn).

describe('AutoLauncher.pollOnce() — fire-and-forget timing regression guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasActiveSessionForTask).mockReturnValue(false);
    vi.mocked(getPausedPrReasonForTask).mockReturnValue(null);
    vi.mocked(getMergedPRForTask).mockReturnValue(null);
    vi.mocked(getTaskPauseReason).mockReturnValue(null);
    (
      runtimeSettings as { auto_launch_concurrency: number }
    ).auto_launch_concurrency = 5;
  });

  it('poll cycle completes in <1s when launching 3 tasks (start() does not block poll on git)', async () => {
    const tasks = [
      makeResolvedTask({ id: 'task-1', title: 'Task One' }),
      makeResolvedTask({ id: 'task-2', title: 'Task Two' }),
      makeResolvedTask({ id: 'task-3', title: 'Task Three' }),
    ];
    const notionBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue(tasks),
    };
    const resolveBackend = vi.fn().mockReturnValue(notionBackend);
    // start() mock returns immediately (simulates fire-and-forget: caller unblocked)
    const sessionManager = makeSessionManager(0);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend,
      pollOnStart: false,
    });

    const t0 = Date.now();
    await launcher.pollOnce();
    const elapsed = Date.now() - t0;

    // All 3 tasks must be dispatched via start()
    expect(sessionManager.start).toHaveBeenCalledTimes(3);
    // Poll cycle must complete well under 1 second — start() is fire-and-forget
    // so the poll loop does not wait for git/bootstrap/spawn to complete.
    expect(elapsed).toBeLessThan(1_000);
  });
});

// ── Ready-transition pause-clear tests ───────────────────────────────────────
//
// AC: when a task's Notion status transitions from non-Ready → Ready, any stale
// DB task pause and PR-level pause must be cleared so isLaunchCandidate passes.
// Steady-state Ready tasks (no status change) must NOT have their pauses wiped
// — this is the loop-safety guard for launch_failed escalation.

describe('AutoLauncher — ready-transition pause clearing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasActiveSessionForTask).mockReturnValue(false);
    vi.mocked(getPausedPrReasonForTask).mockReturnValue(null);
    vi.mocked(getMergedPRForTask).mockReturnValue(null);
    vi.mocked(getTaskPauseReason).mockReturnValue(null);
    (
      runtimeSettings as { auto_launch_concurrency: number }
    ).auto_launch_concurrency = 2;
  });

  it('clears task-pause and PR-pause on transition to Ready, then launches the task', async () => {
    const task = makeResolvedTask({ id: 'task-transition' });

    // Simulate stale pause from a previous needs_attention state
    vi.mocked(getTaskPauseReason).mockReturnValue(
      'needs_attention' as unknown as ReturnType<typeof getTaskPauseReason>,
    );
    vi.mocked(getPausedPrReasonForTask).mockReturnValue(
      'stuck_timeout' as unknown as ReturnType<typeof getPausedPrReasonForTask>,
    );

    // After clearing, unblock isLaunchCandidate
    vi.mocked(clearTaskPauseReason).mockImplementation(() => {
      vi.mocked(getTaskPauseReason).mockReturnValue(null);
    });
    vi.mocked(clearPausedPrReasonForTask).mockImplementation(() => {
      vi.mocked(getPausedPrReasonForTask).mockReturnValue(null);
    });

    const notionBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([task]),
    };
    const sessionManager = makeSessionManager(0);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => notionBackend as never,
      pollOnStart: false,
    });

    // Simulate post-first-poll state: lastPollReadyTaskIds is a non-null Set
    // that does NOT contain task-transition (the task just transitioned to Ready)
    (
      launcher as unknown as { lastPollReadyTaskIds: Set<string> }
    ).lastPollReadyTaskIds = new Set(['some-other-task']);

    await launcher.pollOnce();

    expect(clearTaskPauseReason).toHaveBeenCalledWith('task-transition');
    expect(clearPausedPrReasonForTask).toHaveBeenCalledWith('task-transition');
    expect(resetTaskCrashCount).toHaveBeenCalledWith('task-transition');
    expect(sessionManager.start).toHaveBeenCalledOnce();
  });

  it('does not clear task-pause for steady-state Ready task (no-transition loop-safety)', async () => {
    const task = makeResolvedTask({ id: 'task-steady' });

    const notionBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([task]),
    };
    const sessionManager = makeSessionManager(0);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => notionBackend as never,
      pollOnStart: false,
    });

    // Simulate post-first-poll state with task-steady already in the set
    (
      launcher as unknown as { lastPollReadyTaskIds: Set<string> }
    ).lastPollReadyTaskIds = new Set(['task-steady']);

    // Now simulate launch_failed escalation set while task is steady-state Ready
    vi.mocked(getTaskPauseReason).mockReturnValue(
      'needs_attention' as unknown as ReturnType<typeof getTaskPauseReason>,
    );

    // Poll: task already in lastPollReadyTaskIds → no transition → pause must NOT be cleared
    await launcher.pollOnce();

    expect(clearTaskPauseReason).not.toHaveBeenCalled();
    expect(clearPausedPrReasonForTask).not.toHaveBeenCalled();
    expect(sessionManager.start).not.toHaveBeenCalled();
  });

  it('clears PR-level pause on transition to Ready even when no task-pause exists', async () => {
    const task = makeResolvedTask({ id: 'task-pr-pause' });

    vi.mocked(getTaskPauseReason).mockReturnValue(null);
    vi.mocked(getPausedPrReasonForTask).mockReturnValue(
      'stuck_timeout' as unknown as ReturnType<typeof getPausedPrReasonForTask>,
    );
    vi.mocked(clearPausedPrReasonForTask).mockImplementation(() => {
      vi.mocked(getPausedPrReasonForTask).mockReturnValue(null);
    });

    const notionBackend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([task]),
    };
    const sessionManager = makeSessionManager(0);

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => notionBackend as never,
      pollOnStart: false,
    });

    // Simulate post-first-poll state without task-pr-pause (it just transitioned to Ready)
    (
      launcher as unknown as { lastPollReadyTaskIds: Set<string> }
    ).lastPollReadyTaskIds = new Set(['some-other-task']);

    await launcher.pollOnce();

    expect(clearPausedPrReasonForTask).toHaveBeenCalledWith('task-pr-pause');
    expect(sessionManager.start).toHaveBeenCalledOnce();
  });
});

describe('AutoLauncher — usage admission gate', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(hasActiveSessionForTask).mockReturnValue(false);
    vi.mocked(getPausedPrReasonForTask).mockReturnValue(null);
    vi.mocked(getMergedPRForTask).mockReturnValue(null);
    vi.mocked(getTaskPauseReason).mockReturnValue(null);
    (
      runtimeSettings as { auto_launch_concurrency: number }
    ).auto_launch_concurrency = 2;
    const { registerUsagePoller } = await import('../usageAdmission.js');
    const { clearUsageDeferral } = await import('../../db/queries.js');
    registerUsagePoller({ getCache: () => ({ available: false }) });
    clearUsageDeferral('five_hour');
    clearUsageDeferral('seven_day');
  });

  it('does not spawn a launch while the five-hour window is exhausted', async () => {
    const { registerUsagePoller } = await import('../usageAdmission.js');
    const resetsAt = new Date(Date.now() + 60_000).toISOString();
    registerUsagePoller({
      getCache: () => ({
        available: true,
        fiveHour: { percent: 100, resetsAt, severity: 'exceeded' },
      }),
    });

    const task = makeResolvedTask({ id: 'task-usage-gated' });
    const backend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([task]),
    };
    const sessionManager = makeSessionManager(0);
    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend as never,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(sessionManager.start).not.toHaveBeenCalled();
  });

  it('launches normally once usage is available again (existing admission unaffected)', async () => {
    const { registerUsagePoller } = await import('../usageAdmission.js');
    registerUsagePoller({
      getCache: () => ({
        available: true,
        fiveHour: {
          percent: 10,
          resetsAt: '2099-01-01T00:00:00Z',
          severity: 'normal',
        },
      }),
    });

    const task = makeResolvedTask({ id: 'task-usage-ok' });
    const backend = {
      type: 'notion' as const,
      fetchReadyTasks: vi.fn().mockResolvedValue([task]),
    };
    const sessionManager = makeSessionManager(0);
    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [makeProject()],
      resolveBackend: () => backend as never,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(sessionManager.start).toHaveBeenCalledOnce();
  });
});
