import { describe, it, expect } from 'vitest';
import { computeProgressFromTaskViews } from '../computeWaves';
import type { TaskView } from '../../types/taskView';

function makeTaskView(
  taskId: string,
  notionStatus: string,
  wave = 1,
): TaskView {
  return {
    taskId,
    taskName: `Task ${taskId}`,
    notionStatus,
    displayStatus: 'ready',
    pauseReason: null,
    priority: '🟡 Medium',
    notionUrl: `https://notion.so/${taskId}`,
    taskType: '💻 Code',
    blocked: false,
    blockerNames: [],
    wave,
    codeSession: null,
    pr: null,
    review: null,
    totalTokens: { input: 0, output: 0 },
  };
}

describe('computeProgressFromTaskViews', () => {
  // AC1: progress bar counts update when a task moves from Ready to In Progress
  it('counts update when a task moves from Ready to In Progress', () => {
    const initial: TaskView[] = [
      makeTaskView('t1', '🗂️ Ready'),
      makeTaskView('t2', '🗂️ Ready'),
    ];
    const before = computeProgressFromTaskViews(initial);
    expect(before.statusCounts['🗂️ Ready']).toBe(2);
    expect(before.statusCounts['🔄 In Progress']).toBeUndefined();

    // Simulate task moving to In Progress (as would happen when taskViews is updated)
    const updated = initial.map((t) =>
      t.taskId === 't1' ? { ...t, notionStatus: '🔄 In Progress' } : t,
    );
    const after = computeProgressFromTaskViews(updated);
    expect(after.statusCounts['🗂️ Ready']).toBe(1);
    expect(after.statusCounts['🔄 In Progress']).toBe(1);
  });

  // AC2: progress bar counts update when a task_updated event is received
  it('counts update when a task_updated TaskView is merged into the task list', () => {
    const tasks: TaskView[] = [
      makeTaskView('t1', '🗂️ Ready'),
      makeTaskView('t2', '🗂️ Ready'),
    ];

    // Simulate task_updated WS event: backend emits updated TaskView for t1
    const taskUpdate: TaskView = { ...makeTaskView('t1', '🔄 In Progress') };

    // App.tsx merges the update in-place (same pattern used by TaskList)
    const merged = tasks.map((t) =>
      t.taskId === taskUpdate.taskId ? taskUpdate : t,
    );

    const result = computeProgressFromTaskViews(merged);
    expect(result.statusCounts['🔄 In Progress']).toBe(1);
    expect(result.statusCounts['🗂️ Ready']).toBe(1);
    expect(result.totalNonDeferred).toBe(2);
  });

  // AC3: progress bar counts update when Tasks view data changes (without opening Dispatch Modal)
  it('counts reflect the current taskViews REST data, not the WS tasks_ready snapshot', () => {
    // The progress bar is driven by taskViews (/api/tasks/active), which updates
    // independently of the fetch_tasks WS round-trip that Dispatch Modal triggers.
    const taskViews: TaskView[] = [
      makeTaskView('t1', '✅ Done'),
      makeTaskView('t2', '🔄 In Progress'),
      makeTaskView('t3', '🗂️ Ready'),
    ];

    const result = computeProgressFromTaskViews(taskViews);
    expect(result.doneCount).toBe(1);
    expect(result.statusCounts['🔄 In Progress']).toBe(1);
    expect(result.statusCounts['🗂️ Ready']).toBe(1);
    expect(result.totalNonDeferred).toBe(3);

    // When taskViews changes (e.g. after a session completes), counts update immediately
    const afterSessionComplete = taskViews.map((t) =>
      t.taskId === 't2' ? { ...t, notionStatus: '👀 In Review' } : t,
    );
    const after = computeProgressFromTaskViews(afterSessionComplete);
    expect(after.statusCounts['🔄 In Progress']).toBeUndefined();
    expect(after.statusCounts['👀 In Review']).toBe(1);
  });

  it('returns empty result for empty task list', () => {
    const result = computeProgressFromTaskViews([]);
    expect(result.waves).toEqual([]);
    expect(result.doneCount).toBe(0);
    expect(result.totalNonDeferred).toBe(0);
    expect(result.deferredCount).toBe(0);
  });

  it('groups non-done tasks by pre-computed wave number', () => {
    const tasks: TaskView[] = [
      makeTaskView('a', '🗂️ Ready', 1),
      makeTaskView('b', '🗂️ Ready', 1),
      makeTaskView('c', '🗂️ Ready', 2),
    ];
    const { waves } = computeProgressFromTaskViews(tasks);
    expect(waves).toHaveLength(2);
    expect(waves[0].map((t) => t.taskId).sort()).toEqual(['a', 'b']);
    expect(waves[1].map((t) => t.taskId)).toEqual(['c']);
  });

  it('excludes done tasks from waves but includes them in statusCounts', () => {
    const tasks: TaskView[] = [
      makeTaskView('a', '✅ Done'),
      makeTaskView('b', '🗂️ Ready'),
    ];
    const { waves, doneCount, statusCounts } =
      computeProgressFromTaskViews(tasks);
    expect(doneCount).toBe(1);
    expect(statusCounts['✅ Done']).toBe(1);
    // Done task does not appear in waves
    expect(waves.flat().map((t) => t.taskId)).not.toContain('a');
    expect(waves.flat().map((t) => t.taskId)).toContain('b');
  });
});
