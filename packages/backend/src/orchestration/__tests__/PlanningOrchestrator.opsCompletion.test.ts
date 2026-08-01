import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { mockDbQueries } from '../../__tests__/helpers/mockDbQueries';

/**
 * Coverage for the ops-completion gap: an ops session's natural (not
 * operator-killed) terminal is the orchestrator's only signal to close its
 * target task, mirroring the design and docs closers. A gate-verify session
 * (task_id `gate-item:<id>`) must be excluded since it has no Notion task.
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
  }),
);

vi.mock('../../routes/stagedIntents', () => ({
  verifyDispatchedGroupsForSession: vi.fn().mockResolvedValue([]),
  sessionOwesGatedDesignArtifacts: vi.fn().mockReturnValue(false),
}));

const updateStatus = vi.fn().mockResolvedValue(undefined);
vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(() => ({ updateStatus })),
}));

vi.mock('../../routes/tasks', () => ({
  emitTaskUpdated: vi.fn(),
}));

import { getSession, listStagedIntentsBySession } from '../../db/queries';
import { getTaskBackend } from '../../tasks/TaskBackend';
import { emitTaskUpdated } from '../../routes/tasks';
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
    session_id: 'ops-session-1',
    session_type: 'ops',
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
    session_id: 'ops-session-1',
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

describe('PlanningOrchestrator — ops task completion', () => {
  it('transitions the target task to Done when an ops session reaches terminal via planning_approved with no rejected intents', async () => {
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

    expect(getTaskBackend).toHaveBeenCalledWith('project-1');
    expect(updateStatus).toHaveBeenCalledWith(
      'task-1',
      '✅ Done',
      expect.objectContaining({
        source: 'orchestrator',
        sessionId: 'ops-session-1',
      }),
    );
    expect(emitTaskUpdated).toHaveBeenCalledWith('task-1');
  });

  it('transitions the target task to Done when an ops session reaches terminal via planning_no_pending_dispositions', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({ id: 'intent-1', state: 'committed' }),
    ]);
    const orch = new PlanningOrchestrator(sm as any);

    // First park primes the resume-count snapshot; the second confirms the
    // turn staged nothing new (see checkTerminal's stagedNothingNew comment).
    orch.checkTerminal('ops-session-1');
    const terminal = orch.checkTerminal('ops-session-1');
    await flush();

    expect(terminal).toBe(true);
    expect(updateStatus).toHaveBeenCalledWith(
      'task-1',
      '✅ Done',
      expect.objectContaining({
        source: 'orchestrator',
        sessionId: 'ops-session-1',
      }),
    );
  });

  it('leaves the task status unchanged when an ops session has any intent in state rejected', async () => {
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

    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('leaves the task status unchanged for an operator-killed ops session', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({ id: 'intent-1', state: 'staged' }),
    ]);
    const orch = new PlanningOrchestrator(sm as any);

    orch.endSession('ops-session-1');
    await flush();

    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('performs no task-status write for a gate-verify session reaching terminal', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(
      makeSessionRow({ task_id: 'gate-item:abc123' }),
    );
    vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
    const orch = new PlanningOrchestrator(sm as any);

    orch.checkTerminal('ops-session-1');
    const terminal = orch.checkTerminal('ops-session-1');
    await flush();

    expect(terminal).toBe(true);
    expect(getTaskBackend).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
  });
});
