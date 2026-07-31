import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { mockDbQueries } from '../../__tests__/helpers/mockDbQueries';

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../db/queries', () =>
  mockDbQueries({
    getSession: vi.fn(),
    listStagedIntentsByGroup: vi.fn().mockReturnValue([]),
    listStagedIntentsBySession: vi.fn().mockReturnValue([]),
    markSessionDone: vi.fn(),
    setPendingApproveTerminal: vi.fn(),
    clearPendingApproveTerminal: vi.fn(),
    getSessionsWithPendingApproveTerminal: vi.fn().mockReturnValue([]),
  }),
);

vi.mock('../../routes/stagedIntents', () => ({
  verifyDispatchedGroupsForSession: vi.fn().mockResolvedValue([]),
  sessionOwesGatedDesignArtifacts: vi.fn().mockReturnValue(false),
}));

import {
  getSession,
  listStagedIntentsByGroup,
  listStagedIntentsBySession,
  markSessionDone,
  setPendingApproveTerminal,
  clearPendingApproveTerminal,
  getSessionsWithPendingApproveTerminal,
} from '../../db/queries';
import {
  verifyDispatchedGroupsForSession,
  sessionOwesGatedDesignArtifacts,
} from '../../routes/stagedIntents';
import { PlanningOrchestrator } from '../PlanningOrchestrator';
import type { StagedIntentRow } from '../../db/types';

/** Flushes the microtask queue past the `await` in onSessionParked. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A fake live AgentSession, as returned by SessionManager.getLiveSession. */
function makeLiveSession(hasActiveTurn: boolean) {
  return { hasActiveTurn: () => hasActiveTurn };
}

function makeSessionManager() {
  const sm = new EventEmitter();
  return Object.assign(sm, {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn(),
    getLiveSession: vi.fn().mockReturnValue(undefined),
  });
}

function makeSessionRow(
  overrides: Partial<{
    session_id: string;
    session_type: string;
    status: string;
  }> = {},
) {
  return {
    session_id: 'planning-session-1',
    session_type: 'design',
    status: 'idle',
    ...overrides,
  } as any;
}

function makeIntent(overrides: Partial<StagedIntentRow> = {}): StagedIntentRow {
  return {
    id: 'intent-1',
    kind: 'task.setStatus',
    payload: '{}',
    payload_hash: 'hash',
    task_id: 'task-1',
    project_id: 'project-1',
    session_id: 'planning-session-1',
    group_id: null,
    state: 'committed',
    supersedes: null,
    annotation: null,
    decision_proposal: null,
    advisory: null,
    disposition_reason: null,
    answer: null,
    created_at: 1,
    updated_at: 2,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
  vi.mocked(listStagedIntentsByGroup).mockReturnValue([]);
  vi.mocked(verifyDispatchedGroupsForSession).mockResolvedValue([]);
  vi.mocked(getSessionsWithPendingApproveTerminal).mockReturnValue([]);
  vi.mocked(sessionOwesGatedDesignArtifacts).mockReturnValue(false);
});

// ── handleDisposition — resumes the correct originating session ────────────

describe('PlanningOrchestrator.handleDisposition', () => {
  it('an approve that completes the mandate drives the session terminal without resuming, even while the session row still reads status=running (its normal resting state while parked alive)', async () => {
    const sm = makeSessionManager();
    // No live session in the map at all (getLiveSession -> undefined) is the
    // common case for a session that parks by exiting; DB status='running'
    // here specifically proves the predicate is not session.status.
    vi.mocked(getSession).mockReturnValue(
      makeSessionRow({ status: 'running' }),
    );
    vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
    const orch = new PlanningOrchestrator(sm as any);

    const intent = makeIntent({
      session_id: 'planning-session-1',
      state: 'committed',
    });
    await orch.handleDisposition({ intent, disposition: 'approve' });

    expect(sm.enqueueFeedback).not.toHaveBeenCalled();
    // hasActiveTurn() (via getLiveSession) has already confirmed no turn is
    // in flight, so markSessionDone must be called with skipInFlightGuard —
    // otherwise its own in-flight guard would silently defer this write
    // forever, since the DB row still reads 'running'.
    expect(markSessionDone).toHaveBeenCalledWith(
      'planning-session-1',
      expect.any(Number),
      null,
      expect.any(String),
      { skipInFlightGuard: true },
    );
    // Must go through markTerminal (which calls endSession to reap the
    // subprocess), not write done via some other path.
    expect(sm.endSession).toHaveBeenCalledWith('planning-session-1');
  });

  it('an approve completing a session that staged everything in its first turn (unseeded stagedCountAtResume) still terminates with zero feedback', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const orch = new PlanningOrchestrator(sm as any);

    // No prior disposition has ever run for this session, so
    // stagedCountAtResume was never seeded — the old checkTerminal-based
    // approve path would have misread this as "staged something new" and
    // resumed. All five intents from the session's single clean turn are
    // already committed/non-staged.
    const group = Array.from({ length: 5 }, (_, i) =>
      makeIntent({
        id: `intent-${i}`,
        group_id: 'group-1',
        state: 'committed',
      }),
    );
    vi.mocked(listStagedIntentsByGroup).mockReturnValue(group);
    vi.mocked(listStagedIntentsBySession).mockReturnValue(group);

    await orch.handleDisposition({
      intent: group[0],
      disposition: 'approve',
    });

    expect(sm.enqueueFeedback).not.toHaveBeenCalled();
    expect(markSessionDone).toHaveBeenCalledWith(
      'planning-session-1',
      expect.any(Number),
      null,
      expect.any(String),
      { skipInFlightGuard: true },
    );
    expect(sm.endSession).toHaveBeenCalledWith('planning-session-1');
  });

  it('an approve of one group while another group for the same session still has staged intents produces no feedback and no termination — session stays parked', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({ id: 'other-intent', state: 'staged' }),
    ]);
    const orch = new PlanningOrchestrator(sm as any);

    const intent = makeIntent({
      session_id: 'planning-session-1',
      state: 'committed',
    });
    await orch.handleDisposition({ intent, disposition: 'approve' });

    expect(sm.enqueueFeedback).not.toHaveBeenCalled();
    expect(markSessionDone).not.toHaveBeenCalled();
    expect(sm.endSession).not.toHaveBeenCalled();
  });

  it('does not resume when the intent is still part of a not-fully-disposed group', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const orch = new PlanningOrchestrator(sm as any);

    const intent = makeIntent({
      session_id: 'planning-session-1',
      state: 'committed',
      group_id: 'group-1',
    });
    vi.mocked(listStagedIntentsByGroup).mockReturnValue([
      intent,
      makeIntent({ id: 'sibling', group_id: 'group-1', state: 'approved' }),
    ]);
    await orch.handleDisposition({ intent, disposition: 'approve' });

    expect(sm.enqueueFeedback).not.toHaveBeenCalled();
    expect(markSessionDone).not.toHaveBeenCalled();
  });

  it('regression guard: an approve that completes the mandate while the session has a genuinely live in-flight turn (hasActiveTurn() true) defers the terminal transition instead of marking it terminal underneath the turn', async () => {
    const sm = makeSessionManager();
    // DB status is 'idle' here deliberately — proves the defer decision is
    // driven by hasActiveTurn(), not session.status==='running'.
    vi.mocked(getSession).mockReturnValue(makeSessionRow({ status: 'idle' }));
    vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
    sm.getLiveSession.mockReturnValue(makeLiveSession(true));
    const orch = new PlanningOrchestrator(sm as any);

    const intent = makeIntent({
      session_id: 'planning-session-1',
      state: 'committed',
    });
    await orch.handleDisposition({ intent, disposition: 'approve' });

    expect(sm.enqueueFeedback).not.toHaveBeenCalled();
    expect(markSessionDone).not.toHaveBeenCalled();
    expect(sm.endSession).not.toHaveBeenCalled();
    expect(setPendingApproveTerminal).toHaveBeenCalledWith(
      'planning-session-1',
      expect.any(Number),
    );
  });

  it('does not read session.status === "running" to decide whether a turn is in flight — a running-status row with no active turn terminates immediately', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(
      makeSessionRow({ status: 'running' }),
    );
    vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
    // Live in the map, but its turn already ended.
    sm.getLiveSession.mockReturnValue(makeLiveSession(false));
    const orch = new PlanningOrchestrator(sm as any);

    const intent = makeIntent({
      session_id: 'planning-session-1',
      state: 'committed',
    });
    await orch.handleDisposition({ intent, disposition: 'approve' });

    expect(markSessionDone).toHaveBeenCalledWith(
      'planning-session-1',
      expect.any(Number),
      null,
      expect.any(String),
      { skipInFlightGuard: true },
    );
    expect(setPendingApproveTerminal).not.toHaveBeenCalled();
  });

  it('applies the deferred terminal transition off the turn-boundary result event, without the session process exiting', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow({ status: 'idle' }));
    vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
    const liveSession = makeLiveSession(true);
    sm.getLiveSession.mockReturnValue(liveSession);
    const orch = new PlanningOrchestrator(sm as any);

    const intent = makeIntent({
      session_id: 'planning-session-1',
      state: 'committed',
    });
    await orch.handleDisposition({ intent, disposition: 'approve' });
    expect(markSessionDone).not.toHaveBeenCalled();

    // The turn ends: hasActiveTurn() flips false and the CLI broadcasts a
    // session_event(result) — the session parks alive, no session_ended.
    (liveSession as any).hasActiveTurn = () => false;
    // DB status stays 'running' — the normal resting state for a session
    // that parks alive rather than exiting.
    sm.emit('message', {
      type: 'session_event',
      sessionId: 'planning-session-1',
      eventType: 'result',
      content: '{}',
    });
    await flush();

    expect(markSessionDone).toHaveBeenCalledWith(
      'planning-session-1',
      expect.any(Number),
      null,
      expect.stringContaining('approved'),
      { skipInFlightGuard: true },
    );
    expect(sm.endSession).toHaveBeenCalledWith('planning-session-1');
    expect(clearPendingApproveTerminal).toHaveBeenCalledWith(
      'planning-session-1',
    );
    // Deferred terminal is a one-shot — a second, unrelated result event
    // for the same id must not re-drive markSessionDone.
    vi.mocked(markSessionDone).mockClear();
    sm.emit('message', {
      type: 'session_event',
      sessionId: 'planning-session-1',
      eventType: 'result',
      content: '{}',
    });
    await flush();
    expect(markSessionDone).not.toHaveBeenCalled();
  });

  it('does not mark terminal when the deferred approve-terminal drains but new intents were staged during the deferral window', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow({ status: 'idle' }));
    vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
    const liveSession = makeLiveSession(true);
    sm.getLiveSession.mockReturnValue(liveSession);
    const orch = new PlanningOrchestrator(sm as any);

    const intent = makeIntent({
      session_id: 'planning-session-1',
      state: 'committed',
    });
    await orch.handleDisposition({ intent, disposition: 'approve' });
    expect(markSessionDone).not.toHaveBeenCalled();

    // While the turn was still in flight, the session staged new intents —
    // the deferral window is exactly the interval in which this can happen.
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({ id: 'new-intent-1', state: 'staged' }),
      makeIntent({ id: 'new-intent-2', state: 'staged' }),
    ]);
    (liveSession as any).hasActiveTurn = () => false;
    sm.emit('message', {
      type: 'session_event',
      sessionId: 'planning-session-1',
      eventType: 'result',
      content: '{}',
    });
    await flush();

    expect(markSessionDone).not.toHaveBeenCalled();
    expect(sm.endSession).not.toHaveBeenCalled();
    // The stale deferred marker is still cleared — it has been drained,
    // whether or not it ultimately went terminal.
    expect(clearPendingApproveTerminal).toHaveBeenCalledWith(
      'planning-session-1',
    );
  });

  it('once the newly staged intents are dispositioned, the session still reaches terminal — the drain re-check does not make it immortal', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow({ status: 'idle' }));
    vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
    const liveSession = makeLiveSession(true);
    sm.getLiveSession.mockReturnValue(liveSession);
    const orch = new PlanningOrchestrator(sm as any);

    const intent = makeIntent({
      session_id: 'planning-session-1',
      state: 'committed',
    });
    await orch.handleDisposition({ intent, disposition: 'approve' });

    const newIntent = makeIntent({ id: 'new-intent-1', state: 'staged' });
    vi.mocked(listStagedIntentsBySession).mockReturnValue([newIntent]);
    (liveSession as any).hasActiveTurn = () => false;
    sm.emit('message', {
      type: 'session_event',
      sessionId: 'planning-session-1',
      eventType: 'result',
      content: '{}',
    });
    await flush();
    expect(markSessionDone).not.toHaveBeenCalled();

    // checkTerminal now sees the new intent still staged: not terminal, and
    // it seeds the staged-count snapshot to 1.
    expect(orch.checkTerminal('planning-session-1')).toBe(false);

    // The operator dispositions it (settles to 'committed'); nothing staged
    // remains and the resumed turn (this same call) staged nothing new
    // (count still 1 <= snapshot of 1), so the normal checkTerminal path
    // drives the session terminal exactly as it would without the drain
    // ever having deferred anything.
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      { ...newIntent, state: 'committed' },
    ]);
    expect(orch.checkTerminal('planning-session-1')).toBe(true);
    expect(markSessionDone).toHaveBeenCalledWith(
      'planning-session-1',
      expect.any(Number),
      null,
      expect.any(String),
    );
  });

  it('also applies a deferred terminal transition on session_ended, as a safety net for a session that does exit', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow({ status: 'idle' }));
    vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
    sm.getLiveSession.mockReturnValue(makeLiveSession(true));
    const orch = new PlanningOrchestrator(sm as any);

    const intent = makeIntent({
      session_id: 'planning-session-1',
      state: 'committed',
    });
    await orch.handleDisposition({ intent, disposition: 'approve' });
    expect(markSessionDone).not.toHaveBeenCalled();

    sm.getLiveSession.mockReturnValue(undefined);
    vi.mocked(getSession).mockReturnValue(makeSessionRow({ status: 'idle' }));
    sm.emit('message', {
      type: 'session_ended',
      sessionId: 'planning-session-1',
      status: 'idle',
    });
    await flush();

    expect(markSessionDone).toHaveBeenCalledWith(
      'planning-session-1',
      expect.any(Number),
      null,
      expect.stringContaining('approved'),
      { skipInFlightGuard: true },
    );
    expect(sm.endSession).toHaveBeenCalledWith('planning-session-1');
  });

  it('resumes with a pushback message including operator feedback', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const orch = new PlanningOrchestrator(sm as any);

    const intent = makeIntent({
      session_id: 'planning-session-1',
      state: 'rejected',
    });
    await orch.handleDisposition({
      intent,
      disposition: 'pushback',
      reason: 'please reconsider the split',
    });

    expect(sm.enqueueFeedback).toHaveBeenCalledWith(
      'planning-session-1',
      'operator-disposition',
      expect.stringContaining('please reconsider the split'),
    );
  });

  it('resumes with a decline message carrying the reason, distinct from pushback', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const orch = new PlanningOrchestrator(sm as any);

    const intent = makeIntent({
      session_id: 'planning-session-1',
      state: 'rejected',
    });
    await orch.handleDisposition({
      intent,
      disposition: 'decline',
      reason: 'no longer needed',
    });

    expect(sm.enqueueFeedback).toHaveBeenCalledWith(
      'planning-session-1',
      'operator-disposition',
      expect.stringContaining('declined'),
    );
    expect(sm.enqueueFeedback).toHaveBeenCalledWith(
      'planning-session-1',
      'operator-disposition',
      expect.stringContaining('no longer needed'),
    );
  });

  it('does not resume a different session than the intent originated from', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockImplementation((id: string) =>
      makeSessionRow({ session_id: id }),
    );
    const orch = new PlanningOrchestrator(sm as any);

    const intent = makeIntent({ session_id: 'other-session-42' });
    await orch.handleDisposition({
      intent,
      disposition: 'pushback',
      reason: 'revise',
    });

    expect(sm.enqueueFeedback).toHaveBeenCalledWith(
      'other-session-42',
      'operator-disposition',
      expect.any(String),
    );
    expect(sm.enqueueFeedback).not.toHaveBeenCalledWith(
      'planning-session-1',
      expect.anything(),
      expect.anything(),
    );
  });

  it('no-ops when the intent has no originating session', async () => {
    const sm = makeSessionManager();
    const orch = new PlanningOrchestrator(sm as any);

    const intent = makeIntent({ session_id: null });
    await orch.handleDisposition({ intent, disposition: 'approve' });

    expect(sm.enqueueFeedback).not.toHaveBeenCalled();
  });

  it('no-ops when the originating session is not a planning session', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(
      makeSessionRow({ session_type: 'standard' }),
    );
    const orch = new PlanningOrchestrator(sm as any);

    const intent = makeIntent();
    await orch.handleDisposition({ intent, disposition: 'approve' });

    expect(sm.enqueueFeedback).not.toHaveBeenCalled();
  });

  it('an approve that completes the mandate but still owes gated design artifacts (completeness.disposition approved, no arch.*/task.updateBody staged yet) resumes the session instead of terminating it', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
    vi.mocked(sessionOwesGatedDesignArtifacts).mockReturnValue(true);
    const orch = new PlanningOrchestrator(sm as any);

    const intent = makeIntent({
      kind: 'completeness.disposition',
      session_id: 'planning-session-1',
      state: 'committed',
    });
    await orch.handleDisposition({ intent, disposition: 'approve' });

    expect(sm.enqueueFeedback).toHaveBeenCalledWith(
      'planning-session-1',
      'operator-disposition',
      expect.stringContaining('arch.createUnit'),
    );
    expect(markSessionDone).not.toHaveBeenCalled();
    expect(sm.endSession).not.toHaveBeenCalled();
  });

  it('an approve that completes the mandate and owes nothing further (sessionOwesGatedDesignArtifacts false, the default for non-design/groom sessions) still terminates exactly as before', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
    const orch = new PlanningOrchestrator(sm as any);

    const intent = makeIntent({ session_id: 'planning-session-1' });
    await orch.handleDisposition({ intent, disposition: 'approve' });

    expect(sm.enqueueFeedback).not.toHaveBeenCalled();
    expect(markSessionDone).toHaveBeenCalledWith(
      'planning-session-1',
      expect.any(Number),
      null,
      expect.any(String),
      { skipInFlightGuard: true },
    );
    expect(sm.endSession).toHaveBeenCalledWith('planning-session-1');
  });
});

// ── handleGroupDisposition — coalesces a group reject into one message ──────

describe('PlanningOrchestrator.handleGroupDisposition', () => {
  it('delivers exactly one message for a group of 4 rejected intents', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const orch = new PlanningOrchestrator(sm as any);

    const intents = [
      makeIntent({ id: 'intent-1', kind: 'task.setDependsOn' }),
      makeIntent({ id: 'intent-2', kind: 'task.updateBody' }),
      makeIntent({ id: 'intent-3', kind: 'task.setStatus' }),
      makeIntent({ id: 'intent-4', kind: 'task.setProperties' }),
    ];

    await orch.handleGroupDisposition({
      intents,
      disposition: 'pushback',
      reason: 'revise the whole group',
      groupId: 'group-1',
    });

    expect(sm.enqueueFeedback).toHaveBeenCalledTimes(1);
    expect(sm.enqueueFeedback).toHaveBeenCalledWith(
      'planning-session-1',
      'operator-disposition',
      expect.any(String),
    );
  });

  it('delivers exactly one message for a single-item group (no regression)', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const orch = new PlanningOrchestrator(sm as any);

    await orch.handleGroupDisposition({
      intents: [makeIntent({ id: 'intent-1' })],
      disposition: 'decline',
      reason: 'not needed',
      groupId: 'group-solo',
    });

    expect(sm.enqueueFeedback).toHaveBeenCalledTimes(1);
  });

  it('carries the operator reason and identifies the rejected group', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const orch = new PlanningOrchestrator(sm as any);

    const intents = [
      makeIntent({ id: 'intent-1', kind: 'task.setDependsOn' }),
      makeIntent({ id: 'intent-2', kind: 'task.setStatus' }),
    ];

    await orch.handleGroupDisposition({
      intents,
      disposition: 'pushback',
      reason: 'please reconsider the split',
      groupId: 'group-42',
    });

    expect(sm.enqueueFeedback).toHaveBeenCalledWith(
      'planning-session-1',
      'operator-disposition',
      expect.stringContaining('please reconsider the split'),
    );
    expect(sm.enqueueFeedback).toHaveBeenCalledWith(
      'planning-session-1',
      'operator-disposition',
      expect.stringContaining('group-42'),
    );
    const [, , message] = sm.enqueueFeedback.mock.calls[0];
    expect(message).toContain('intent-1');
    expect(message).toContain('intent-2');
  });

  it('cannot route an approve disposition into a resume, even if forced past the type check', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const orch = new PlanningOrchestrator(sm as any);

    const intent = makeIntent({
      id: 'intent-1',
      session_id: 'planning-session-1',
      state: 'committed',
    });
    vi.mocked(listStagedIntentsBySession).mockReturnValue([]);

    await orch.handleGroupDisposition({
      intents: [intent],
      disposition: 'approve' as any,
      reason: null,
      groupId: 'group-1',
    });

    expect(sm.enqueueFeedback).not.toHaveBeenCalled();
    expect(markSessionDone).toHaveBeenCalledWith(
      'planning-session-1',
      expect.any(Number),
      null,
      expect.any(String),
      { skipInFlightGuard: true },
    );
    expect(sm.endSession).toHaveBeenCalledWith('planning-session-1');
  });

  it('no-ops when none of the intents originate from a planning session', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(
      makeSessionRow({ session_type: 'standard' }),
    );
    const orch = new PlanningOrchestrator(sm as any);

    await orch.handleGroupDisposition({
      intents: [makeIntent({ id: 'intent-1' })],
      disposition: 'decline',
      reason: 'no longer needed',
      groupId: 'group-x',
    });

    expect(sm.enqueueFeedback).not.toHaveBeenCalled();
  });
});

// ── checkTerminal / session-parked terminal detection ───────────────────────

describe('PlanningOrchestrator terminal detection', () => {
  it('marks terminal when no un-dispositioned intents remain and the turn staged nothing new', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const orch = new PlanningOrchestrator(sm as any);

    // A disposition resumes the session — snapshot count is 1 (the just-dispositioned intent).
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({ state: 'committed' }),
    ]);
    await orch.handleDisposition({
      intent: makeIntent({ state: 'rejected' }),
      disposition: 'pushback',
      reason: 'revise',
    });

    // The resumed turn stages nothing new and leaves no 'staged' intents.
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({ state: 'committed' }),
    ]);
    const terminal = orch.checkTerminal('planning-session-1');

    expect(terminal).toBe(true);
    expect(markSessionDone).toHaveBeenCalledWith(
      'planning-session-1',
      expect.any(Number),
      null,
      expect.any(String),
    );
  });

  it('is not terminal while an un-dispositioned (staged) intent remains', () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const orch = new PlanningOrchestrator(sm as any);

    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({ state: 'staged' }),
    ]);

    const terminal = orch.checkTerminal('planning-session-1');

    expect(terminal).toBe(false);
    expect(markSessionDone).not.toHaveBeenCalled();
  });

  it('is not terminal when no un-dispositioned intents remain and the turn staged nothing new, but the session still owes gated design artifacts', () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(sessionOwesGatedDesignArtifacts).mockReturnValue(true);
    const orch = new PlanningOrchestrator(sm as any);

    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({ kind: 'completeness.disposition', state: 'committed' }),
    ]);

    const terminal = orch.checkTerminal('planning-session-1');

    expect(terminal).toBe(false);
    expect(markSessionDone).not.toHaveBeenCalled();
  });

  it('is not terminal when the resumed turn staged a new intent', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const orch = new PlanningOrchestrator(sm as any);

    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({ id: 'intent-1', state: 'committed' }),
    ]);
    await orch.handleDisposition({
      intent: makeIntent({ id: 'intent-1', state: 'rejected' }),
      disposition: 'pushback',
      reason: 'revise',
    });

    // The next turn stages a brand-new intent — count grew since resume.
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({ id: 'intent-1', state: 'committed' }),
      makeIntent({ id: 'intent-2', state: 'staged' }),
    ]);

    const terminal = orch.checkTerminal('planning-session-1');

    expect(terminal).toBe(false);
    expect(markSessionDone).not.toHaveBeenCalled();
  });

  it('still ends the subprocess when the row already reached done via another writer, instead of returning early without reaping', () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow({ status: 'done' }));
    const orch = new PlanningOrchestrator(sm as any);

    // A committed decision-kind intent so the no-staged-decision backstop
    // doesn't intercept this call with a self-correct nudge — this test is
    // about the already-done reap path, not that backstop.
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({ state: 'committed' }),
    ]);
    orch.checkTerminal('planning-session-1'); // prime the staged-count snapshot
    const terminal = orch.checkTerminal('planning-session-1');

    expect(terminal).toBe(true);
    expect(sm.endSession).toHaveBeenCalledWith('planning-session-1');
    // Status was already written by the other terminal-status writer — this
    // path must not overwrite it again with its own reason/call_site.
    expect(markSessionDone).not.toHaveBeenCalled();
  });

  it('reaps an already-done session safely on repeated calls (idempotent)', () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow({ status: 'done' }));
    const orch = new PlanningOrchestrator(sm as any);

    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({ state: 'committed' }),
    ]);
    orch.checkTerminal('planning-session-1'); // prime the staged-count snapshot
    expect(() => orch.checkTerminal('planning-session-1')).not.toThrow();
    expect(() => orch.checkTerminal('planning-session-1')).not.toThrow();

    expect(sm.endSession).toHaveBeenCalledTimes(2);
    expect(markSessionDone).not.toHaveBeenCalled();
  });

  it('drives terminal automatically off a session_ended(idle) event for a planning session', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({ state: 'committed' }),
    ]);
    const orch = new PlanningOrchestrator(sm as any);
    orch.checkTerminal('planning-session-1'); // prime the staged-count snapshot

    sm.emit('message', {
      type: 'session_ended',
      sessionId: 'planning-session-1',
      status: 'idle',
    });
    await flush();

    expect(markSessionDone).toHaveBeenCalledWith(
      'planning-session-1',
      expect.any(Number),
      null,
      expect.any(String),
    );
  });

  it('ignores session_ended(idle) for a non-planning session', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(
      makeSessionRow({ session_type: 'standard' }),
    );
    new PlanningOrchestrator(sm as any);

    sm.emit('message', {
      type: 'session_ended',
      sessionId: 'planning-session-1',
      status: 'idle',
    });
    await flush();

    expect(markSessionDone).not.toHaveBeenCalled();
    expect(verifyDispatchedGroupsForSession).not.toHaveBeenCalled();
  });
});

// ── turn-end group verification routing ─────────────────────────────────────

describe('PlanningOrchestrator turn-end group verification', () => {
  it('routes a blocked, non-escalated group verification failure back to the session and skips the terminal check', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(verifyDispatchedGroupsForSession).mockResolvedValue([
      {
        groupId: 'group-1',
        sessionId: 'planning-session-1',
        passed: false,
        escalated: false,
        errors: ['task.setStatus (task-1): Open Questions section unresolved'],
      },
    ]);
    new PlanningOrchestrator(sm as any);

    sm.emit('message', {
      type: 'session_ended',
      sessionId: 'planning-session-1',
      status: 'idle',
    });
    await flush();

    expect(sm.enqueueFeedback).toHaveBeenCalledWith(
      'planning-session-1',
      'verification-error',
      expect.stringContaining('Open Questions section unresolved'),
    );
    expect(markSessionDone).not.toHaveBeenCalled();
  });

  it('does not feed back an escalated group failure, and falls through to the terminal check', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({ state: 'committed' }),
    ]);
    vi.mocked(verifyDispatchedGroupsForSession).mockResolvedValue([
      {
        groupId: 'group-1',
        sessionId: 'planning-session-1',
        passed: false,
        escalated: true,
        errors: ['task.setStatus (task-1): still blocked after 2 rounds'],
      },
    ]);
    const orch = new PlanningOrchestrator(sm as any);
    orch.checkTerminal('planning-session-1'); // prime the staged-count snapshot

    sm.emit('message', {
      type: 'session_ended',
      sessionId: 'planning-session-1',
      status: 'idle',
    });
    await flush();

    expect(sm.enqueueFeedback).not.toHaveBeenCalled();
    expect(markSessionDone).toHaveBeenCalled();
  });

  it('runs the terminal check when verification finds no groups to gate', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({ state: 'staged' }),
    ]);
    vi.mocked(verifyDispatchedGroupsForSession).mockResolvedValue([]);
    new PlanningOrchestrator(sm as any);

    sm.emit('message', {
      type: 'session_ended',
      sessionId: 'planning-session-1',
      status: 'idle',
    });
    await flush();

    expect(sm.enqueueFeedback).not.toHaveBeenCalled();
    expect(markSessionDone).not.toHaveBeenCalled();
  });
});

// ── endSession — explicit operator early terminal ───────────────────────────

describe('PlanningOrchestrator.endSession', () => {
  it('drives an explicit terminal regardless of pending intents', () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({ state: 'staged' }),
    ]);
    const orch = new PlanningOrchestrator(sm as any);

    orch.endSession('planning-session-1');

    expect(markSessionDone).toHaveBeenCalledWith(
      'planning-session-1',
      expect.any(Number),
      null,
      expect.stringContaining('operator_end'),
    );
    // Writing done is not enough on its own — the CLI subprocess must be
    // asked to exit too, or it keeps holding a planning-concurrency slot.
    expect(sm.endSession).toHaveBeenCalledWith('planning-session-1');
  });

  it('still reaps the subprocess for an already-done session, without overwriting its status', () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow({ status: 'done' }));
    const orch = new PlanningOrchestrator(sm as any);

    orch.endSession('planning-session-1');

    // The row already reached done via some other writer — this path must
    // not overwrite it again, but the subprocess still needs to be reaped or
    // it leaks a planning-concurrency slot forever.
    expect(markSessionDone).not.toHaveBeenCalled();
    expect(sm.endSession).toHaveBeenCalledWith('planning-session-1');
  });
});

// ── reconcilePendingApproveTerminals — boot-time backstop ───────────────────

describe('PlanningOrchestrator.reconcilePendingApproveTerminals', () => {
  it('applies every durably-pending approve-terminal transition at boot, since no live process exists yet for any session this early', () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(
      makeSessionRow({ status: 'running' }),
    );
    vi.mocked(getSessionsWithPendingApproveTerminal).mockReturnValue([
      makeSessionRow({ session_id: 'planning-session-1' }),
    ] as any);
    const orch = new PlanningOrchestrator(sm as any);

    orch.reconcilePendingApproveTerminals();

    expect(clearPendingApproveTerminal).toHaveBeenCalledWith(
      'planning-session-1',
    );
    expect(markSessionDone).toHaveBeenCalledWith(
      'planning-session-1',
      expect.any(Number),
      null,
      expect.stringContaining('approved'),
      { skipInFlightGuard: true },
    );
    expect(sm.endSession).toHaveBeenCalledWith('planning-session-1');
  });

  it('is a no-op when nothing is durably pending', () => {
    const sm = makeSessionManager();
    vi.mocked(getSessionsWithPendingApproveTerminal).mockReturnValue([]);
    const orch = new PlanningOrchestrator(sm as any);

    orch.reconcilePendingApproveTerminals();

    expect(clearPendingApproveTerminal).not.toHaveBeenCalled();
    expect(markSessionDone).not.toHaveBeenCalled();
  });

  it('leaves no session behind: a session with neither a live turn nor a live process is applied whether the drain fires in-process or via the boot sweep', async () => {
    // In-process drain path.
    const sm1 = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow({ status: 'idle' }));
    vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
    sm1.getLiveSession.mockReturnValue(makeLiveSession(true));
    const orch1 = new PlanningOrchestrator(sm1 as any);
    await orch1.handleDisposition({
      intent: makeIntent({
        session_id: 'planning-session-1',
        state: 'committed',
      }),
      disposition: 'approve',
    });
    expect(setPendingApproveTerminal).toHaveBeenCalledWith(
      'planning-session-1',
      expect.any(Number),
    );
    sm1.getLiveSession.mockReturnValue(makeLiveSession(false));
    sm1.emit('message', {
      type: 'session_event',
      sessionId: 'planning-session-1',
      eventType: 'result',
      content: '{}',
    });
    await flush();
    expect(clearPendingApproveTerminal).toHaveBeenCalledWith(
      'planning-session-1',
    );

    // Boot-sweep path for a row still carrying the durable marker after a
    // restart (in-memory Set is empty in a fresh process).
    vi.clearAllMocks();
    vi.mocked(getSession).mockReturnValue(
      makeSessionRow({ status: 'running' }),
    );
    vi.mocked(getSessionsWithPendingApproveTerminal).mockReturnValue([
      makeSessionRow({ session_id: 'planning-session-2' }),
    ] as any);
    const sm2 = makeSessionManager();
    const orch2 = new PlanningOrchestrator(sm2 as any);
    orch2.reconcilePendingApproveTerminals();
    expect(clearPendingApproveTerminal).toHaveBeenCalledWith(
      'planning-session-2',
    );
    expect(markSessionDone).toHaveBeenCalledWith(
      'planning-session-2',
      expect.any(Number),
      null,
      expect.stringContaining('approved'),
      { skipInFlightGuard: true },
    );
  });
});
