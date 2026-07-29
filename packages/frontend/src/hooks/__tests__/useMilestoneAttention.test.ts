import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useMilestoneAttention } from '../useMilestoneAttention';
import * as projectsApi from '../../api/projects';

describe('useMilestoneAttention', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes pendingCount from the poll response', async () => {
    vi.spyOn(projectsApi, 'apiRequest').mockResolvedValue({
      pendingCount: 3,
      tier2: [],
    });

    const { result } = renderHook(() =>
      useMilestoneAttention({ projectId: 'proj-1', milestoneId: 'M12' }),
    );

    await waitFor(() => expect(result.current.pendingCount).toBe(3));
    expect(result.current.lastTier2Batch).toBeNull();
  });

  it('fires a tier-2 batch for a newly-seen signal key', async () => {
    vi.spyOn(projectsApi, 'apiRequest').mockResolvedValue({
      pendingCount: 1,
      tier2: [{ key: 'aging:intent-1', type: 'aging', message: 'stale' }],
    });

    const { result } = renderHook(() =>
      useMilestoneAttention({ projectId: 'proj-1', milestoneId: 'M12' }),
    );

    await waitFor(() =>
      expect(result.current.lastTier2Batch?.events).toHaveLength(1),
    );
    expect(result.current.lastTier2Batch?.events[0].key).toBe(
      'aging:intent-1',
    );
  });

  it('does not re-fire the same signal key on a repeated poll', async () => {
    const spy = vi.spyOn(projectsApi, 'apiRequest').mockResolvedValue({
      pendingCount: 1,
      tier2: [{ key: 'aging:intent-1', type: 'aging', message: 'stale' }],
    });

    const { result, rerender } = renderHook(
      ({ key }) =>
        useMilestoneAttention({
          projectId: 'proj-1',
          milestoneId: 'M12',
          invalidationKey: key,
        }),
      { initialProps: { key: 0 } },
    );

    await waitFor(() =>
      expect(result.current.lastTier2Batch?.events).toHaveLength(1),
    );
    const firstReceivedAt = result.current.lastTier2Batch?.receivedAt;

    // Simulate a second poll for the same still-present condition.
    act(() => {
      rerender({ key: 1 });
    });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    // No new batch was emitted for the repeat — the last one is still the first.
    expect(result.current.lastTier2Batch?.receivedAt).toBe(firstReceivedAt);
  });

  it('re-fires after a condition clears and later recurs', async () => {
    const spy = vi.spyOn(projectsApi, 'apiRequest');
    spy.mockResolvedValueOnce({
      pendingCount: 1,
      tier2: [{ key: 'aging:intent-1', type: 'aging', message: 'stale' }],
    });

    const { result, rerender } = renderHook(
      ({ key }) =>
        useMilestoneAttention({
          projectId: 'proj-1',
          milestoneId: 'M12',
          invalidationKey: key,
        }),
      { initialProps: { key: 0 } },
    );

    await waitFor(() =>
      expect(result.current.lastTier2Batch?.events).toHaveLength(1),
    );
    const firstReceivedAt = result.current.lastTier2Batch?.receivedAt;

    // Condition clears.
    spy.mockResolvedValueOnce({ pendingCount: 0, tier2: [] });
    act(() => {
      rerender({ key: 1 });
    });
    await waitFor(() => expect(result.current.pendingCount).toBe(0));

    // Condition recurs.
    spy.mockResolvedValueOnce({
      pendingCount: 1,
      tier2: [{ key: 'aging:intent-1', type: 'aging', message: 'stale' }],
    });
    act(() => {
      rerender({ key: 2 });
    });

    await waitFor(() =>
      expect(result.current.lastTier2Batch?.receivedAt).not.toBe(
        firstReceivedAt,
      ),
    );
    expect(result.current.lastTier2Batch?.events).toHaveLength(1);
  });
});
