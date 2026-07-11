import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useTaskPage } from '../useTaskPage';

vi.mock('../../auth/deviceToken', () => ({
  getDeviceToken: () => null,
}));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  delete (globalThis as { fetch?: typeof fetch }).fetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('useTaskPage', () => {
  it('does nothing when taskId or projectId is missing', () => {
    const { result } = renderHook(() => useTaskPage(null, 'proj-1'));
    expect(result.current).toEqual({
      markdown: null,
      loading: false,
      error: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches markdown for a task and transitions loading -> loaded', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ markdown: '# Title\n\n- [ ] item' }),
    );

    const { result } = renderHook(() => useTaskPage('task-1', 'proj-1'));

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.markdown).toBe('# Title\n\n- [ ] item');
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/task-1/page?projectId=proj-1',
      expect.anything(),
    );
  });

  it('sets a non-blocking error on fetch failure', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'task not found' }, 404),
    );

    const { result } = renderHook(() => useTaskPage('task-2', 'proj-1'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.markdown).toBeNull();
    expect(result.current.error).toBe('task not found');
  });

  it('caches by taskId + projectId and does not refetch on rerender', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ markdown: '# Cached' }));

    const { result, rerender } = renderHook(
      ({ taskId, projectId }) => useTaskPage(taskId, projectId),
      { initialProps: { taskId: 'task-3', projectId: 'proj-1' } },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ taskId: 'task-3', projectId: 'proj-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.markdown).toBe('# Cached');
  });

  it('refetches when taskId changes', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ markdown: '# First' }))
      .mockResolvedValueOnce(jsonResponse({ markdown: '# Second' }));

    const { result, rerender } = renderHook(
      ({ taskId, projectId }) => useTaskPage(taskId, projectId),
      { initialProps: { taskId: 'task-4', projectId: 'proj-1' } },
    );

    await waitFor(() => {
      expect(result.current.markdown).toBe('# First');
    });

    rerender({ taskId: 'task-5', projectId: 'proj-1' });

    await waitFor(() => {
      expect(result.current.markdown).toBe('# Second');
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
