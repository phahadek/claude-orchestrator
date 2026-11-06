import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTestLaneRunStatus } from './useTestLaneRunStatus';
import { publishTestRequestRunStatus } from './testRequestRunStatusBus';
import { apiRequest } from '../api/projects';

vi.mock('../api/projects', () => ({ apiRequest: vi.fn() }));

const payload = {
  runId: 'r',
  projectId: 'proj-1',
  contentHash: 'h',
  status: 'running' as const,
  sessionId: 'sess-1',
  startedAt: 1,
};

describe('useTestLaneRunStatus', () => {
  beforeEach(() => {
    vi.mocked(apiRequest).mockReset();
  });

  it('fetches the snapshot for the session', async () => {
    vi.mocked(apiRequest).mockResolvedValue({ run: { status: 'passed' } });
    const { result } = renderHook(() =>
      useTestLaneRunStatus('proj-1', 'sess-1'),
    );
    await waitFor(() => expect(result.current).toBe('passed'));
    expect(vi.mocked(apiRequest).mock.calls[0][0]).toBe(
      '/api/test-request-runs?projectId=proj-1&sessionId=sess-1',
    );
  });

  it('refetches on a matching payload and ignores another session', async () => {
    vi.mocked(apiRequest).mockResolvedValue({ run: { status: 'running' } });
    const { result } = renderHook(() =>
      useTestLaneRunStatus('proj-1', 'sess-1'),
    );
    await waitFor(() => expect(result.current).toBe('running'));

    act(() => publishTestRequestRunStatus({ ...payload, sessionId: 'other' }));
    expect(apiRequest).toHaveBeenCalledTimes(1);

    vi.mocked(apiRequest).mockResolvedValue({ run: { status: 'passed' } });
    act(() => publishTestRequestRunStatus(payload));
    await waitFor(() => expect(result.current).toBe('passed'));
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it('returns null without a session', () => {
    const { result } = renderHook(() => useTestLaneRunStatus('proj-1', null));
    expect(result.current).toBeNull();
    expect(apiRequest).not.toHaveBeenCalled();
  });
});
