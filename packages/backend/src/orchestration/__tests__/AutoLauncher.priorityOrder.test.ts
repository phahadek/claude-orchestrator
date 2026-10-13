import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedTask } from '../../notion/types';
import type { ProjectConfig } from '../../config';
import { mockDbQueries } from '../../__tests__/helpers/mockDbQueries';

vi.mock('../../config.js', () => ({
  getAllProjects: vi.fn(),
  runtimeSettings: {
    auto_launch_concurrency: 1,
    auto_launch_poll_interval_ms: 60_000,
    min_host_free_memory_mb: 4096,
    per_session_reserve_mb: 3072,
  },
}));

vi.mock('../memoryAdmission.js', () => ({
  hasMemoryHeadroom: vi.fn().mockReturnValue({
    allowed: true,
    freeMemMB: 8192,
    minHostFreeMemoryMB: 4096,
    perSessionReserveMB: 3072,
    projectedFreeMB: 5120,
  }),
}));

vi.mock('../../tasks/TaskBackend.js', () => ({ getTaskBackend: vi.fn() }));

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
    isNoOpSuppressed: vi.fn().mockReturnValue(false),
    listTaskExecutionFlagsForProject: vi.fn().mockReturnValue([]),
  }),
);

vi.mock('../../audit/AuditLog.js', () => ({ recordEvent: vi.fn() }));
vi.mock('../../projects/ProjectService.js', () => ({
  getProjectRepos: vi.fn().mockReturnValue([]),
}));
vi.mock('../../session/branchModel.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../session/branchSlug.js')
  >('../../session/branchSlug.js');
  return {
    probeBranchLocally: vi.fn().mockReturnValue('absent'),
    findWorktreePathForBranch: vi.fn().mockReturnValue(null),
    deriveBranchSlug: actual.deriveBranchSlug,
  };
});

import { runtimeSettings } from '../../config.js';
import {
  getTaskPauseReason,
  listTaskExecutionFlagsForProject,
} from '../../db/queries.js';
import { AutoLauncher } from '../AutoLauncher.js';

type TaskOverrides = Partial<ResolvedTask['task']>;

function task(id: string, overrides: TaskOverrides = {}): ResolvedTask {
  return {
    task: {
      id,
      title: `Title ${id}`,
      status: '🗂️ Ready',
      type: '💻 Code',
      dependsOn: [],
      notionUrl: `https://www.notion.so/${id}`,
      ...overrides,
    },
    blocked: false,
  };
}

function project(id: string, overrides: Partial<ProjectConfig> = {}) {
  return {
    id,
    name: id,
    projectDir: `/fake/${id}`,
    contextUrl: '',
    boardId: 'board',
    taskSource: 'notion',
    gitMode: 'github',
    autoLaunchEnabled: true,
    autoLaunchMilestoneId: 'm',
    autoMergeEnabled: false,
    boards: [{ id: 'm', sourceId: 'db', name: 'M' }],
    ...overrides,
  } as ProjectConfig;
}

function setup(
  projects: ProjectConfig[],
  tasksByProject: Record<
    string,
    { milestone?: ResolvedTask[]; nonMilestone?: ResolvedTask[] }
  >,
  cap: number,
  startImpl?: (title: string) => boolean,
) {
  (
    runtimeSettings as { auto_launch_concurrency: number }
  ).auto_launch_concurrency = cap;
  let live = 0;
  const started: string[] = [];
  const sessionManager = {
    getLiveCodeSessionCount: vi.fn(() => live),
    hasLiveSessionForTask: vi.fn().mockReturnValue(false),
    findLiveSessionIdForTask: vi.fn().mockReturnValue(undefined),
    start: vi.fn((_url: string, _ctx: string, _opts: { taskId?: string }) => {
      live++;
      started.push(String(_opts?.taskId ?? ''));
      return 'sid';
    }),
  };
  const launcher = new AutoLauncher(sessionManager as never, undefined, {
    listProjects: () => projects,
    resolveBackend: (pid: string) =>
      ({
        type: 'notion',
        fetchReadyTasks: vi
          .fn()
          .mockResolvedValue(tasksByProject[pid]?.milestone ?? []),
        fetchNonMilestoneReadyTasks: vi
          .fn()
          .mockResolvedValue(tasksByProject[pid]?.nonMilestone ?? []),
      }) as never,
    pollOnStart: false,
  });
  void startImpl;
  return {
    launcher,
    sessionManager,
    started,
    resetLive: () => {
      live = 0;
      started.length = 0;
    },
  };
}

function launchedIds(sm: { start: ReturnType<typeof vi.fn> }): string[] {
  return sm.start.mock.calls.map((c) => (c[2] as { taskId: string }).taskId);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTaskPauseReason).mockReturnValue(null);
  vi.mocked(listTaskExecutionFlagsForProject).mockReturnValue([]);
});

describe('AutoLauncher — execution-rank dispatch order', () => {
  it('launches the Urgent task when capacity is 1', async () => {
    vi.mocked(listTaskExecutionFlagsForProject).mockReturnValue([
      {
        task_id: 'notion:urgent',
        urgent: 1,
        execute_now_reason: null,
        execute_now_set_at: null,
      },
    ] as never);
    const { launcher, sessionManager } = setup(
      [project('p1')],
      {
        p1: {
          milestone: [
            task('low', { priority: 'Low' } as TaskOverrides),
            task('high', { priority: 'High' } as TaskOverrides),
            task('urgent'),
          ],
        },
      },
      1,
    );
    await launcher.pollOnce();
    expect(launchedIds(sessionManager)).toEqual(['urgent']);
  });

  it('launches the blocker over a higher-priority non-blocker', async () => {
    const { launcher, sessionManager } = setup(
      [project('p1')],
      {
        p1: {
          milestone: [
            task('high', { priority: 'High' } as TaskOverrides),
            task('blocker', { priority: 'Low' } as TaskOverrides),
            task('d1', { dependsOn: ['blocker'], status: '📝 Draft' }),
            task('d2', { dependsOn: ['blocker'], status: '📝 Draft' }),
          ],
        },
      },
      1,
    );
    await launcher.pollOnce();
    expect(launchedIds(sessionManager)).toEqual(['blocker']);
  });

  it('alternates across projects and resumes after the last-served project', async () => {
    const projects = [project('a'), project('b')];
    const mk = (p: string) => [1, 2, 3].map((n) => task(`${p}${n}`));
    const { launcher, sessionManager, resetLive } = setup(
      projects,
      { a: { milestone: mk('a') }, b: { milestone: mk('b') } },
      4,
    );
    await launcher.pollOnce();
    expect(launchedIds(sessionManager)).toEqual(['a1', 'b1', 'a2', 'b2']);

    // Last served was b; with fresh capacity the next turn goes to a.
    resetLive();
    sessionManager.start.mockClear();
    await launcher.pollOnce();
    expect(launchedIds(sessionManager)[0]).toBe('a1');
  });

  it('skips a project with no eligible candidates without moving the cursor', async () => {
    vi.mocked(getTaskPauseReason).mockImplementation((id: string) =>
      id.startsWith('a') ? ('crash_budget' as never) : null,
    );
    const { launcher, sessionManager } = setup(
      [project('a'), project('b')],
      {
        a: { milestone: [task('a1')] },
        b: { milestone: [task('b1'), task('b2')] },
      },
      2,
    );
    await launcher.pollOnce();
    expect(launchedIds(sessionManager)).toEqual(['b1', 'b2']);
  });

  it('a launch that returns false uses no slot and the next candidate is tried', async () => {
    const { launcher, sessionManager } = setup(
      [project('a')],
      { a: { milestone: [task('a1'), task('a2')] } },
      1,
    );
    sessionManager.findLiveSessionIdForTask.mockImplementation((id: string) =>
      id.includes('a1') ? 'live' : undefined,
    );
    await launcher.pollOnce();
    expect(launchedIds(sessionManager)).toEqual(['a2']);
  });

  it('ranks non-milestone tasks per board and merges with milestone candidates', async () => {
    vi.mocked(listTaskExecutionFlagsForProject).mockReturnValue([
      {
        task_id: 'notion:nm-urgent',
        urgent: 1,
        execute_now_reason: null,
        execute_now_set_at: null,
      },
    ] as never);
    const { launcher, sessionManager } = setup(
      [project('a', { nonMilestoneSourceConfig: {} as never })],
      {
        a: {
          milestone: [task('m-high', { priority: 'High' } as TaskOverrides)],
          nonMilestone: [task('nm-urgent')],
        },
      },
      1,
    );
    await launcher.pollOnce();
    expect(launchedIds(sessionManager)).toEqual(['nm-urgent']);
  });
});
