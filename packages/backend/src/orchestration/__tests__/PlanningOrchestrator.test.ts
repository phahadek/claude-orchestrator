import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../db/queries', () => ({
  getSession: vi.fn(),
  listStagedIntentsBySession: vi.fn().mockReturnValue([]),
  markSessionDone: vi.fn(),
}));

import { getSession, listStagedIntentsBySession, markSessionDone } from '../../db/queries';
import { PlanningOrchestrator } from '../PlanningOrchestrator';
import type { StagedIntentRow } from '../../db/types';

function makeSessionManager() {
  const sm = new EventEmitter();
  return Object.assign(sm, {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
  });
}

function makeSessionRow(overrides: Partial<{ session_id: string; session_type: string; status: string }> = {}) {
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
    created_at: 1,
    updated_at: 2,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
});

// ── handleDisposition — resumes the correct originating session ────────────

describe('PlanningOrchestrator.handleDisposition', () => {
  it('resumes the originating idle planning session with an approve outcome', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const orch = new PlanningOrchestrator(sm as any);

    const intent = makeIntent({ session_id: 'planning-session-1', state: 'committed' });
    await orch.handleDisposition({ intent, disposition: 'approve' });

    expect(sm.enqueueFeedback).toHaveBeenCalledWith(
      'planning-session-1',
      'operator-disposition',
      expect.stringContaining('approved'),
    );
  });

  it('resumes with a pushback message including operator feedback', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const orch = new PlanningOrchestrator(sm as any);

    const intent = makeIntent({ session_id: 'planning-session-1', state: 'rejected' });
    await orch.handleDisposition({
      intent,
      disposition: 'pushback',
      feedback: 'please reconsider the split',
    });

    expect(sm.enqueueFeedback).toHaveBeenCalledWith(
      'planning-session-1',
      'operator-disposition',
      expect.stringContaining('please reconsider the split'),
    );
  });

  it('resumes with a reject message when rejected without feedback', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const orch = new PlanningOrchestrator(sm as any);

    const intent = makeIntent({ session_id: 'planning-session-1', state: 'rejected' });
    await orch.handleDisposition({ intent, disposition: 'reject' });

    expect(sm.enqueueFeedback).toHaveBeenCalledWith(
      'planning-session-1',
      'operator-disposition',
      expect.stringContaining('rejected'),
    );
  });

  it('does not resume a different session than the intent originated from', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockImplementation((id: string) =>
      makeSessionRow({ session_id: id }),
    );
    const orch = new PlanningOrchestrator(sm as any);

    const intent = makeIntent({ session_id: 'other-session-42' });
    await orch.handleDisposition({ intent, disposition: 'approve' });

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

  it('drives terminal automatically off a session_ended(idle) event for a planning session', () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
    new PlanningOrchestrator(sm as any);

    sm.emit('message', {
      type: 'session_ended',
      sessionId: 'planning-session-1',
      status: 'idle',
    });

    expect(markSessionDone).toHaveBeenCalledWith(
      'planning-session-1',
      expect.any(Number),
      null,
      expect.any(String),
    );
  });

  it('ignores session_ended(idle) for a non-planning session', () => {
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
  });

  it('is a no-op for an already-done session', () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow({ status: 'done' }));
    const orch = new PlanningOrchestrator(sm as any);

    orch.endSession('planning-session-1');

    expect(markSessionDone).not.toHaveBeenCalled();
  });
});
