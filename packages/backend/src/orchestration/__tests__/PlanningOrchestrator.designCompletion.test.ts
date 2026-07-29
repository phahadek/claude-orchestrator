import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

/**
 * Coverage for the design-completion gap: a design session's natural
 * (not operator-killed) terminal is the orchestrator's only signal to close
 * its target task — see task write-up "Mark a design task Done when its
 * session concludes". A declined/rejected closing intent, or an
 * operator-killed session, must leave the task's status untouched.
 */

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../db/queries', () => ({
  getSession: vi.fn(),
  listStagedIntentsBySession: vi.fn().mockReturnValue([]),
  listStagedIntentsByGroup: vi.fn().mockReturnValue([]),
  markSessionDone: vi.fn(),
  setPendingApproveTerminal: vi.fn(),
  clearPendingApproveTerminal: vi.fn(),
  getSessionsWithPendingApproveTerminal: vi.fn().mockReturnValue([]),
}));

vi.mock('../../routes/stagedIntents', () => ({
  verifyDispatchedGroupsForSession: vi.fn().mockResolvedValue([]),
}));

const updateStatus = vi.fn().mockResolvedValue(undefined);
vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(() => ({ updateStatus })),
}));

vi.mock('../../routes/tasks', () => ({
  emitTaskUpdated: vi.fn(),
}));

import {
  getSession,
  listStagedIntentsBySession,
  markSessionDone,
} from '../../db/queries';
import { getTaskBackend } from '../../tasks/TaskBackend';
import { PlanningOrchestrator } from '../PlanningOrchestrator';
import type { StagedIntentRow } from '../../db/types';

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
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
    task_id: string | null;
    project_id: string | null;
  }> = {},
) {
  return {
    session_id: 'design-session-1',
    session_type: 'design',
    status: 'idle',
    task_id: 'task-1',
    project_id: 'project-1',
    ...overrides,
  } as any;
}

function makeIntent(overrides: Partial<StagedIntentRow> = {}): StagedIntentRow {
  return {
    id: 'intent-1',
    kind: 'task.patchBodySection',
    payload: '{}',
    payload_hash: 'hash',
    task_id: 'task-1',
    project_id: 'project-1',
    session_id: 'design-session-1',
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
  updateStatus.mockResolvedValue(undefined);
  vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
});

describe('PlanningOrchestrator — design task completion', () => {
  it('transitions the target task to Done when a design session reaches terminal with every closing-set intent applied', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({ id: 'intent-1', state: 'committed' }),
      makeIntent({ id: 'intent-2', kind: 'task.create', state: 'committed' }),
    ]);
    const orch = new PlanningOrchestrator(sm as any);

    // First park primes the resume-count snapshot; the second confirms the
    // turn staged nothing new (see checkTerminal's stagedNothingNew comment).
    orch.checkTerminal('design-session-1');
    const terminal = orch.checkTerminal('design-session-1');
    await flush();

    expect(terminal).toBe(true);
    expect(getTaskBackend).toHaveBeenCalledWith('project-1');
    expect(updateStatus).toHaveBeenCalledWith(
      'task-1',
      '✅ Done',
      expect.objectContaining({
        source: 'orchestrator',
        sessionId: 'design-session-1',
      }),
    );
  });

  it('transitions the target task to Done when a design session reaches terminal via planning_approved from handleApproveDisposition (direct path)', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const approveIntent = makeIntent({
      id: 'intent-1',
      state: 'committed',
      group_id: null,
    });
    vi.mocked(listStagedIntentsBySession).mockReturnValue([approveIntent]);
    const orch = new PlanningOrchestrator(sm as any);

    await orch.handleDisposition({
      intent: approveIntent,
      disposition: 'approve',
    });
    await flush();

    expect(markSessionDone).toHaveBeenCalledWith(
      'design-session-1',
      expect.any(Number),
      null,
      'planning_approved',
      expect.objectContaining({ skipInFlightGuard: true }),
    );
    expect(updateStatus).toHaveBeenCalledWith(
      'task-1',
      '✅ Done',
      expect.objectContaining({
        source: 'orchestrator',
        sessionId: 'design-session-1',
      }),
    );
  });

  it('transitions the target task to Done when a design session reaches terminal via planning_approved from the deferred-drain path', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const approveIntent = makeIntent({
      id: 'intent-1',
      state: 'committed',
      group_id: null,
    });
    vi.mocked(listStagedIntentsBySession).mockReturnValue([approveIntent]);
    sm.getLiveSession.mockReturnValue({
      hasActiveTurn: () => true,
    });
    const orch = new PlanningOrchestrator(sm as any);

    // The turn is in flight, so the terminal transition is deferred rather
    // than applied inline.
    await orch.handleDisposition({
      intent: approveIntent,
      disposition: 'approve',
    });
    await flush();
    expect(updateStatus).not.toHaveBeenCalled();

    // The turn's boundary arrives (session_ended) and drains the deferred
    // approve-terminal transition.
    sm.emit('message', { type: 'session_ended', sessionId: 'design-session-1', status: 'idle' });
    await flush();

    expect(markSessionDone).toHaveBeenCalledWith(
      'design-session-1',
      expect.any(Number),
      null,
      'planning_approved',
      expect.objectContaining({ skipInFlightGuard: true }),
    );
    expect(updateStatus).toHaveBeenCalledWith(
      'task-1',
      '✅ Done',
      expect.objectContaining({
        source: 'orchestrator',
        sessionId: 'design-session-1',
      }),
    );
  });

  it('leaves the task status unchanged when a closing intent was rejected, even on the planning_approved reason', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const approveIntent = makeIntent({
      id: 'intent-1',
      state: 'committed',
      group_id: null,
    });
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      approveIntent,
      makeIntent({
        id: 'intent-2',
        kind: 'arch.createUnit',
        state: 'rejected',
        group_id: null,
      }),
    ]);
    const orch = new PlanningOrchestrator(sm as any);

    await orch.handleDisposition({
      intent: approveIntent,
      disposition: 'approve',
    });
    await flush();

    expect(markSessionDone).toHaveBeenCalledWith(
      'design-session-1',
      expect.any(Number),
      null,
      'planning_approved',
      expect.objectContaining({ skipInFlightGuard: true }),
    );
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('does not close the task for a groom session reaching terminal via planning_approved', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(
      makeSessionRow({ session_type: 'groom' }),
    );
    const approveIntent = makeIntent({
      id: 'intent-1',
      kind: 'task.setStatus',
      state: 'committed',
      group_id: null,
    });
    vi.mocked(listStagedIntentsBySession).mockReturnValue([approveIntent]);
    const orch = new PlanningOrchestrator(sm as any);

    await orch.handleDisposition({
      intent: approveIntent,
      disposition: 'approve',
    });
    await flush();

    expect(markSessionDone).toHaveBeenCalledWith(
      'design-session-1',
      expect.any(Number),
      null,
      'planning_approved',
      expect.objectContaining({ skipInFlightGuard: true }),
    );
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('leaves the task status unchanged when a closing intent was declined', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({ id: 'intent-1', state: 'committed' }),
      makeIntent({
        id: 'intent-2',
        kind: 'arch.createUnit',
        state: 'rejected',
        disposition_reason: 'not needed',
      }),
    ]);
    const orch = new PlanningOrchestrator(sm as any);

    orch.checkTerminal('design-session-1');
    const terminal = orch.checkTerminal('design-session-1');
    await flush();

    expect(terminal).toBe(true);
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('leaves the task status unchanged for an operator-killed design session', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({ id: 'intent-1', state: 'staged' }),
    ]);
    const orch = new PlanningOrchestrator(sm as any);

    orch.endSession('design-session-1');
    await flush();

    expect(markSessionDone).toHaveBeenCalledWith(
      'design-session-1',
      expect.any(Number),
      null,
      expect.stringContaining('operator_end'),
    );
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('does not close the task for a groom session reaching terminal', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(
      makeSessionRow({ session_type: 'groom' }),
    );
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({
        id: 'intent-1',
        kind: 'task.setStatus',
        state: 'committed',
      }),
    ]);
    const orch = new PlanningOrchestrator(sm as any);

    orch.checkTerminal('design-session-1');
    const terminal = orch.checkTerminal('design-session-1');
    await flush();

    expect(terminal).toBe(true);
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('does not close the task for an ops session reaching terminal', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(
      makeSessionRow({ session_type: 'ops' }),
    );
    vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
    const orch = new PlanningOrchestrator(sm as any);

    const terminal = orch.checkTerminal('design-session-1');
    await flush();

    expect(terminal).toBe(true);
    expect(updateStatus).not.toHaveBeenCalled();
  });
});
