import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useDecisionQueue } from '../useDecisionQueue';
import { stagedIntentsApi } from '../../api/stagedIntents';
import {
  publishStagedIntentChange,
  publishSessionTurnCompleted,
} from '../stagedIntentBus';
import type { StagedIntent } from '../../api/stagedIntents';

describe('useDecisionQueue', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('session scope fetches via listBySession and partitions grouped/ungrouped intents', async () => {
    const intents: StagedIntent[] = [
      {
        id: 'i-1',
        kind: 'task.updateBody',
        payload: {},
        projectId: 'proj-1',
        createdAt: 0,
        sessionId: 'session-1',
        state: 'staged',
      },
      {
        id: 'i-2',
        kind: 'task.setDependsOn',
        payload: { taskId: 't-1', dependsOn: [] },
        projectId: 'proj-1',
        createdAt: 1,
        sessionId: 'session-1',
        groupId: 'group-1',
        state: 'staged',
      },
    ];
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue(intents);

    const { result } = renderHook(() =>
      useDecisionQueue({ type: 'session', sessionId: 'session-1' }),
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));

    expect(stagedIntentsApi.listBySession).toHaveBeenCalledWith('session-1');
    expect(result.current.ungrouped.map((i) => i.id)).toEqual(['i-1']);
    expect(result.current.groupEntries).toHaveLength(1);
    expect(result.current.groupEntries[0][0]).toBe('group-1');
  });

  it('milestone scope fetches via listByMilestone and preserves the backend-ranked order', async () => {
    const intents: StagedIntent[] = [
      {
        id: 'ranked-first',
        kind: 'decision.pickOne',
        payload: {},
        projectId: 'proj-1',
        createdAt: 5,
        sessionId: 'session-a',
        milestone: 'M1',
        state: 'staged',
        sessionComplete: true,
      },
      {
        id: 'ranked-second',
        kind: 'task.updateBody',
        payload: {},
        projectId: 'proj-1',
        createdAt: 1,
        sessionId: 'session-b',
        milestone: 'M1',
        state: 'staged',
        sessionComplete: true,
      },
    ];
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue(intents);

    const { result } = renderHook(() =>
      useDecisionQueue({
        type: 'milestone',
        projectId: 'proj-1',
        milestone: 'M1',
      }),
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));

    expect(stagedIntentsApi.listByMilestone).toHaveBeenCalledWith(
      'proj-1',
      'M1',
    );
    // Not re-sorted by createdAt (which would put ranked-second first) —
    // the backend's convergence-ranking order is trusted as-is.
    expect(result.current.intents.map((i) => i.id)).toEqual([
      'ranked-first',
      'ranked-second',
    ]);
  });

  it('milestone scope live-updates only intents matching the milestone', async () => {
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([]);

    const { result } = renderHook(() =>
      useDecisionQueue({
        type: 'milestone',
        projectId: 'proj-1',
        milestone: 'M1',
      }),
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));

    const otherMilestoneIntent: StagedIntent = {
      id: 'i-other',
      kind: 'task.updateBody',
      payload: {},
      projectId: 'proj-1',
      createdAt: 0,
      sessionId: 'session-x',
      milestone: 'M2',
      state: 'staged',
    };
    const sameMilestoneIntent: StagedIntent = {
      id: 'i-same',
      kind: 'task.updateBody',
      payload: {},
      projectId: 'proj-1',
      createdAt: 0,
      sessionId: 'session-y',
      milestone: 'M1',
      state: 'staged',
      sessionComplete: true,
    };

    act(() => {
      publishStagedIntentChange(otherMilestoneIntent);
      publishStagedIntentChange(sameMilestoneIntent);
    });

    await waitFor(() =>
      expect(result.current.intents.map((i) => i.id)).toEqual(['i-same']),
    );
  });

  it('milestone scope suppresses an intent whose owning session turn is still in flight', async () => {
    const intents: StagedIntent[] = [
      {
        id: 'incomplete',
        kind: 'task.updateBody',
        payload: {},
        projectId: 'proj-1',
        createdAt: 0,
        sessionId: 'session-a',
        milestone: 'M1',
        state: 'staged',
        sessionComplete: false,
      },
      {
        id: 'complete',
        kind: 'task.updateBody',
        payload: {},
        projectId: 'proj-1',
        createdAt: 1,
        sessionId: 'session-b',
        milestone: 'M1',
        state: 'staged',
        sessionComplete: true,
      },
    ];
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue(intents);

    const { result } = renderHook(() =>
      useDecisionQueue({
        type: 'milestone',
        projectId: 'proj-1',
        milestone: 'M1',
      }),
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));

    expect(result.current.intents.map((i) => i.id)).toEqual(['complete']);
  });

  it('milestone scope treats a missing/undefined sessionComplete as not-yet-complete', async () => {
    const intents: StagedIntent[] = [
      {
        id: 'undefined-complete',
        kind: 'task.updateBody',
        payload: {},
        projectId: 'proj-1',
        createdAt: 0,
        sessionId: 'session-a',
        milestone: 'M1',
        state: 'staged',
        // sessionComplete deliberately omitted
      },
    ];
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue(intents);

    const { result } = renderHook(() =>
      useDecisionQueue({
        type: 'milestone',
        projectId: 'proj-1',
        milestone: 'M1',
      }),
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));

    expect(result.current.intents).toEqual([]);
  });

  it('milestone scope reveals a session_turn_completed session\'s intents in place, without reordering', async () => {
    const intents: StagedIntent[] = [
      {
        id: 'already-visible',
        kind: 'task.updateBody',
        payload: {},
        projectId: 'proj-1',
        createdAt: 0,
        sessionId: 'session-a',
        milestone: 'M1',
        state: 'staged',
        sessionComplete: true,
      },
      {
        id: 'reveals-later',
        kind: 'task.updateBody',
        payload: {},
        projectId: 'proj-1',
        createdAt: 1,
        sessionId: 'session-b',
        milestone: 'M1',
        state: 'staged',
        sessionComplete: false,
      },
      {
        id: 'stays-hidden',
        kind: 'task.updateBody',
        payload: {},
        projectId: 'proj-1',
        createdAt: 2,
        sessionId: 'session-c',
        milestone: 'M1',
        state: 'staged',
        sessionComplete: false,
      },
    ];
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue(intents);

    const { result } = renderHook(() =>
      useDecisionQueue({
        type: 'milestone',
        projectId: 'proj-1',
        milestone: 'M1',
      }),
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.intents.map((i) => i.id)).toEqual([
      'already-visible',
    ]);

    act(() => {
      publishSessionTurnCompleted('session-b');
    });

    await waitFor(() =>
      expect(result.current.intents.map((i) => i.id)).toEqual([
        'already-visible',
        'reveals-later',
      ]),
    );
  });

  it('a freshly-rendered group reject draft has no pre-selected outcome', async () => {
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([]);

    const { result } = renderHook(() =>
      useDecisionQueue({ type: 'session', sessionId: 'session-1' }),
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));

    expect(result.current.draftFor('group-1')).toEqual({
      outcome: null,
      reason: '',
    });
  });

  it('refuses to reject a group with no outcome selected, even with a reason typed', async () => {
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([]);
    const rejectGroup = vi.spyOn(stagedIntentsApi, 'rejectGroup');

    const { result } = renderHook(() =>
      useDecisionQueue({ type: 'session', sessionId: 'session-1' }),
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => {
      result.current.setDraft('group-1', { reason: 'No need' });
    });
    await act(async () => {
      await result.current.handleRejectGroup('group-1');
    });

    expect(rejectGroup).not.toHaveBeenCalled();
  });

  it('issues outcome: decline when Decline is explicitly chosen — never inferred', async () => {
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([]);
    const rejectGroup = vi
      .spyOn(stagedIntentsApi, 'rejectGroup')
      .mockResolvedValue({ ok: true, rejected: [] });

    const { result } = renderHook(() =>
      useDecisionQueue({ type: 'session', sessionId: 'session-1' }),
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => {
      result.current.setDraft('group-1', {
        outcome: 'decline',
        reason: 'out of scope',
      });
    });
    await act(async () => {
      await result.current.handleRejectGroup('group-1');
    });

    expect(rejectGroup).toHaveBeenCalledWith('group-1', {
      outcome: 'decline',
      reason: 'out of scope',
    });
  });
});
