import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpsSessionLauncher } from '../OpsSessionLauncher.js';
import type { OpsLoadResult, OpsTaskEntry } from '../../ops/opsLoad.js';

vi.mock('../../ops/opsSessionContext.js', () => ({
  buildOpsSessionContext: vi.fn().mockReturnValue('## Ops Context\n'),
}));

vi.mock('../../ops/opsLoad.js', () => ({
  loadOpsContext: vi.fn(),
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
