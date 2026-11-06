import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useProjectTestHealth } from '../useProjectTestHealth';
import { publishTestRequestRunStatus } from '../testRequestRunStatusBus';
import * as projectsApi from '../../api/projects';

function health(path: string) {
  if (path.includes('pass-rate-trend'))
    return { project: 'proj-1', windowDays: 30, runKinds: {} };
  if (path.includes('queue-wait'))
    return { project: 'proj-1', windowDays: 30, days: [] };
  return { slowest: [], regressed: [] };
}

describe('useProjectTestHealth', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches the three Health endpoints with the window', async () => {
    const spy = vi
      .spyOn(projectsApi, 'apiRequest')
      .mockImplementation(async (path) => health(String(path)) as never);

    const { result } = renderHook(() => useProjectTestHealth('proj-1', 30));

    await waitFor(() => expect(result.current.passRate).not.toBeNull());
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy).toHaveBeenCalledWith(
      '/api/milestones/proj-1/test-analytics/pass-rate-trend?window=30',
    );
  });

  it('refetches on a run-status bus event for the project', async () => {
    const spy = vi
      .spyOn(projectsApi, 'apiRequest')
      .mockImplementation(async (path) => health(String(path)) as never);

    renderHook(() => useProjectTestHealth('proj-1'));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));

    act(() => {
      publishTestRequestRunStatus({
        runId: 'run-2',
        projectId: 'proj-1',
        contentHash: 'hash-2',
        status: 'running',
        sessionId: null,
        startedAt: 1000,
      });
    });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(6));
  });
});
