import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OpsSessionLauncher,
  setOpsSessionLauncherRefreshFn,
} from '../OpsSessionLauncher.js';
import type { OpsLoadResult, OpsTaskEntry } from '../../ops/opsLoad.js';

vi.mock('../../ops/opsSessionContext.js', () => ({
  buildOpsSessionContext: vi.fn().mockReturnValue('## Ops Context\n'),
}));

vi.mock('../../ops/opsLoad.js', () => ({
  loadOpsContext: vi.fn(),
}));

vi.mock('../../ops/opsJournal.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getEntry: vi.fn().mockReturnValue(undefined),
  };
});

vi.mock('../../groom/groomLoad.js', async () => {
  const actual = await vi.importActual('../../groom/groomLoad.js');
  return {
    ...actual,
    loadGroomContext: vi.fn(),
  };
});

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

function makeGroomTaskDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    title: 'Groom me',
    status: '🔲 Backlog',
    type: '🔨 Task',
    url: 'https://www.notion.so/task-1',
    sizeCheckSeed: { files: 1, loc_method: 'estimated' },
    typeCheck: { mismatch: false, notes: [] },
    readinessViolations: [],
    bindingConstraints: [],
    regions: { packages: [], files: [], planned: [] },
    rawMarkdown: '',
    ...overrides,
  };
}

function makeGroomResult(
  targetTasks: ReturnType<typeof makeGroomTaskDoc>[],
  overrides: Record<string, unknown> = {},
) {
  return {
    board: targetTasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      type: t.type,
      priority: '',
      url: t.url,
    })),
    targetTasks,
    codeWorklist: new Map<string, string[]>(),
    dependencyCandidates: [],
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
    setOpsSessionLauncherRefreshFn(null as never);
  });

  it('triggers an immediate task-cache refresh for the project after a successful launch', async () => {
    const refreshFn = vi.fn().mockResolvedValue(undefined);
    setOpsSessionLauncherRefreshFn(refreshFn);
    const launcher = new OpsSessionLauncher(sessionManager as never);
    const tasks = [makeTask({ id: 'task-1' })];

    await launcher.launchSelected({
      projectId: 'proj-1',
      projectContextUrl: 'https://www.notion.so/context',
      milestoneId: 'milestone-1',
      opsContext: makeOpsContext(tasks),
      tasks,
    });
    await Promise.resolve();

    expect(refreshFn).toHaveBeenCalledWith('proj-1', true);
  });

  it('does not throw if the cache refresh hook rejects', async () => {
    const refreshFn = vi.fn().mockRejectedValue(new Error('refresh failed'));
    setOpsSessionLauncherRefreshFn(refreshFn);
    const launcher = new OpsSessionLauncher(sessionManager as never);
    const tasks = [makeTask({ id: 'task-1' })];

    const result = await launcher.launchSelected({
      projectId: 'proj-1',
      projectContextUrl: 'https://www.notion.so/context',
      milestoneId: 'milestone-1',
      opsContext: makeOpsContext(tasks),
      tasks,
    });

    expect(result.launched).toEqual(['task-1']);
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

  it('records a notion:-prefixed sessions.task_id, matching every other launch path', async () => {
    const launcher = new OpsSessionLauncher(sessionManager as never);
    const tasks = [makeTask({ id: 'task-1' })];

    await launcher.launchSelected({
      projectId: 'proj-1',
      projectContextUrl: 'https://www.notion.so/context',
      milestoneId: 'milestone-1',
      opsContext: makeOpsContext(tasks),
      tasks,
    });

    const [, , options] = start.mock.calls[0];
    expect(options.taskId).toBe('notion:task-1');
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
    expect((options.injectedProcedureContent as string).length).toBeGreaterThan(
      0,
    );
  });

  it('names an ops session "Ops: <task title>"', async () => {
    const launcher = new OpsSessionLauncher(sessionManager as never);
    const task = makeTask({ id: 'task-1', title: 'Investigate flakiness' });

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
    expect(options.taskName).toBe('Ops: Investigate flakiness');
  });

  it('falls back to the raw task id (never a malformed notion.so/notion:<id> url) when no title can be resolved', async () => {
    const { loadGroomContext } = await import('../../groom/groomLoad.js');
    (loadGroomContext as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeGroomResult([]),
    );

    const launcher = new OpsSessionLauncher(sessionManager as never);
    // No groom digest match and no caller-supplied title: buildInjectedProcedure
    // throws GroomWorklistTaskNotFoundError, which fails this dispatch fast —
    // use a sessionType that skips the digest lookup entirely instead, so the
    // fallback chain (title || task.title || task.id) is exercised directly.
    const task = {
      id: 'notion:untitled-task',
      title: '',
      url: '',
      blockingDepIds: [],
    };

    await launcher.launchSelected({
      projectId: 'proj-1',
      projectContextUrl: 'https://www.notion.so/context',
      milestoneId: 'milestone-1',
      sessionType: 'standard',
      tasks: [task],
    });

    expect(start).toHaveBeenCalledTimes(1);
    const [, , options] = start.mock.calls[0];
    expect(options.taskName).toBe('notion:untitled-task');
    expect(options.taskName).not.toContain('notion.so/notion:');
  });

  it('passes a non-empty injectedProcedureContent for a groom dispatch', async () => {
    const { loadGroomContext } = await import('../../groom/groomLoad.js');
    (loadGroomContext as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeGroomResult([makeGroomTaskDoc()]),
    );

    const launcher = new OpsSessionLauncher(sessionManager as never);
    const task = {
      id: 'task-1',
      title: 'Groom me',
      url: '',
      blockingDepIds: [],
    };

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
    expect((options.injectedProcedureContent as string).length).toBeGreaterThan(
      0,
    );
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
      archSource: 'notion',
      archUnits: [],
      unresolvedPageRefs: [],
      codeMapGrounding: {},
    });

    const launcher = new OpsSessionLauncher(sessionManager as never);
    const task = {
      id: 'task-1',
      title: 'Design me',
      url: '',
      blockingDepIds: [],
    };

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
    expect((options.injectedProcedureContent as string).length).toBeGreaterThan(
      0,
    );

    // Regression: the manifest config-dir key must come from the project's
    // repo checkout (project_dir), not the registry id (proj-1) — passing
    // the registry id as the key looks for config/projects/<registry-id>/
    // grooming.json, which doesn't exist when the config-dir basename
    // differs (e.g. registry id "claude-dashboard" vs. dir "claude-orchestrator").
    expect(loadDesignContext).toHaveBeenCalledWith(
      'milestone-1',
      'task-1',
      expect.objectContaining({ repoRoot: '/tmp/proj-1', project: 'proj-1' }),
    );
  });

  it('names a groom session after the digest-resolved title, not the bare task id', async () => {
    const { loadGroomContext } = await import('../../groom/groomLoad.js');
    (loadGroomContext as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeGroomResult([
        makeGroomTaskDoc({ title: 'Fix the flaky retry logic' }),
      ]),
    );

    const launcher = new OpsSessionLauncher(sessionManager as never);
    // Mirrors planningLaunch.ts's groom/design dispatch, which only knows
    // the bare task id at dispatch time — title is resolved from the
    // groom digest, not passed in.
    const task = { id: 'task-1', title: 'task-1', url: '', blockingDepIds: [] };

    await launcher.launchSelected({
      projectId: 'proj-1',
      projectContextUrl: 'https://www.notion.so/context',
      milestoneId: 'milestone-1',
      sessionType: 'groom',
      tasks: [task],
    });

    expect(start).toHaveBeenCalledTimes(1);
    const [, , options] = start.mock.calls[0];
    expect(options.taskName).toBe('Grooming: Fix the flaky retry logic');
  });

  it('names a design session after the digest-resolved title, not the bare task id', async () => {
    const { loadDesignContext } = await import('../../design/designLoad.js');
    (loadDesignContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      task: {
        id: 'task-1',
        title: 'Design the retry backoff strategy',
        status: '🔲 Backlog',
        type: '🎨 Design',
        url: 'https://www.notion.so/task-1',
      },
      markdown: '## Task\nSome design body.',
      openQuestions: { items: [], source: 'none' },
      archSource: 'notion',
      archUnits: [],
      unresolvedPageRefs: [],
      codeMapGrounding: {},
    });

    const launcher = new OpsSessionLauncher(sessionManager as never);
    const task = { id: 'task-1', title: 'task-1', url: '', blockingDepIds: [] };

    await launcher.launchSelected({
      projectId: 'proj-1',
      projectContextUrl: 'https://www.notion.so/context',
      milestoneId: 'milestone-1',
      sessionType: 'design',
      tasks: [task],
    });

    expect(start).toHaveBeenCalledTimes(1);
    const [, , options] = start.mock.calls[0];
    expect(options.taskName).toBe('Design: Design the retry backoff strategy');
  });

  it('reconciles a stale groom worklist: refreshes with skipCache and assembles once the freshly-created task is found', async () => {
    const { loadGroomContext } = await import('../../groom/groomLoad.js');
    (loadGroomContext as ReturnType<typeof vi.fn>)
      // First read (cached): the just-created task isn't in the board yet.
      .mockResolvedValueOnce(makeGroomResult([]))
      // Reconciliation retry with skipCache: the fresh read finds it.
      .mockResolvedValueOnce(
        makeGroomResult([
          makeGroomTaskDoc({ title: 'Newly created backlog task' }),
        ]),
      );

    const launcher = new OpsSessionLauncher(sessionManager as never);
    const task = { id: 'task-1', title: 'task-1', url: '', blockingDepIds: [] };

    await launcher.launchSelected({
      projectId: 'proj-1',
      projectContextUrl: 'https://www.notion.so/context',
      milestoneId: 'milestone-1',
      sessionType: 'groom',
      tasks: [task],
    });

    expect(loadGroomContext).toHaveBeenCalledTimes(2);
    expect(
      (loadGroomContext as ReturnType<typeof vi.fn>).mock.calls[1][1],
    ).toMatchObject({ skipCache: true });
    expect(start).toHaveBeenCalledTimes(1);
    const [, , options] = start.mock.calls[0];
    expect(options.taskName).toBe('Grooming: Newly created backlog task');
    expect(typeof options.injectedProcedureContent).toBe('string');
  });

  it('skips the dispatch (does not launch a session) with a clear reason when the task is genuinely absent from the groom worklist', async () => {
    const { loadGroomContext } = await import('../../groom/groomLoad.js');
    (loadGroomContext as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeGroomResult([]),
    );

    const launcher = new OpsSessionLauncher(sessionManager as never);
    const task = { id: 'task-1', title: 'task-1', url: '', blockingDepIds: [] };

    const result = await launcher.launchSelected({
      projectId: 'proj-1',
      projectContextUrl: 'https://www.notion.so/context',
      milestoneId: 'milestone-1',
      sessionType: 'groom',
      tasks: [task],
    });

    // Reconciliation is attempted (2 loads) but the task is still absent —
    // dispatch is skipped rather than launching a session that then errors
    // on the generic no-injectedProcedureContent fail-loud.
    expect(loadGroomContext).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
    expect(result.launched).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ taskId: 'task-1' });
    expect(result.failed[0].reason).toBeTruthy();
  });

  it('aborts before creating a session when planning-procedure assembly fails with a generic (non-worklist) error, and propagates that error as the failure reason', async () => {
    const { loadDesignContext } = await import('../../design/designLoad.js');
    (loadDesignContext as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('milestone milestone-1 is not registered'),
    );

    const launcher = new OpsSessionLauncher(sessionManager as never);
    const task = {
      id: 'task-1',
      title: 'Design me',
      url: '',
      blockingDepIds: [],
    };

    const result = await launcher.launchSelected({
      projectId: 'proj-1',
      projectContextUrl: 'https://www.notion.so/context',
      milestoneId: 'milestone-1',
      sessionType: 'design',
      tasks: [task],
    });

    // The assembly failure aborts the dispatch before any session.start()
    // call — no session is created and torn down over a config fault.
    expect(start).not.toHaveBeenCalled();
    expect(result.launched).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].taskId).toBe('task-1');
    // The real cause (the assembly error) reaches the failure surface,
    // instead of the generic no-injectedProcedureContent refusal that would
    // otherwise fire one hop later and misattribute the failure.
    expect(result.failed[0].reason).toContain(
      'milestone milestone-1 is not registered',
    );
  });

  it('refuses a groom dispatch (no session launched) when the loader reports a non-Notion task source, with a reason distinct from a worklist-miss failure', async () => {
    const { loadGroomContext, GroomTaskSourceUnsupportedError } =
      await import('../../groom/groomLoad.js');
    (loadGroomContext as ReturnType<typeof vi.fn>).mockRejectedValue(
      new GroomTaskSourceUnsupportedError('proj-1', 'yaml'),
    );

    const launcher = new OpsSessionLauncher(sessionManager as never);
    const task = { id: 'task-1', title: 'task-1', url: '', blockingDepIds: [] };

    const result = await launcher.launchSelected({
      projectId: 'proj-1',
      projectContextUrl: 'https://www.notion.so/context',
      milestoneId: 'milestone-1',
      sessionType: 'groom',
      tasks: [task],
    });

    // Task-source unsupported is not a worklist-miss — no retry/reconciliation.
    expect(loadGroomContext).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(result.launched).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ taskId: 'task-1' });
    expect(result.failed[0].reason).toMatch(/task source "yaml"/);
    expect(result.failed[0].reason).not.toMatch(/groom worklist/);
  });

  it('puts a task in failed[] with the rejection message when sessionManager.start rejects, not in launched[]', async () => {
    start.mockRejectedValue(
      new Error('Max concurrent planning sessions (5) reached'),
    );
    const launcher = new OpsSessionLauncher(sessionManager as never);
    const task = makeTask({ id: 'task-1' });

    const result = await launcher.launchSelected({
      projectId: 'proj-1',
      projectContextUrl: 'https://www.notion.so/context',
      milestoneId: 'milestone-1',
      opsContext: makeOpsContext([task]),
      tasks: [task],
    });

    expect(result.launched).toEqual([]);
    expect(result.failed).toEqual([
      {
        taskId: 'task-1',
        reason: 'Max concurrent planning sessions (5) reached',
      },
    ]);
  });

  it('puts the task in launched[] and leaves failed[] empty when start resolves', async () => {
    const launcher = new OpsSessionLauncher(sessionManager as never);
    const task = makeTask({ id: 'task-1' });

    const result = await launcher.launchSelected({
      projectId: 'proj-1',
      projectContextUrl: 'https://www.notion.so/context',
      milestoneId: 'milestone-1',
      opsContext: makeOpsContext([task]),
      tasks: [task],
    });

    expect(result.launched).toEqual(['task-1']);
    expect(result.failed).toEqual([]);
  });

  it('partitions a mixed batch into launched, deferred, and failed, still dispatching the non-failing tasks', async () => {
    start.mockImplementation(
      (_url: string, _ctxUrl: string, opts: { taskId: string }) => {
        if (opts.taskId === 'notion:task-fail') {
          return Promise.reject(
            new Error('Max concurrent planning sessions (5) reached'),
          );
        }
        return Promise.resolve(`session-${opts.taskId}`);
      },
    );

    const launchTask = makeTask({ id: 'task-launch' });
    const deferTask = makeTask({
      id: 'task-defer',
      dependsOn: ['task-dep'],
      blockingDepIds: ['task-dep'],
      depStatus: 'blocked',
    });
    const failTask = makeTask({ id: 'task-fail' });

    const launcher = new OpsSessionLauncher(sessionManager as never);
    const result = await launcher.launchSelected({
      projectId: 'proj-1',
      projectContextUrl: 'https://www.notion.so/context',
      milestoneId: 'milestone-1',
      opsContext: makeOpsContext([launchTask, failTask]),
      tasks: [launchTask, deferTask, failTask],
    });

    expect(result.launched).toEqual(['task-launch']);
    expect(result.deferred).toEqual(['task-defer']);
    expect(result.failed).toEqual([
      {
        taskId: 'task-fail',
        reason: 'Max concurrent planning sessions (5) reached',
      },
    ]);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('does not pass injectedProcedureContent for a standard (code) dispatch', async () => {
    const launcher = new OpsSessionLauncher(sessionManager as never);
    const task = {
      id: 'task-1',
      title: 'Code me',
      url: '',
      blockingDepIds: [],
    };

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
