import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useDispatch } from '../useDispatch';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';

function makeProject(overrides?: Partial<ProjectConfig>): ProjectConfig {
  return {
    id: 'proj-1',
    name: 'Test Project',
    path: '/repos/test',
    contextUrl: 'https://notion.so/context',
    boardId: 'board-1',
    ...overrides,
  } as ProjectConfig;
}

describe('useDispatch', () => {
  it('sends taskUrl = task.notionUrl (not taskId) for a single task', () => {
    const send = vi.fn();
    const project = makeProject();

    const { result } = renderHook(() => useDispatch(send, project));
    result.current([
      {
        notionUrl: 'https://www.notion.so/Add-task-abc123',
        taskType: '💻 Code',
        taskName: 'Add task abc',
        taskKind: 'milestone',
      },
    ]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: 'dispatch',
      tasks: [
        {
          taskUrl: 'https://www.notion.so/Add-task-abc123',
          projectContextUrl: 'https://notion.so/context',
          taskType: '💻 Code',
          taskName: 'Add task abc',
          taskKind: 'milestone',
          projectId: 'proj-1',
        },
      ],
    });
  });

  it('includes milestoneId in dispatch payload when provided', () => {
    const send = vi.fn();
    const project = makeProject();

    const { result } = renderHook(() => useDispatch(send, project));
    result.current([
      {
        notionUrl: 'https://www.notion.so/task-xyz',
        taskType: '💻 Code',
        taskName: 'Fix something',
        milestoneId: 'milestone-row-id-123',
        taskKind: 'milestone',
      },
    ]);

    expect(send).toHaveBeenCalledWith({
      type: 'dispatch',
      tasks: [
        {
          taskUrl: 'https://www.notion.so/task-xyz',
          projectContextUrl: 'https://notion.so/context',
          taskType: '💻 Code',
          taskName: 'Fix something',
          milestoneId: 'milestone-row-id-123',
          taskKind: 'milestone',
          projectId: 'proj-1',
        },
      ],
    });
  });

  it('sends taskKind: non_milestone when provided', () => {
    const send = vi.fn();
    const project = makeProject();

    const { result } = renderHook(() => useDispatch(send, project));
    result.current([
      {
        notionUrl: 'https://www.notion.so/non-milestone-task',
        taskType: '💻 Code',
        taskName: 'Non-milestone task',
        taskKind: 'non_milestone',
      },
    ]);

    const payload = send.mock.calls[0][0] as {
      tasks: { taskKind: string }[];
    };
    expect(payload.tasks[0].taskKind).toBe('non_milestone');
  });

  it('does not call send when tasks array is empty', () => {
    const send = vi.fn();
    const project = makeProject();

    const { result } = renderHook(() => useDispatch(send, project));
    result.current([]);

    expect(send).not.toHaveBeenCalled();
  });

  it('does not call send when project is null', () => {
    const send = vi.fn();

    const { result } = renderHook(() => useDispatch(send, null));
    result.current([{ notionUrl: 'https://www.notion.so/some-task' }]);

    expect(send).not.toHaveBeenCalled();
  });

  it('sends correct shape for multiple tasks', () => {
    const send = vi.fn();
    const project = makeProject();

    const { result } = renderHook(() => useDispatch(send, project));
    result.current([
      {
        notionUrl: 'https://www.notion.so/task-1',
        taskType: '💻 Code',
        taskName: 'Task 1',
        taskKind: 'milestone',
      },
      {
        notionUrl: 'https://www.notion.so/task-2',
        taskType: '💻 Code',
        taskName: 'Task 2',
        taskKind: 'milestone',
      },
    ]);

    expect(send).toHaveBeenCalledWith({
      type: 'dispatch',
      tasks: [
        {
          taskUrl: 'https://www.notion.so/task-1',
          projectContextUrl: 'https://notion.so/context',
          taskType: '💻 Code',
          taskName: 'Task 1',
          taskKind: 'milestone',
          projectId: 'proj-1',
        },
        {
          taskUrl: 'https://www.notion.so/task-2',
          projectContextUrl: 'https://notion.so/context',
          taskType: '💻 Code',
          taskName: 'Task 2',
          taskKind: 'milestone',
          projectId: 'proj-1',
        },
      ],
    });
  });

  it('omits optional fields from payload when not provided', () => {
    const send = vi.fn();
    const project = makeProject();

    const { result } = renderHook(() => useDispatch(send, project));
    result.current([{ notionUrl: 'https://www.notion.so/minimal-task' }]);

    const payload = send.mock.calls[0][0] as {
      tasks: Record<string, unknown>[];
    };
    expect(payload.tasks[0]).not.toHaveProperty('milestoneId');
    expect(payload.tasks[0]).not.toHaveProperty('taskKind');
    expect(payload.tasks[0]).not.toHaveProperty('taskName');
  });
});
