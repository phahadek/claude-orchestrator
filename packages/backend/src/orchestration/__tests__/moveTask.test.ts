import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDbQueries } from '../../__tests__/helpers/mockDbQueries';

const mockDeleteTaskCacheRow = vi.fn();
const mockRecordEvent = vi.fn();
const mockRehomeGateItems = vi.fn();
const mockRehomeSeedItems = vi.fn();
const mockResolveMilestoneForProject = vi.fn();

vi.mock('../../db/queries', () =>
  mockDbQueries({
    getTaskCache: vi.fn().mockReturnValue(undefined),
    deleteTaskCacheRow: (...args: unknown[]) => mockDeleteTaskCacheRow(...args),
  }),
);

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: (...args: unknown[]) => mockRecordEvent(...args),
}));

vi.mock('../../gate/gateStore', () => ({
  rehomeItemsBySourceTask: (...args: unknown[]) => mockRehomeGateItems(...args),
}));

vi.mock('../../seed/seedStore', () => ({
  rehomeItemsBySourceTask: (...args: unknown[]) => mockRehomeSeedItems(...args),
}));

vi.mock('../../projects/milestoneResolver', () => ({
  resolveMilestoneForProject: (...args: unknown[]) =>
    mockResolveMilestoneForProject(...args),
}));

import { planMove, MoveTaskError, type MoveGraphTask } from '../moveTask';
import {
  BackendTaskWriteCommands,
  setTaskWriteRefreshFn,
} from '../../tasks/TaskWriteCommands';
import type { TaskBackend } from '../../tasks/TaskBackend';
import { ReadinessGateError } from '../../tasks/readinessGate';

// ─── planMove: the four dependency cases ─────────────────────────────────────

describe('planMove', () => {
  it('later move: drops the moved task’s own deps and computes the transitive inbound-dependent cascade set', () => {
    const graph: MoveGraphTask[] = [
      { id: 'notion:a', dependsOn: ['notion:z'] },
      { id: 'notion:z', dependsOn: [] },
      { id: 'notion:dep1', dependsOn: ['notion:a'] },
      { id: 'notion:dep2', dependsOn: ['notion:dep1'] },
      { id: 'notion:unrelated', dependsOn: [] },
    ];

    const plan = planMove({
      taskId: 'notion:a',
      sourceMilestoneTasks: graph,
      isLaterMove: true,
    });

    expect(plan.newDependsOn).toEqual([]);
    expect(plan.droppedEdges).toEqual(
      expect.arrayContaining([
        { from: 'notion:a', to: 'notion:z' },
        { from: 'notion:dep1', to: 'notion:a' },
      ]),
    );
    // dep2 depends transitively (through dep1), but has no *direct* edge to
    // the moved task, so it must not appear in droppedEdges.
    expect(plan.droppedEdges).not.toContainEqual(
      expect.objectContaining({ from: 'notion:dep2' }),
    );
    expect(plan.cascadeSet.sort()).toEqual(['notion:dep1', 'notion:dep2']);
    expect(plan.dependentRewrites).toEqual([
      { taskId: 'notion:dep1', dependsOn: [] },
    ]);
  });

  it('earlier move: refuses when the moved task has outbound deps, naming them', () => {
    const graph: MoveGraphTask[] = [
      { id: 'notion:a', dependsOn: ['notion:b', 'notion:c'] },
      { id: 'notion:b', dependsOn: [] },
      { id: 'notion:c', dependsOn: [] },
    ];

    expect(() =>
      planMove({
        taskId: 'notion:a',
        sourceMilestoneTasks: graph,
        isLaterMove: false,
      }),
    ).toThrow(MoveTaskError);
    expect(() =>
      planMove({
        taskId: 'notion:a',
        sourceMilestoneTasks: graph,
        isLaterMove: false,
      }),
    ).toThrow(/notion:b, notion:c/);
  });

  it('earlier move: drops inbound edges when the moved task has no outbound deps', () => {
    const graph: MoveGraphTask[] = [
      { id: 'notion:a', dependsOn: [] },
      { id: 'notion:dep1', dependsOn: ['notion:a'] },
      { id: 'notion:dep2', dependsOn: ['notion:a', 'notion:other'] },
      { id: 'notion:other', dependsOn: [] },
    ];

    const plan = planMove({
      taskId: 'notion:a',
      sourceMilestoneTasks: graph,
      isLaterMove: false,
    });

    expect(plan.newDependsOn).toEqual([]);
    expect(plan.cascadeSet).toEqual([]);
    expect(
      plan.droppedEdges.sort((x, y) => x.from.localeCompare(y.from)),
    ).toEqual([
      { from: 'notion:dep1', to: 'notion:a' },
      { from: 'notion:dep2', to: 'notion:a' },
    ]);
    expect(
      plan.dependentRewrites.find((r) => r.taskId === 'notion:dep1'),
    ).toEqual({ taskId: 'notion:dep1', dependsOn: [] });
    expect(
      plan.dependentRewrites.find((r) => r.taskId === 'notion:dep2'),
    ).toEqual({ taskId: 'notion:dep2', dependsOn: ['notion:other'] });
  });

  it('refuses a malformed / unresolvable dependency tree (dangling reference)', () => {
    const graph: MoveGraphTask[] = [
      { id: 'notion:a', dependsOn: ['notion:ghost'] },
    ];

    expect(() =>
      planMove({
        taskId: 'notion:a',
        sourceMilestoneTasks: graph,
        isLaterMove: true,
      }),
    ).toThrow(MoveTaskError);
  });

  it('refuses a malformed / unresolvable dependency tree (cycle)', () => {
    const graph: MoveGraphTask[] = [
      { id: 'notion:a', dependsOn: ['notion:b'] },
      { id: 'notion:b', dependsOn: ['notion:a'] },
    ];

    expect(() =>
      planMove({
        taskId: 'notion:a',
        sourceMilestoneTasks: graph,
        isLaterMove: true,
      }),
    ).toThrow(MoveTaskError);
  });

  it('tolerates a dangling Depends On on an unrelated task in the source milestone', () => {
    const graph: MoveGraphTask[] = [
      { id: 'notion:a', dependsOn: [] },
      { id: 'notion:dep1', dependsOn: ['notion:a'] },
      // Unrelated to the move: a stale dangling dep on a task with no
      // relationship to the moved task or its cascade set.
      { id: 'notion:unrelated', dependsOn: ['notion:ghost'] },
    ];

    const plan = planMove({
      taskId: 'notion:a',
      sourceMilestoneTasks: graph,
      isLaterMove: true,
    });

    expect(plan.cascadeSet).toEqual(['notion:dep1']);
    expect(plan.droppedEdges).toEqual(
      expect.arrayContaining([{ from: 'notion:dep1', to: 'notion:a' }]),
    );
  });

  it('throws when the moved task is not in the source milestone task set', () => {
    expect(() =>
      planMove({
        taskId: 'notion:missing',
        sourceMilestoneTasks: [{ id: 'notion:a', dependsOn: [] }],
        isLaterMove: true,
      }),
    ).toThrow(MoveTaskError);
  });
});

// ─── BackendTaskWriteCommands.moveTask: orchestration + disposition ─────────

function makeBackend(overrides: Partial<TaskBackend> = {}): TaskBackend {
  return {
    type: 'notion',
    fetchReadyTasks: vi
      .fn()
      .mockResolvedValue([{ task: { id: 'notion:a', dependsOn: [] } }]),
    attachPR: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    fetchTaskPage: vi.fn().mockResolvedValue(''),
    fetchNonMilestoneReadyTasks: vi.fn(),
    updateNotes: vi.fn(),
    appendImplementationNote: vi.fn().mockResolvedValue(undefined),
    listTasksByStatus: vi.fn(),
    createTask: vi.fn().mockResolvedValue('notion:new'),
    setDependsOn: vi.fn().mockResolvedValue(undefined),
    updateBody: vi.fn().mockResolvedValue(undefined),
    updateBodyRaw: vi.fn().mockResolvedValue(undefined),
    setType: vi.fn().mockResolvedValue(undefined),
    setProperties: vi.fn().mockResolvedValue(undefined),
    archive: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as TaskBackend;
}

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    taskId: 'notion:a',
    content: {
      title: 'Moved task',
      sections: {
        summary: 's',
        dependencies: [],
        context: [],
        automatedCriteria: [],
        manualCriteria: [],
      },
      type: '💻 Code',
      priority: '🔴 High',
      status: 'Backlog' as const,
    },
    sourceMilestone: { id: 'm-source', displayOrder: 0 },
    targetMilestone: {
      id: 'm-target',
      displayOrder: 1,
      databaseId: 'db-target',
    },
    originalDisposition: 'archive' as const,
    ...overrides,
  };
}

beforeEach(() => {
  mockDeleteTaskCacheRow.mockReset();
  mockRecordEvent.mockReset();
  mockRehomeGateItems.mockReset();
  mockRehomeSeedItems.mockReset();
  mockResolveMilestoneForProject.mockReset();
  mockResolveMilestoneForProject.mockReturnValue('M-Target');
});

describe('BackendTaskWriteCommands.moveTask', () => {
  it('creates the task on the target board, and Backlog status needs no restore call', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend, 'proj-1');

    const result = await commands.moveTask(baseParams());

    expect(backend.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseId: 'db-target',
        title: 'Moved task',
        type: '💻 Code',
        priority: '🔴 High',
        dependsOn: [],
      }),
      undefined,
    );
    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(result.newTaskId).toBe('notion:new');
  });

  it('restores a non-Backlog status on the new page (authoritative — bypasses the transition state machine)', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend, 'proj-1');

    await commands.moveTask(
      baseParams({
        content: {
          ...baseParams().content,
          status: 'In Progress',
        },
      }),
    );

    expect(backend.updateStatus).toHaveBeenCalledWith(
      'notion:new',
      '🔄 In Progress',
      undefined,
    );
  });

  it('fires the readiness gate when restoring Ready, and blocks without an override', async () => {
    const backend = makeBackend({
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue('## Open Questions\n- unresolved\n'),
    });
    const commands = new BackendTaskWriteCommands(backend, 'proj-1');

    await expect(
      commands.moveTask(
        baseParams({
          content: { ...baseParams().content, status: 'Ready' },
        }),
      ),
    ).rejects.toBeInstanceOf(ReadinessGateError);
    expect(backend.updateStatus).not.toHaveBeenCalled();
  });

  it('allows the Ready restore with a readiness override and records the override event', async () => {
    const backend = makeBackend({
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue('## Open Questions\n- unresolved\n'),
    });
    const commands = new BackendTaskWriteCommands(backend, 'proj-1');

    await commands.moveTask(
      baseParams({
        content: { ...baseParams().content, status: 'Ready' },
      }),
      { source: 'human', readinessOverride: { reason: 'operator says go' } },
    );

    expect(backend.updateStatus).toHaveBeenCalledWith(
      'notion:new',
      '🗂️ Ready',
      expect.anything(),
    );
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'readiness_override' }),
    );
  });

  it('originalDisposition "archive" archives the original with no successor pointer note on it', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend, 'proj-1');

    await commands.moveTask(baseParams({ originalDisposition: 'archive' }));

    expect(backend.archive).toHaveBeenCalledWith('notion:a', undefined);
    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(backend.appendImplementationNote).toHaveBeenCalledWith(
      'notion:new',
      expect.stringContaining('notion:a'),
    );
    expect(backend.appendImplementationNote).not.toHaveBeenCalledWith(
      'notion:a',
      expect.anything(),
    );
  });

  it('originalDisposition "defer" sets the original to Deferred with a successor pointer, and the new page carries an origin back-reference', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend, 'proj-1');

    await commands.moveTask(baseParams({ originalDisposition: 'defer' }));

    expect(backend.archive).not.toHaveBeenCalled();
    expect(backend.updateStatus).toHaveBeenCalledWith(
      'notion:a',
      '⏭️ Deferred',
      undefined,
    );
    expect(backend.appendImplementationNote).toHaveBeenCalledWith(
      'notion:a',
      expect.stringContaining('notion:new'),
    );
    expect(backend.appendImplementationNote).toHaveBeenCalledWith(
      'notion:new',
      expect.stringContaining('notion:a'),
    );
  });

  it('records exactly one task_moved audit event with the specified payload', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend, 'proj-1');

    await commands.moveTask(baseParams());

    const moveEvents = mockRecordEvent.mock.calls
      .map((c) => c[0])
      .filter((e) => e.event_type === 'task_moved');
    expect(moveEvents).toHaveLength(1);
    expect(moveEvents[0]).toMatchObject({
      event_type: 'task_moved',
      actor_type: 'human',
      task_id: 'notion:a',
      payload: {
        sourceMilestone: 'm-source',
        targetMilestone: 'm-target',
        originalTaskId: 'notion:a',
        newTaskId: 'notion:new',
        originalDisposition: 'archive',
        droppedEdges: [],
        cascadeSet: [],
      },
    });
  });

  it('invalidates the source and target board task_cache', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend, 'proj-1');

    await commands.moveTask(baseParams());

    expect(mockDeleteTaskCacheRow).toHaveBeenCalledWith('board:m-source');
    expect(mockDeleteTaskCacheRow).toHaveBeenCalledWith('board:m-target');
  });

  it('eagerly re-warms the affected project boards instead of waiting for the next TaskCacheRefresher tick', async () => {
    const mockRefresh = vi.fn().mockResolvedValue(undefined);
    setTaskWriteRefreshFn(mockRefresh);
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend, 'proj-1');

    await commands.moveTask(baseParams());

    expect(mockRefresh).toHaveBeenCalledWith('proj-1', true);
  });

  it('skips the eager re-warm when no projectId is configured', async () => {
    const mockRefresh = vi.fn().mockResolvedValue(undefined);
    setTaskWriteRefreshFn(mockRefresh);
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await commands.moveTask(baseParams());

    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('carries the gate_item and seed_item accretion re-home, after the Depends On rewrites, using the normalized (unprefixed) source task id and the target milestone display name', async () => {
    const calls: string[] = [];
    const backend = makeBackend({
      setDependsOn: vi.fn().mockImplementation(async () => {
        calls.push('setDependsOn');
      }),
    });
    mockRehomeGateItems.mockImplementationOnce(() => {
      calls.push('rehomeGateItems');
      return ['gate-item-1'];
    });
    mockRehomeSeedItems.mockImplementationOnce(() => {
      calls.push('rehomeSeedItems');
      return ['seed-item-1'];
    });
    const commands = new BackendTaskWriteCommands(backend, 'proj-1');

    await commands.moveTask(baseParams());

    expect(mockResolveMilestoneForProject).toHaveBeenCalledWith(
      'proj-1',
      'm-target',
    );
    expect(mockRehomeGateItems).toHaveBeenCalledWith(
      'proj-1',
      'a',
      'M-Target',
      expect.any(String),
    );
    expect(mockRehomeSeedItems).toHaveBeenCalledWith(
      'proj-1',
      'a',
      'M-Target',
      expect.any(String),
    );
    expect(calls).toEqual(['rehomeGateItems', 'rehomeSeedItems']);
  });

  it('passes no min_deployed_commit argument to the rehome calls — a move never recomputes it', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend, 'proj-1');

    await commands.moveTask(baseParams());

    expect(mockRehomeGateItems.mock.calls[0]).toHaveLength(4);
    expect(mockRehomeSeedItems.mock.calls[0]).toHaveLength(4);
  });

  it('skips the accretion carry when no projectId is configured', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await commands.moveTask(baseParams());

    expect(mockRehomeGateItems).not.toHaveBeenCalled();
    expect(mockRehomeSeedItems).not.toHaveBeenCalled();
  });
});
