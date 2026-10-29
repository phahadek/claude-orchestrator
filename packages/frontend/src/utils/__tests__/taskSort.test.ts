// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { sortByPriority } from '../taskSort';
import type { TaskView } from '../../types/taskView';

// Mirrors the backend normalizer's output, which the board view carries to the frontend.
const LEVELS: Record<string, NonNullable<TaskView['priorityLevel']>> = {
  '🔴 Critical': 'critical',
  '🔴 High': 'high',
  '🟠 High': 'high',
  '🟡 Medium': 'medium',
  '🟢 Low': 'low',
};
const RANKS = { critical: 0, high: 1, medium: 2, low: 3 };

function makeTask(taskId: string, priority: string): TaskView {
  const priorityLevel = LEVELS[priority] ?? null;
  return {
    priorityLevel,
    priorityRank: priorityLevel ? RANKS[priorityLevel] : 4,
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
    planningSession: null,
    pr: null,
    review: null,
    totalTokens: { input: 0, output: 0 },
    assignedRepo: null,
  };
}

describe('sortByPriority', () => {
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

  it('sorts Critical, High (both emoji), Medium, Low, unset', () => {
    const tasks = [
      makeTask('t-unset', ''),
      makeTask('t-low', '🟢 Low'),
      makeTask('t-med', '🟡 Medium'),
      makeTask('t-orange', '🟠 High'),
      makeTask('t-red', '🔴 High'),
      makeTask('t-crit', '🔴 Critical'),
    ];
    expect(sortByPriority(tasks).map((t) => t.taskId)).toEqual([
      't-crit',
      't-orange',
      't-red',
      't-med',
      't-low',
      't-unset',
    ]);
  });
});
