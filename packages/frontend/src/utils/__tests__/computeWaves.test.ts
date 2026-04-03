import { describe, it, expect } from 'vitest';
import { computeWaves } from '../computeWaves';
import type { ResolvedTask } from '@claude-dashboard/backend/src/notion/types';

function makeTask(id: string, status: string, dependsOn: string[] = []): ResolvedTask {
  return {
    task: { id, title: `Task ${id}`, status, type: '💻 Code', dependsOn, notionUrl: `https://notion.so/${id}` },
    blocked: false,
    blockers: [],
    nonCode: false,
    wave: 1,
  };
}

describe('computeWaves', () => {
  it('returns empty waves for empty task list', () => {
    const result = computeWaves([]);
    expect(result.waves).toEqual([]);
    expect(result.doneCount).toBe(0);
    expect(result.totalNonDeferred).toBe(0);
    expect(result.deferredCount).toBe(0);
  });

  it('places tasks with no deps in wave 1', () => {
    const tasks = [
      makeTask('a', '🗂️ Ready'),
      makeTask('b', '🗂️ Ready'),
    ];
    const { waves } = computeWaves(tasks);
    expect(waves).toHaveLength(1);
    expect(waves[0].map((t) => t.task.id).sort()).toEqual(['a', 'b']);
  });

  it('places tasks whose deps are Done into wave 1', () => {
    const tasks = [
      makeTask('done1', '✅ Done'),
      makeTask('a', '🗂️ Ready', ['done1']),
    ];
    const { waves } = computeWaves(tasks);
    // Done tasks don't appear in waves, 'a' goes to wave 1 because its dep is Done
    expect(waves).toHaveLength(1);
    expect(waves[0][0].task.id).toBe('a');
  });

  it('correctly groups tasks into multiple waves', () => {
    const tasks = [
      makeTask('a', '🗂️ Ready'),          // wave 1 — no deps
      makeTask('b', '🗂️ Ready'),          // wave 1 — no deps
      makeTask('c', '🗂️ Ready', ['a']),   // wave 2 — depends on a
      makeTask('d', '🗂️ Ready', ['b']),   // wave 2 — depends on b
      makeTask('e', '🗂️ Ready', ['c', 'd']), // wave 3
    ];
    const { waves } = computeWaves(tasks);
    expect(waves).toHaveLength(3);
    expect(waves[0].map((t) => t.task.id).sort()).toEqual(['a', 'b']);
    expect(waves[1].map((t) => t.task.id).sort()).toEqual(['c', 'd']);
    expect(waves[2].map((t) => t.task.id).sort()).toEqual(['e']);
  });

  it('excludes deferred tasks from waves', () => {
    const tasks = [
      makeTask('a', '🗂️ Ready'),
      makeTask('b', '⏭️ Deferred'),
    ];
    const { waves, deferredCount } = computeWaves(tasks);
    expect(deferredCount).toBe(1);
    expect(waves.flat().map((t) => t.task.id)).not.toContain('b');
  });

  it('excludes deferred tasks from progress bar total', () => {
    const tasks = [
      makeTask('a', '✅ Done'),
      makeTask('b', '🗂️ Ready'),
      makeTask('c', '⏭️ Deferred'),
    ];
    const { totalNonDeferred, deferredCount } = computeWaves(tasks);
    expect(totalNonDeferred).toBe(2);
    expect(deferredCount).toBe(1);
  });

  it('progress bar percentage matches doneCount / totalNonDeferred', () => {
    const tasks = [
      makeTask('a', '✅ Done'),
      makeTask('b', '✅ Done'),
      makeTask('c', '🗂️ Ready'),
      makeTask('d', '⏭️ Deferred'),
    ];
    const { doneCount, totalNonDeferred } = computeWaves(tasks);
    expect(doneCount).toBe(2);
    expect(totalNonDeferred).toBe(3);
    expect(doneCount / totalNonDeferred).toBeCloseTo(0.667, 2);
  });

  it('per-status counts match actual task statuses (excluding deferred)', () => {
    const tasks = [
      makeTask('a', '✅ Done'),
      makeTask('b', '✅ Done'),
      makeTask('c', '🔄 In Progress'),
      makeTask('d', '🗂️ Ready'),
      makeTask('e', '⏭️ Deferred'),
    ];
    const { statusCounts } = computeWaves(tasks);
    expect(statusCounts['✅ Done']).toBe(2);
    expect(statusCounts['🔄 In Progress']).toBe(1);
    expect(statusCounts['🗂️ Ready']).toBe(1);
    expect(statusCounts['⏭️ Deferred']).toBeUndefined();
  });

  it('handles circular deps gracefully by putting remaining tasks in last wave', () => {
    const tasks = [
      makeTask('a', '🗂️ Ready', ['b']),
      makeTask('b', '🗂️ Ready', ['a']),
    ];
    const { waves } = computeWaves(tasks);
    // Should not loop forever — remaining tasks end up in a single wave
    expect(waves).toHaveLength(1);
    expect(waves[0].map((t) => t.task.id).sort()).toEqual(['a', 'b']);
  });

  it('done tasks are not included in waves', () => {
    const tasks = [
      makeTask('a', '✅ Done'),
      makeTask('b', '✅ Done'),
      makeTask('c', '🗂️ Ready', ['a', 'b']),
    ];
    const { waves } = computeWaves(tasks);
    const allWaveTasks = waves.flat().map((t) => t.task.id);
    expect(allWaveTasks).not.toContain('a');
    expect(allWaveTasks).not.toContain('b');
    expect(allWaveTasks).toContain('c');
  });
});
