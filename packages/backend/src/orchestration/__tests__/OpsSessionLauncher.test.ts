import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpsSessionLauncher } from '../OpsSessionLauncher.js';
import type { OpsLoadResult, OpsTaskEntry } from '../../ops/opsLoad.js';

vi.mock('../../ops/opsSessionContext.js', () => ({
  buildOpsSessionContext: vi.fn().mockReturnValue('## Ops Context\n'),
}));

vi.mock('../../ops/opsLoad.js', () => ({
  loadOpsContext: vi.fn(),
}));

vi.mock('../../ops/opsJournal.js', () => ({
  getEntry: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../../groom/groomLoad.js', () => ({
  loadGroomContext: vi.fn(),
}));

vi.mock('../../design/designLoad.js', () => ({
  loadDesignContext: vi.fn(),
}));

vi.mock('../../db/queries.js', () => ({
  getProjectRowById: vi
    .fn()
    .mockReturnValue({ id: 'proj-1', project_dir: '/tmp/proj-1' }),
}));

vi.mock('../../projects/milestoneResolver.js', () => ({
  resolveMilestoneForProject: vi.fn().mockReturnValue('M1'),
}));

function makeTask(overrides: Partial<OpsTaskEntry> = {}): OpsTaskEntry {
  return {
    id: 'task-1',
    title: 'Investigate flakiness',
    status: '🗂️ Ready',
    url: 'https://www.notion.so/task-1',
    type: '🔎 Investigation',
    mode: 'investigation',
    dependsOn: [],
    blockingDepIds: [],
    depStatus: 'ready',
    ...overrides,
  };
}

function makeOpsContext(executable: OpsTaskEntry[] = []): OpsLoadResult {
  return {
    contextPages: [],
    boards: {
      target: {
        milestone: 'milestone-1',
        board: 'board-1',
        counts: {
          executable: executable.length,
          dep_blocked: 0,
          needs_grooming: 0,
          closed_not_done: 0,
          done_or_deferred: 0,
          leftover_tooling: 0,
          test_authoring_excluded: 0,
        },
      },
      neighbours: [],
    },
    worklist: {
      executable,
      dep_blocked: [],
      needs_grooming: [],
      closed_not_done: [],
      leftover_tooling: [],
      test_authoring: [],
      newly_unblocked: [],
    },
  };
}

describe('OpsSessionLauncher', () => {
  let start: ReturnType<typeof vi.fn>;
  let sessionManager: { start: typeof start };

  beforeEach(() => {
    start = vi.fn().mockResolvedValue('session-id');
    sessionManager = { start };
  });

  it('launches N individual sessions for N selected ready tasks (not one combined session)', async () => {
    const launcher = new OpsSessionLauncher(sessionManager as never);
    const tasks = [
      makeTask({ id: 'task-1' }),
      makeTask({ id: 'task-2' }),
      makeTask({ id: 'task-3' }),
    ];

    const result = await launcher.launchSelected({
      projectId: 'proj-1',
      projectContextUrl: 'https://www.notion.so/context',
      milestoneId: 'milestone-1',
      opsContext: makeOpsContext(tasks),
      tasks,
    });

    expect(start).toHaveBeenCalledTimes(3);
    expect(result.launched).toEqual(['task-1', 'task-2', 'task-3']);
    expect(result.deferred).toEqual([]);
    // Each call is its own session.start() invocation, scoped to one task.
    for (const [, , options] of start.mock.calls) {
      expect(options.taskId).toBeDefined();
    }
  });

  it('defers a task whose Depends On is not all ✅ Done, and launches it once unblocked', async () => {
    const { loadOpsContext } = await import('../../ops/opsLoad.js');
    const blockedTask = makeTask({
      id: 'task-blocked',
      dependsOn: ['task-dep'],
      blockingDepIds: ['task-dep'],
      depStatus: 'blocked',
    });
    const readyTask = makeTask({ id: 'task-ready' });

    const launcher = new OpsSessionLauncher(sessionManager as never, {
      loadOpsContext: loadOpsContext as never,
    });

    const result = await launcher.launchSelected({
      projectId: 'proj-1',
      projectContextUrl: 'https://www.notion.so/context',
      milestoneId: 'milestone-1',
      opsContext: makeOpsContext([readyTask]),
      tasks: [blockedTask, readyTask],
    });

    // Only the ready task launches now; the blocked one is deferred, not launched.
    expect(start).toHaveBeenCalledTimes(1);
    expect(result.launched).toEqual(['task-ready']);
    expect(result.deferred).toEqual(['task-blocked']);
    expect(launcher.hasDeferred('task-blocked')).toBe(true);

    // The dependency completes — the next poll picks it up as executable+ready.
    const unblockedTask = {
      ...blockedTask,
      blockingDepIds: [],
      depStatus: 'ready' as const,
    };
    (loadOpsContext as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeOpsContext([unblockedTask]),
    );

    await launcher.pollOnce();

    expect(start).toHaveBeenCalledTimes(2);
    expect(launcher.hasDeferred('task-blocked')).toBe(false);
  });

  it('does not launch a still-blocked task on poll', async () => {
    const { loadOpsContext } = await import('../../ops/opsLoad.js');
    const blockedTask = makeTask({
      id: 'task-blocked',
      dependsOn: ['task-dep'],
      blockingDepIds: ['task-dep'],
      depStatus: 'blocked',
    });

    const launcher = new OpsSessionLauncher(sessionManager as never, {
      loadOpsContext: loadOpsContext as never,
    });

    await launcher.launchSelected({
      projectId: 'proj-1',
      projectContextUrl: 'https://www.notion.so/context',
      milestoneId: 'milestone-1',
      opsContext: makeOpsContext([]),
      tasks: [blockedTask],
    });
    expect(start).not.toHaveBeenCalled();

    (loadOpsContext as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeOpsContext([]),
    );
    await launcher.pollOnce();

    expect(start).not.toHaveBeenCalled();
    expect(launcher.hasDeferred('task-blocked')).toBe(true);
  });
});

describe('OpsSessionLauncher — injected planning procedure', () => {
  let start: ReturnType<typeof vi.fn>;
  let sessionManager: { start: typeof start };

  beforeEach(() => {
    start = vi.fn().mockResolvedValue('session-id');
    sessionManager = { start };
    vi.clearAllMocks();
  });

  it('passes a non-empty injectedProcedureContent (from assemblePlanningProcedure) for an ops dispatch', async () => {
    const launcher = new OpsSessionLauncher(sessionManager as never);
    const task = makeTask({ id: 'task-1' });

    await launcher.launchSelected({
      projectId: 'proj-1',
      projectContextUrl: 'https://www.notion.so/context',
      milestoneId: 'milestone-1',
      sessionType: 'ops',
      opsContext: makeOpsContext([task]),
      tasks: [task],
    });

    expect(start).toHaveBeenCalledTimes(1);
    const [, , options] = start.mock.calls[0];
    expect(options.sessionType).toBe('ops');
    expect(typeof options.injectedProcedureContent).toBe('string');
    expect((options.injectedProcedureContent as string).length).toBeGreaterThan(0);
  });

  it('passes a non-empty injectedProcedureContent for a groom dispatch', async () => {
    const { loadGroomContext } = await import('../../groom/groomLoad.js');
    (loadGroomContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      targetTasks: [
        {
          id: 'task-1',
          title: 'Groom me',
          status: '🔲 Backlog',
          type: '🔨 Task',
          url: 'https://www.notion.so/task-1',
          sizeCheckSeed: { files: 1, loc_method: 'estimated' },
          typeCheck: { mismatch: false, notes: [] },
          readinessViolations: [],
          bindingConstraints: [],
        },
      ],
      dependencyCandidates: [],
    });

    const launcher = new OpsSessionLauncher(sessionManager as never);
    const task = { id: 'task-1', title: 'Groom me', url: '', blockingDepIds: [] };

    await launcher.launchSelected({
      projectId: 'proj-1',
      projectContextUrl: 'https://www.notion.so/context',
      milestoneId: 'milestone-1',
      sessionType: 'groom',
      tasks: [task],
    });

    expect(start).toHaveBeenCalledTimes(1);
    const [, , options] = start.mock.calls[0];
    expect(options.sessionType).toBe('groom');
    expect(typeof options.injectedProcedureContent).toBe('string');
    expect((options.injectedProcedureContent as string).length).toBeGreaterThan(0);
  });

  it('passes a non-empty injectedProcedureContent for a design dispatch', async () => {
    const { loadDesignContext } = await import('../../design/designLoad.js');
    (loadDesignContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      task: {
        id: 'task-1',
        title: 'Design me',
        status: '🔲 Backlog',
        type: '🎨 Design',
        url: 'https://www.notion.so/task-1',
      },
      markdown: '## Task\nSome design body.',
      openQuestions: { items: [], source: 'none' },
      archUnits: [],
      unresolvedPageRefs: [],
      codeMapGrounding: {},
    });

    const launcher = new OpsSessionLauncher(sessionManager as never);
    const task = { id: 'task-1', title: 'Design me', url: '', blockingDepIds: [] };

    await launcher.launchSelected({
      projectId: 'proj-1',
      projectContextUrl: 'https://www.notion.so/context',
      milestoneId: 'milestone-1',
      sessionType: 'design',
      tasks: [task],
    });

    expect(start).toHaveBeenCalledTimes(1);
    const [, , options] = start.mock.calls[0];
    expect(options.sessionType).toBe('design');
    expect(typeof options.injectedProcedureContent).toBe('string');
    expect((options.injectedProcedureContent as string).length).toBeGreaterThan(0);
  });

  it('does not pass injectedProcedureContent for a standard (code) dispatch', async () => {
    const launcher = new OpsSessionLauncher(sessionManager as never);
    const task = { id: 'task-1', title: 'Code me', url: '', blockingDepIds: [] };

    await launcher.launchSelected({
      projectId: 'proj-1',
      projectContextUrl: 'https://www.notion.so/context',
      milestoneId: 'milestone-1',
      sessionType: 'standard',
      tasks: [task],
    });

    expect(start).toHaveBeenCalledTimes(1);
    const [, , options] = start.mock.calls[0];
    expect(options.injectedProcedureContent).toBeUndefined();
  });
});
