import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useTasks } from '../useTasks';
import type { ResolvedTask } from '@claude-orchestrator/backend/src/notion/types';

function makeResolvedTask(id: string, overrides: Partial<ResolvedTask['task']> = {}): ResolvedTask {
  return {
    task: {
      id,
      title: `Task ${id}`,
      status: '🗂️ Ready',
      type: '💻 Code',
      dependsOn: [],
      notionUrl: `https://notion.so/${id}`,
      priority: '🟡 Medium',
      ...overrides,
    },
    blocked: false,
    blockers: [],
    nonCode: false,
    wave: 1,
  };
}

describe('useTasks', () => {
  it('sends fetch_tasks on mount with the active projectId/milestoneId', () => {
    const send = vi.fn().mockReturnValue(true);
    renderHook(() => useTasks({
      projectId: 'p1',
      milestoneId: 'm1',
      send,
      tasks: [],
    }));

    expect(send).toHaveBeenCalledWith({ type: 'fetch_tasks', projectId: 'p1', milestoneId: 'm1' });
  });

  it('does not send fetch_tasks when projectId or milestoneId is missing', () => {
    const send = vi.fn().mockReturnValue(true);
    renderHook(() => useTasks({
      projectId: null,
      milestoneId: 'm1',
      send,
      tasks: [],
    }));
    expect(send).not.toHaveBeenCalled();

    renderHook(() => useTasks({
      projectId: 'p1',
      milestoneId: null,
      send,
      tasks: [],
    }));
    expect(send).not.toHaveBeenCalled();
  });

  it('refetches when projectId changes', () => {
    const send = vi.fn().mockReturnValue(true);
    const { rerender } = renderHook(
      (props: { projectId: string; milestoneId: string }) =>
        useTasks({ ...props, send, tasks: [] }),
      { initialProps: { projectId: 'p1', milestoneId: 'm1' } },
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith({ type: 'fetch_tasks', projectId: 'p1', milestoneId: 'm1' });

    rerender({ projectId: 'p2', milestoneId: 'm1' });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ type: 'fetch_tasks', projectId: 'p2', milestoneId: 'm1' });
  });

  it('refetches when milestoneId changes', () => {
    const send = vi.fn().mockReturnValue(true);
    const { rerender } = renderHook(
      (props: { projectId: string; milestoneId: string }) =>
        useTasks({ ...props, send, tasks: [] }),
      { initialProps: { projectId: 'p1', milestoneId: 'm1' } },
    );

    expect(send).toHaveBeenCalledTimes(1);
    rerender({ projectId: 'p1', milestoneId: 'm2' });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ type: 'fetch_tasks', projectId: 'p1', milestoneId: 'm2' });
  });

  it('refresh() sends fetch_tasks with skipCache=true', () => {
    const send = vi.fn().mockReturnValue(true);
    const { result } = renderHook(() => useTasks({
      projectId: 'p1',
      milestoneId: 'm1',
      send,
      tasks: [],
    }));

    act(() => {
      result.current.refresh();
    });

    expect(send).toHaveBeenLastCalledWith({
      type: 'fetch_tasks', projectId: 'p1', milestoneId: 'm1', skipCache: true,
    });
  });

  it('loading is true after sending and clears when a new tasks array reference arrives', () => {
    const send = vi.fn().mockReturnValue(true);
    const initial: ResolvedTask[] = [];
    const { result, rerender } = renderHook(
      (props: { tasks: ResolvedTask[] }) =>
        useTasks({ projectId: 'p1', milestoneId: 'm1', send, tasks: props.tasks }),
      { initialProps: { tasks: initial } },
    );

    expect(result.current.loading).toBe(true);

    const next = [makeResolvedTask('t1')];
    rerender({ tasks: next });

    expect(result.current.loading).toBe(false);
  });

  it('refetches when refreshTrigger increments', () => {
    const send = vi.fn().mockReturnValue(true);
    const { rerender } = renderHook(
      (props: { refreshTrigger: number }) =>
        useTasks({ projectId: 'p1', milestoneId: 'm1', send, tasks: [], refreshTrigger: props.refreshTrigger }),
      { initialProps: { refreshTrigger: 0 } },
    );

    expect(send).toHaveBeenCalledTimes(1);

    rerender({ refreshTrigger: 1 });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ type: 'fetch_tasks', projectId: 'p1', milestoneId: 'm1' });
  });

  it('exposes the current tasks array', () => {
    const send = vi.fn().mockReturnValue(true);
    const tasks = [makeResolvedTask('t1'), makeResolvedTask('t2')];
    const { result } = renderHook(() => useTasks({
      projectId: 'p1',
      milestoneId: 'm1',
      send,
      tasks,
    }));

    expect(result.current.tasks).toBe(tasks);
  });
});
