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
  it('sends a dispatch WS message with taskId mapped to taskUrl for a single task', () => {
    const send = vi.fn();
    const project = makeProject();

    const { result } = renderHook(() => useDispatch(send, project));
    result.current([{ taskId: 'notion-page-id-123', taskType: '💻 Code' }]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: 'dispatch',
      tasks: [
        {
          taskUrl: 'notion-page-id-123',
          projectContextUrl: 'https://notion.so/context',
          taskType: '💻 Code',
          projectId: 'proj-1',
        },
      ],
    });
  });

  it('passes YAML task id as taskUrl (not a URL)', () => {
    const send = vi.fn();
    const project = makeProject();

    const { result } = renderHook(() => useDispatch(send, project));
    result.current([{ taskId: 't2-ready-unblocked', taskType: '💻 Code' }]);

    expect(send).toHaveBeenCalledWith({
      type: 'dispatch',
      tasks: [
        {
          taskUrl: 't2-ready-unblocked',
          projectContextUrl: 'https://notion.so/context',
          taskType: '💻 Code',
          projectId: 'proj-1',
        },
      ],
    });
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
    result.current([{ taskId: 'some-task-id' }]);

    expect(send).not.toHaveBeenCalled();
  });

  it('sends correct shape for multiple tasks', () => {
    const send = vi.fn();
    const project = makeProject();

    const { result } = renderHook(() => useDispatch(send, project));
    result.current([
      { taskId: 'task-id-1', taskType: '💻 Code' },
      { taskId: 'task-id-2', taskType: '💻 Code' },
    ]);

    expect(send).toHaveBeenCalledWith({
      type: 'dispatch',
      tasks: [
        {
          taskUrl: 'task-id-1',
          projectContextUrl: 'https://notion.so/context',
          taskType: '💻 Code',
          projectId: 'proj-1',
        },
        {
          taskUrl: 'task-id-2',
          projectContextUrl: 'https://notion.so/context',
          taskType: '💻 Code',
          projectId: 'proj-1',
        },
      ],
    });
  });
});
