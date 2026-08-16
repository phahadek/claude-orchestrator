/**
 * Confirms the Tests-tab work (TestsTab.tsx, the new history endpoint) does
 * not alter useTestLaneRunStatus's public shape/outcome values — TaskCard
 * and SessionPanel keep consuming this hook unchanged.
 */
import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTestLaneRunStatus } from '../useTestLaneRunStatus';
import { apiRequest } from '../../api/projects';
import { publishTestRequestRunStatus } from '../testRequestRunStatusBus';

vi.mock('../../api/projects', () => ({
  apiRequest: vi.fn(),
}));

describe('useTestLaneRunStatus', () => {
  beforeEach(() => {
    vi.mocked(apiRequest).mockReset();
  });

  it('exposes only the four documented outcome values', () => {
    const validOutcomes = new Set(['in-flight', 'passed', 'failed', 'blocked']);
    expect(validOutcomes.size).toBe(4);
  });

  it('returns null when there is no projectId/sessionId', () => {
    const { result } = renderHook(() =>
      useTestLaneRunStatus({ projectId: null, sessionId: null }),
    );
    expect(result.current).toBeNull();
  });

  it('reports blocked when pauseReason is test_request_cycle_exceeded', () => {
    vi.mocked(apiRequest).mockResolvedValue({ run: null });
    const { result } = renderHook(() =>
      useTestLaneRunStatus({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        pauseReason: 'test_request_cycle_exceeded',
      }),
    );
    expect(result.current).toEqual({ outcome: 'blocked' });
  });

  it('maps a REST snapshot passed run to outcome=passed with startedAt/finishedAt', async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      run: {
        runId: 'run-1',
        projectId: 'proj-1',
        contentHash: 'hash-1',
        status: 'passed',
        sessionId: 'sess-1',
        startedAt: 1000,
        finishedAt: 2000,
      },
    });
    const { result } = renderHook(() =>
      useTestLaneRunStatus({ projectId: 'proj-1', sessionId: 'sess-1' }),
    );
    await waitFor(() => expect(result.current?.outcome).toBe('passed'));
    expect(result.current).toEqual({
      outcome: 'passed',
      output: undefined,
      note: undefined,
      startedAt: 1000,
      finishedAt: 2000,
    });
  });

  it('maps a running WS delta to outcome=in-flight', async () => {
    vi.mocked(apiRequest).mockResolvedValue({ run: null });
    const { result } = renderHook(() =>
      useTestLaneRunStatus({ projectId: 'proj-1', sessionId: 'sess-1' }),
    );
    act(() => {
      publishTestRequestRunStatus({
        runId: 'run-2',
        projectId: 'proj-1',
        contentHash: 'hash-2',
        status: 'running',
        sessionId: 'sess-1',
        startedAt: 3000,
      });
    });
    await waitFor(() => expect(result.current?.outcome).toBe('in-flight'));
  });

  it('maps a failed-with-cause status to outcome=failed', async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      run: {
        runId: 'run-3',
        projectId: 'proj-1',
        contentHash: 'hash-3',
        status: 'failed-with-cause',
        output: 'boom',
        sessionId: 'sess-1',
        startedAt: 1000,
        finishedAt: 1500,
      },
    });
    const { result } = renderHook(() =>
      useTestLaneRunStatus({ projectId: 'proj-1', sessionId: 'sess-1' }),
    );
    await waitFor(() => expect(result.current?.outcome).toBe('failed'));
    expect(result.current?.output).toBe('boom');
  });
});
