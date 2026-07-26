import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../db/queries', () => ({
  getSession: vi.fn(),
  listStagedIntentsByGroup: vi.fn().mockReturnValue([]),
  listStagedIntentsBySession: vi.fn().mockReturnValue([]),
  markSessionDone: vi.fn(),
}));

vi.mock('../../routes/stagedIntents', () => ({
  verifyDispatchedGroupsForSession: vi.fn().mockResolvedValue([]),
}));

import {
  getSession,
  listStagedIntentsByGroup,
  listStagedIntentsBySession,
  markSessionDone,
} from '../../db/queries';
import { verifyDispatchedGroupsForSession } from '../../routes/stagedIntents';
import { PlanningOrchestrator } from '../PlanningOrchestrator';
import type { StagedIntentRow } from '../../db/types';

/** Flushes the microtask queue past the `await` in onSessionParked. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeSessionManager() {
  const sm = new EventEmitter();
  return Object.assign(sm, {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn(),
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
});

// ── handleDisposition — resumes the correct originating session ────────────

describe('PlanningOrchestrator.handleDisposition', () => {
  it('an approve that completes the mandate drives the session terminal without resuming', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
    const orch = new PlanningOrchestrator(sm as any);

    const intent = makeIntent({
      session_id: 'planning-session-1',
      state: 'committed',
    });
    await orch.handleDisposition({ intent, disposition: 'approve' });

    expect(sm.enqueueFeedback).not.toHaveBeenCalled();
    expect(markSessionDone).toHaveBeenCalledWith(
      'planning-session-1',
      expect.any(Number),
      null,
      expect.any(String),
    );
  });

  it('an approve that leaves other staged work resumes the session exactly once', async () => {
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

    expect(sm.enqueueFeedback).toHaveBeenCalledTimes(1);
    expect(sm.enqueueFeedback).toHaveBeenCalledWith(
      'planning-session-1',
      'operator-disposition',
      expect.stringContaining('approved'),
    );
    expect(markSessionDone).not.toHaveBeenCalled();
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
      intent: makeIntent({ state: 'committed' }),
      disposition: 'approve',
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

  it('is not terminal when the resumed turn staged a new intent', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const orch = new PlanningOrchestrator(sm as any);

    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({ id: 'intent-1', state: 'committed' }),
    ]);
    await orch.handleDisposition({
      intent: makeIntent({ id: 'intent-1', state: 'committed' }),
      disposition: 'approve',
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

  it('drives terminal automatically off a session_ended(idle) event for a planning session', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
    new PlanningOrchestrator(sm as any);

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
    vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
    vi.mocked(verifyDispatchedGroupsForSession).mockResolvedValue([
      {
        groupId: 'group-1',
        sessionId: 'planning-session-1',
        passed: false,
        escalated: true,
        errors: ['task.setStatus (task-1): still blocked after 2 rounds'],
      },
    ]);
    new PlanningOrchestrator(sm as any);

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

  it('is a no-op for an already-done session', () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow({ status: 'done' }));
    const orch = new PlanningOrchestrator(sm as any);

    orch.endSession('planning-session-1');

    expect(markSessionDone).not.toHaveBeenCalled();
    expect(sm.endSession).not.toHaveBeenCalled();
  });
});
