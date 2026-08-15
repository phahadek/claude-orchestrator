import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { mockDbQueries } from '../../__tests__/helpers/mockDbQueries';

/**
 * Coverage for the investigate-flow closure's Half B: an investigate
 * session (task_id `report-batch:<batchId>`, dispatched as session_type
 * 'ops') that stages nothing must still reach terminal on its very first
 * park — not the second-occurrence no-decision nudge dance regular
 * planning sessions go through — since a not-actionable finding is a
 * legitimate, common investigation outcome (see reportStore.ts's
 * isResolveEligible docstring). Also covers the cold-path
 * tryTerminalizeIfComplete the liveness reconciler consults so a
 * restart-orphaned investigate session is driven to 'done' with a proper
 * terminal_completion_reason instead of a bare 'killed' write.
 */

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../db/queries', () =>
  mockDbQueries({
    getSession: vi.fn(),
    listStagedIntentsBySession: vi.fn().mockReturnValue([]),
    listStagedIntentsByGroup: vi.fn().mockReturnValue([]),
    markSessionDone: vi.fn(),
    setPendingApproveTerminal: vi.fn(),
    clearPendingApproveTerminal: vi.fn(),
    getSessionsWithPendingApproveTerminal: vi.fn().mockReturnValue([]),
    getPRBySessionId: vi.fn().mockReturnValue(null),
    setTaskPauseReason: vi.fn(),
    setSessionTerminalCompletionReason: vi.fn(),
    insertCompletingSignal: vi.fn(),
    hasActiveCapabilityRequestForSession: vi.fn().mockReturnValue(false),
  }),
);

vi.mock('../../routes/stagedIntents', () => ({
  verifyDispatchedGroupsForSession: vi.fn().mockResolvedValue([]),
  sessionOwesGatedDesignArtifacts: vi.fn().mockReturnValue(false),
  findIncompleteOpsTerminalGroupsForSession: vi.fn().mockReturnValue([]),
  isOpsTerminalClosingSetMember: vi.fn().mockReturnValue(false),
}));

vi.mock('../../ops/opsJournal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ops/opsJournal')>();
  return { ...actual, getEntry: vi.fn().mockReturnValue(undefined) };
});

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(() => ({
    updateStatus: vi.fn().mockResolvedValue(undefined),
    fetchTaskSummary: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../routes/tasks', () => ({
  emitTaskUpdated: vi.fn(),
  broadcastTaskStatusChanged: vi.fn(),
}));

import {
  getSession,
  listStagedIntentsBySession,
  markSessionDone,
  setSessionTerminalCompletionReason,
  insertCompletingSignal,
} from '../../db/queries';
import { PlanningOrchestrator } from '../PlanningOrchestrator';
import type { StagedIntentRow } from '../../db/types';

function makeSessionManager() {
  const sm = new EventEmitter();
  return Object.assign(sm, {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn(),
    getLiveSession: vi.fn().mockReturnValue(undefined),
  });
}

function makeInvestigateSessionRow(
  overrides: Partial<{
    session_id: string;
    session_type: string;
    status: string;
    task_id: string | null;
    project_id: string | null;
  }> = {},
) {
  return {
    session_id: 'investigate-session-1',
    session_type: 'ops',
    status: 'idle',
    task_id: 'report-batch:batch-1',
    project_id: 'project-1',
    ...overrides,
  } as any;
}

function makeIntent(overrides: Partial<StagedIntentRow> = {}): StagedIntentRow {
  return {
    id: 'intent-1',
    kind: 'task.create',
    payload: '{}',
    payload_hash: 'hash',
    task_id: 'report-batch:batch-1',
    project_id: 'project-1',
    session_id: 'investigate-session-1',
    group_id: null,
    state: 'staged',
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
});

describe('PlanningOrchestrator.checkTerminal — investigate sessions', () => {
  it('reaches terminal on the very first call when zero intents were staged, with no nudge sent', () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeInvestigateSessionRow());
    vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
    const orch = new PlanningOrchestrator(sm as any);

    const terminal = orch.checkTerminal('investigate-session-1');

    expect(terminal).toBe(true);
    expect(sm.enqueueFeedback).not.toHaveBeenCalled();
    expect(markSessionDone).toHaveBeenCalledWith(
      'investigate-session-1',
      expect.any(Number),
      null,
      'planning_no_pending_dispositions',
    );
    expect(setSessionTerminalCompletionReason).toHaveBeenCalledWith(
      'investigate-session-1',
      'planning_no_pending_dispositions',
    );
    expect(insertCompletingSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'investigate-session-1',
        signal_value: 'planning_no_pending_dispositions',
      }),
    );
  });

  it('reaches terminal on the very first call when every staged intent has settled, even when none of them count as a "decision" kind', () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeInvestigateSessionRow());
    // decision.pickOne is deliberately excluded from hasStagedDecision's
    // kind set — proves this path is driven by isInvestigateSession, not
    // by having staged something that counts as a decision.
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({
        id: 'intent-1',
        kind: 'decision.pickOne',
        state: 'committed',
      }),
      makeIntent({
        id: 'intent-2',
        kind: 'decision.pickOne',
        state: 'rejected',
      }),
    ]);
    const orch = new PlanningOrchestrator(sm as any);

    const terminal = orch.checkTerminal('investigate-session-1');

    expect(terminal).toBe(true);
    expect(markSessionDone).toHaveBeenCalledWith(
      'investigate-session-1',
      expect.any(Number),
      null,
      'planning_no_pending_dispositions',
    );
  });

  it('does not reach terminal while a staged (undispositioned) intent remains', () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeInvestigateSessionRow());
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({ id: 'intent-1', state: 'staged' }),
    ]);
    const orch = new PlanningOrchestrator(sm as any);

    const terminal = orch.checkTerminal('investigate-session-1');

    expect(terminal).toBe(false);
    expect(markSessionDone).not.toHaveBeenCalled();
  });
});

describe('PlanningOrchestrator.tryTerminalizeIfComplete', () => {
  it('terminalizes a settled investigate session via the cold path, for a caller with no live turn/park event', () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeInvestigateSessionRow());
    vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
    const orch = new PlanningOrchestrator(sm as any);

    const result = orch.tryTerminalizeIfComplete('investigate-session-1');

    expect(result).toBe(true);
    expect(markSessionDone).toHaveBeenCalledWith(
      'investigate-session-1',
      expect.any(Number),
      null,
      'planning_no_pending_dispositions',
      { skipInFlightGuard: true },
    );
    expect(setSessionTerminalCompletionReason).toHaveBeenCalledWith(
      'investigate-session-1',
      'planning_no_pending_dispositions',
    );
  });

  it('returns false and does not terminalize a session that still has a staged intent', () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeInvestigateSessionRow());
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({ id: 'intent-1', state: 'staged' }),
    ]);
    const orch = new PlanningOrchestrator(sm as any);

    const result = orch.tryTerminalizeIfComplete('investigate-session-1');

    expect(result).toBe(false);
    expect(markSessionDone).not.toHaveBeenCalled();
  });

  it('returns false for an unknown session', () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(undefined);
    const orch = new PlanningOrchestrator(sm as any);

    expect(orch.tryTerminalizeIfComplete('missing-session')).toBe(false);
  });
});
