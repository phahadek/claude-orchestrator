import { describe, it, expect } from 'vitest';
import { DependencyResolver } from './DependencyResolver';
import { NotionTask } from './types';

const resolver = new DependencyResolver();

function makeTask(overrides: Partial<NotionTask> & { id: string }): NotionTask {
  return {
    title: 'Task',
    status: '🗂️ Ready',
    type: '💻 Code',
    notionUrl: `https://notion.so/${overrides.id}`,
    dependsOn: [],
    ...overrides,
  };
}

describe('DependencyResolver', () => {
  it('returns one ResolvedTask per input task', () => {
    const tasks = [makeTask({ id: 'a' }), makeTask({ id: 'b' }), makeTask({ id: 'c' })];
    const result = resolver.resolve(tasks);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.task.id)).toEqual(['a', 'b', 'c']);
  });

  it('marks a task as not blocked when it has no dependencies', () => {
    const tasks = [makeTask({ id: 'a' })];
    const [result] = resolver.resolve(tasks);
    expect(result.blocked).toBe(false);
    expect(result.blockers).toHaveLength(0);
  });

  it('marks a task blocked: true only when a dependency is not Done', () => {
    const tasks = [
      makeTask({ id: 'dep', status: '🗂️ Ready' }),
      makeTask({ id: 'task', dependsOn: ['dep'] }),
    ];
    const resolved = resolver.resolve(tasks);
    const task = resolved.find((r) => r.task.id === 'task')!;
    expect(task.blocked).toBe(true);
  });

  it('does not block a task when its dependency is Done', () => {
    const tasks = [
      makeTask({ id: 'dep', status: '✅ Done' }),
      makeTask({ id: 'task', dependsOn: ['dep'] }),
    ];
    const resolved = resolver.resolve(tasks);
    const task = resolved.find((r) => r.task.id === 'task')!;
    expect(task.blocked).toBe(false);
    expect(task.blockers).toHaveLength(0);
  });

  it('includes both direct and transitive blockers', () => {
    const tasks = [
      makeTask({ id: 'a', status: '🗂️ Ready' }),
      makeTask({ id: 'b', status: '🗂️ Ready', dependsOn: ['a'] }),
      makeTask({ id: 'c', dependsOn: ['b'] }),
    ];
    const resolved = resolver.resolve(tasks);
    const c = resolved.find((r) => r.task.id === 'c')!;
    const blockerIds = c.blockers.map((t) => t.id);
    expect(blockerIds).toContain('b');
    expect(blockerIds).toContain('a');
  });

  it('sets nonCode: true for Planning tasks', () => {
    const tasks = [makeTask({ id: 'p', type: '📋 Planning' })];
    const [result] = resolver.resolve(tasks);
    expect(result.nonCode).toBe(true);
  });

  it('sets nonCode: true for Testing tasks', () => {
    const tasks = [makeTask({ id: 't', type: '🧪 Testing' })];
    const [result] = resolver.resolve(tasks);
    expect(result.nonCode).toBe(true);
  });

  it('sets nonCode: false for Code tasks', () => {
    const tasks = [makeTask({ id: 'c', type: '💻 Code' })];
    const [result] = resolver.resolve(tasks);
    expect(result.nonCode).toBe(false);
  });

  it('handles circular dependencies without throwing', () => {
    const tasks = [
      makeTask({ id: 'a', dependsOn: ['b'] }),
      makeTask({ id: 'b', dependsOn: ['a'] }),
    ];
    expect(() => resolver.resolve(tasks)).not.toThrow();
  });

  it('treats missing dependency IDs as satisfied', () => {
    const tasks = [makeTask({ id: 'a', dependsOn: ['missing-id'] })];
    const [result] = resolver.resolve(tasks);
    expect(result.blocked).toBe(false);
    expect(result.blockers).toHaveLength(0);
  });
});
