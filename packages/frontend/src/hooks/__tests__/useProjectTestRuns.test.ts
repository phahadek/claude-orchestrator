import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useProjectTestRuns } from '../useProjectTestRuns';
import { publishTestRequestRunStatus } from '../testRequestRunStatusBus';
import * as projectsApi from '../../api/projects';

describe('useProjectTestRuns', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches the project-scope run feed on mount', async () => {
    vi.spyOn(projectsApi, 'apiRequest').mockResolvedValue({
      runs: [{ id: 'run-1', projectId: 'proj-1' }],
    });

    const { result } = renderHook(() => useProjectTestRuns('proj-1'));

    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    expect(projectsApi.apiRequest).toHaveBeenCalledWith(
      '/api/test-request-runs/project?projectId=proj-1',
    );
  });

  it('refetches when a test_request_run_status message for the active project arrives', async () => {
    const apiRequestSpy = vi
      .spyOn(projectsApi, 'apiRequest')
      .mockResolvedValue({ runs: [] });

    renderHook(() => useProjectTestRuns('proj-1'));

    await waitFor(() => expect(apiRequestSpy).toHaveBeenCalledTimes(1));

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

    await waitFor(() => expect(apiRequestSpy).toHaveBeenCalledTimes(2));
  });

  it('does not refetch for a message scoped to a different project', async () => {
    const apiRequestSpy = vi
      .spyOn(projectsApi, 'apiRequest')
      .mockResolvedValue({ runs: [] });

    renderHook(() => useProjectTestRuns('proj-1'));

    await waitFor(() => expect(apiRequestSpy).toHaveBeenCalledTimes(1));

    act(() => {
      publishTestRequestRunStatus({
        runId: 'run-3',
        projectId: 'proj-other',
        contentHash: 'hash-3',
        status: 'running',
        sessionId: null,
        startedAt: 1000,
      });
    });

    // No re-fetch should be queued for the other-project message; give any
    // stray async work a tick to settle before asserting the call count held.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(apiRequestSpy).toHaveBeenCalledTimes(1);
  });
});
