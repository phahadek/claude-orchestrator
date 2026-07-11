// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { sortByPriority, sortStable, priorityRank } from '../taskSort';
import type { TaskView } from '../../types/taskView';

function makeTask(taskId: string, priority: string): TaskView {
  return {
    taskId,
    taskName: `Task ${taskId}`,
    notionStatus: 'In Progress',
    displayStatus: 'ready',
    pauseReason: null,
    priority,
    notionUrl: `https://notion.so/${taskId}`,
    taskType: '💻 Code',
    blocked: false,
    blockerNames: [],
    wave: 1,
    codeSession: null,
    pr: null,
    review: null,
    totalTokens: { input: 0, output: 0 },
    assignedRepo: null,
  };
}

describe('sortByPriority / sortStable', () => {
  it('is deterministic across differently-ordered inputs for equal-priority items', () => {
    const a = makeTask('task-a', '🟡 Medium');
    const b = makeTask('task-b', '🟡 Medium');
    const c = makeTask('task-c', '🟡 Medium');

    const order1 = sortByPriority([b, c, a]).map((t) => t.taskId);
    const order2 = sortByPriority([c, a, b]).map((t) => t.taskId);
    const order3 = sortByPriority([a, b, c]).map((t) => t.taskId);

    expect(order1).toEqual(['task-a', 'task-b', 'task-c']);
    expect(order2).toEqual(order1);
    expect(order3).toEqual(order1);
  });

  it('is idempotent — sorting an already-sorted list produces the same order', () => {
    const tasks = [
      makeTask('task-z', '🔴 High'),
      makeTask('task-a', '🔴 High'),
      makeTask('task-m', '🟢 Low'),
    ];
    const once = sortByPriority(tasks);
    const twice = sortByPriority(once);
    expect(twice.map((t) => t.taskId)).toEqual(once.map((t) => t.taskId));
  });

  it('sorts by priority first, then falls back to id for ties', () => {
    const high = makeTask('task-b', '🔴 High');
    const low = makeTask('task-a', '🟢 Low');
    const result = sortByPriority([low, high]);
    expect(result.map((t) => t.taskId)).toEqual(['task-b', 'task-a']);
  });

  it('sortStable is the same function as sortByPriority', () => {
    expect(sortStable).toBe(sortByPriority);
  });

  it('unset priorities rank last', () => {
    expect(priorityRank('unknown')).toBe(99);
    expect(priorityRank('🔴 High')).toBeLessThan(priorityRank('🟡 Medium'));
    expect(priorityRank('🟡 Medium')).toBeLessThan(priorityRank('🟢 Low'));
  });
});
