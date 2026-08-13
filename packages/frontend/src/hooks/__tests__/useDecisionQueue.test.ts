import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useDecisionQueue } from '../useDecisionQueue';
import { stagedIntentsApi } from '../../api/stagedIntents';
import { publishStagedIntentChange } from '../stagedIntentBus';
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

  it('milestone scope does not admit a broadcast intent from a different project sharing the same milestone label', async () => {
    // Milestone short ids are NOT unique across projects — M14 can be live
    // in claude-dashboard and polimarket simultaneously. The panel is
    // scoped on (projectId, milestone) together, matching the REST fetch.
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([]);

    const { result } = renderHook(() =>
      useDecisionQueue({
        type: 'milestone',
        projectId: 'claude-dashboard',
        milestone: 'M14',
      }),
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));

    const otherProjectIntent: StagedIntent = {
      id: 'i-polimarket',
      kind: 'task.updateBody',
      payload: {},
      projectId: 'polimarket',
      createdAt: 0,
      sessionId: 'session-x',
      milestone: 'M14',
      state: 'staged',
      sessionComplete: true,
    };
    const sameProjectIntent: StagedIntent = {
      id: 'i-claude-dashboard',
      kind: 'task.updateBody',
      payload: {},
      projectId: 'claude-dashboard',
      createdAt: 1,
      sessionId: 'session-y',
      milestone: 'M14',
      state: 'staged',
      sessionComplete: true,
    };

    act(() => {
      publishStagedIntentChange(otherProjectIntent);
      publishStagedIntentChange(sameProjectIntent);
    });

    await waitFor(() =>
      expect(result.current.intents.map((i) => i.id)).toEqual([
        'i-claude-dashboard',
      ]),
    );
  });

  it('milestone scope places a live-arriving intent at the top of its rank tier, not at the end', async () => {
    const older: StagedIntent = {
      id: 'older',
      kind: 'gate.verify',
      payload: {},
      projectId: 'proj-1',
      createdAt: 1,
      sessionId: 'session-a',
      milestone: 'M1',
      state: 'staged',
      sessionComplete: true,
    };
    const newer: StagedIntent = {
      id: 'newer',
      kind: 'gate.verify',
      payload: {},
      projectId: 'proj-1',
      createdAt: 2,
      sessionId: 'session-b',
      milestone: 'M1',
      state: 'staged',
      sessionComplete: true,
    };
    // Backend now returns ties newest-first.
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([
      newer,
      older,
    ]);

    const { result } = renderHook(() =>
      useDecisionQueue({
        type: 'milestone',
        projectId: 'proj-1',
        milestone: 'M1',
      }),
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));

    const liveArrival: StagedIntent = {
      id: 'live-arrival',
      kind: 'gate.verify',
      payload: {},
      projectId: 'proj-1',
      createdAt: 3,
      sessionId: 'session-c',
      milestone: 'M1',
      state: 'staged',
      sessionComplete: true,
    };

    act(() => {
      publishStagedIntentChange(liveArrival);
    });

    await waitFor(() =>
      expect(result.current.intents.map((i) => i.id)).toEqual([
        'live-arrival',
        'newer',
        'older',
      ]),
    );
  });

  it('the order rendered immediately after a live arrival matches the order a refetch would return, for a tied tier', async () => {
    const a: StagedIntent = {
      id: 'a',
      kind: 'gate.verify',
      payload: {},
      projectId: 'proj-1',
      createdAt: 1,
      milestone: 'M1',
      state: 'staged',
      sessionComplete: true,
    };
    const b: StagedIntent = {
      id: 'b',
      kind: 'gate.verify',
      payload: {},
      projectId: 'proj-1',
      createdAt: 2,
      milestone: 'M1',
      state: 'staged',
      sessionComplete: true,
    };
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([b, a]);

    const { result } = renderHook(() =>
      useDecisionQueue({
        type: 'milestone',
        projectId: 'proj-1',
        milestone: 'M1',
      }),
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));

    const c: StagedIntent = {
      id: 'c',
      kind: 'gate.verify',
      payload: {},
      projectId: 'proj-1',
      createdAt: 3,
      milestone: 'M1',
      state: 'staged',
      sessionComplete: true,
    };
    act(() => {
      publishStagedIntentChange(c);
    });
    await waitFor(() =>
      expect(result.current.intents.map((i) => i.id)).toEqual(['c', 'b', 'a']),
    );

    // A refetch (e.g. next mount) with the backend's newest-first tie order
    // for the same underlying data must render identically to the live path.
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([c, b, a]);
    const { result: refetched } = renderHook(() =>
      useDecisionQueue({
        type: 'milestone',
        projectId: 'proj-1',
        milestone: 'M1',
      }),
    );
    await waitFor(() => expect(refetched.current.loaded).toBe(true));
    expect(refetched.current.intents.map((i) => i.id)).toEqual(
      result.current.intents.map((i) => i.id),
    );
  });

  it('session scope live-updates sort newest-first, consistent with milestone scope', async () => {
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([]);

    const { result } = renderHook(() =>
      useDecisionQueue({ type: 'session', sessionId: 'session-1' }),
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));

    const older: StagedIntent = {
      id: 'older',
      kind: 'task.updateBody',
      payload: {},
      projectId: 'proj-1',
      createdAt: 1,
      sessionId: 'session-1',
      state: 'staged',
    };
    const newer: StagedIntent = {
      id: 'newer',
      kind: 'task.updateBody',
      payload: {},
      projectId: 'proj-1',
      createdAt: 2,
      sessionId: 'session-1',
      state: 'staged',
    };

    act(() => {
      publishStagedIntentChange(older);
      publishStagedIntentChange(newer);
    });

    await waitFor(() =>
      expect(result.current.intents.map((i) => i.id)).toEqual([
        'newer',
        'older',
      ]),
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

  it("milestone scope reveals a newly-completed session's intent via a re-broadcast staged_intent_changed, inserted at the top of its (tied) rank tier", async () => {
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

    // The backend re-broadcasts staged_intent_changed for each of a
    // session's still-active intents once its turn ends — the same live
    // channel every other disposition rides, recomputed through
    // isSessionComplete/rowToApi rather than a separate signal.
    act(() => {
      publishStagedIntentChange({
        ...intents[1],
        sessionComplete: true,
      });
    });

    await waitFor(() =>
      expect(result.current.intents.map((i) => i.id)).toEqual([
        'reveals-later',
        'already-visible',
      ]),
    );
  });

  it('a freshly-rendered group reject draft defaults to pushback when the group has no blocked members', async () => {
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([]);

    const { result } = renderHook(() =>
      useDecisionQueue({ type: 'session', sessionId: 'session-1' }),
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));

    expect(result.current.draftFor('group-1')).toEqual({
      outcome: 'pushback',
      reason: '',
    });
  });

  it('a freshly-rendered group reject draft defaults to decline when the group has a blocked member', async () => {
    const blocked: StagedIntent = {
      id: 'i-blocked',
      kind: 'gate.accrete',
      payload: {},
      projectId: 'proj-1',
      createdAt: 0,
      sessionId: 'session-1',
      groupId: 'group-1',
      state: 'needs_revision',
    };
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([blocked]);

    const { result } = renderHook(() =>
      useDecisionQueue({ type: 'session', sessionId: 'session-1' }),
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));

    expect(result.current.draftFor('group-1')).toEqual({
      outcome: 'decline',
      reason: '',
    });
  });

  it('rejects a group using the resolved default outcome once only a reason is entered', async () => {
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([]);
    const rejectGroup = vi
      .spyOn(stagedIntentsApi, 'rejectGroup')
      .mockResolvedValue({ ok: true, rejected: [] });

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

    expect(rejectGroup).toHaveBeenCalledWith('group-1', {
      outcome: 'pushback',
      reason: 'No need',
    });
  });

  it('refuses to reject a group with an empty reason, even once the outcome has resolved', async () => {
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([]);
    const rejectGroup = vi.spyOn(stagedIntentsApi, 'rejectGroup');

    const { result } = renderHook(() =>
      useDecisionQueue({ type: 'session', sessionId: 'session-1' }),
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));

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

  it('recovers a group by re-rendering from the recovered intents the route returns', async () => {
    const blocked: StagedIntent = {
      id: 'i-blocked',
      kind: 'gate.accrete',
      payload: {},
      projectId: 'proj-1',
      createdAt: 0,
      sessionId: 'session-1',
      groupId: 'group-1',
      state: 'needs_revision',
    };
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([blocked]);
    const recovered: StagedIntent = { ...blocked, state: 'staged' };
    const recoverGroup = vi
      .spyOn(stagedIntentsApi, 'recoverGroup')
      .mockResolvedValue({ ok: true, recovered: [recovered] });

    const { result } = renderHook(() =>
      useDecisionQueue({ type: 'session', sessionId: 'session-1' }),
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));

    await act(async () => {
      await result.current.handleRecoverGroup('group-1');
    });

    expect(recoverGroup).toHaveBeenCalledWith('group-1');
    expect(
      result.current.intents.find((i) => i.id === 'i-blocked')?.state,
    ).toBe('staged');
  });

  it('surfaces a recover failure as a group error', async () => {
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([]);
    vi.spyOn(stagedIntentsApi, 'recoverGroup').mockRejectedValue(
      new Error('no blocked members'),
    );

    const { result } = renderHook(() =>
      useDecisionQueue({ type: 'session', sessionId: 'session-1' }),
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));

    await act(async () => {
      await result.current.handleRecoverGroup('group-1');
    });

    expect(result.current.groupErrors['group-1']).toBe('no blocked members');
  });
});
