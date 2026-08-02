import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { mockDbQueries } from '../../__tests__/helpers/mockDbQueries';

/**
 * Coverage for the ops-completion gap: an ops session's natural (not
 * operator-killed) terminal is the orchestrator's only signal to close its
 * target task, mirroring the design and docs closers. A gate-verify session
 * (task_id `gate-item:<id>`) must be excluded since it has no Notion task.
 *
 * Ops additionally requires its ops_journal entry to have already reached
 * 'resolved' at the moment terminal is reached — terminal-session and
 * completed-investigation are different events for ops (unlike design/docs,
 * where reaching terminal is itself completion). See PlanningOrchestrator's
 * completeOpsTask.
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
  }),
);

vi.mock('../../routes/stagedIntents', () => ({
  verifyDispatchedGroupsForSession: vi.fn().mockResolvedValue([]),
  sessionOwesGatedDesignArtifacts: vi.fn().mockReturnValue(false),
  findIncompleteOpsTerminalGroupsForSession: vi.fn().mockReturnValue([]),
  groupHasOpsTerminalMember: vi.fn().mockReturnValue(false),
}));

const updateStatus = vi.fn().mockResolvedValue(undefined);
const fetchTaskSummary = vi.fn().mockResolvedValue(undefined);
vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(() => ({ updateStatus, fetchTaskSummary })),
}));

vi.mock('../../routes/tasks', () => ({
  emitTaskUpdated: vi.fn(),
  broadcastTaskStatusChanged: vi.fn(),
}));

vi.mock('../../ops/opsJournal', () => ({
  getEntry: vi.fn(),
}));

import {
  getSession,
  listStagedIntentsBySession,
  getPRBySessionId,
} from '../../db/queries';
import { getTaskBackend } from '../../tasks/TaskBackend';
import { emitTaskUpdated } from '../../routes/tasks';
import { groupHasOpsTerminalMember } from '../../routes/stagedIntents';
import { PlanningOrchestrator, closeDeferredOpsTask } from '../PlanningOrchestrator';
import type { StagedIntentRow, Session } from '../../db/types';
import { getEntry } from '../../ops/opsJournal';
import type { OpsState } from '../../ops/opsJournal';

function makeJournalEntry(state: OpsState) {
  return {
    taskId: 'task-1',
    project: 'project-1',
    milestone: 'M1',
    state,
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

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

function makeTerminalSession(
  overrides: Partial<Session> = {},
): Session {
  return {
    session_id: 'ops-session-1',
    session_type: 'ops',
    status: 'done',
    task_id: 'task-1',
    project_id: 'project-1',
    terminal_completion_reason: 'planning_approved',
    ...overrides,
  } as Session;
}

beforeEach(() => {
  vi.clearAllMocks();
  updateStatus.mockResolvedValue(undefined);
  fetchTaskSummary.mockResolvedValue(undefined);
  vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
  vi.mocked(getEntry).mockReturnValue(makeJournalEntry('resolved'));
  vi.mocked(getPRBySessionId).mockReturnValue(null);
  vi.mocked(groupHasOpsTerminalMember).mockReturnValue(false);
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

  it('closes the task when a rejected intent exists but is outside the closing group', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const approveIntent = makeIntent({
      id: 'intent-1',
      state: 'committed',
      group_id: 'closing-group-1',
    });
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      approveIntent,
      // An orthogonal decline the operator made against unrelated staged
      // work — not a member of any ops-terminal closing group.
      makeIntent({
        id: 'intent-2',
        kind: 'gate.verify',
        state: 'rejected',
        group_id: null,
      }),
    ]);
    vi.mocked(groupHasOpsTerminalMember).mockImplementation(
      (groupId) => groupId === 'closing-group-1',
    );
    const orch = new PlanningOrchestrator(sm as any);

    await orch.handleDisposition({
      intent: approveIntent,
      disposition: 'approve',
    });
    await flush();

    expect(updateStatus).toHaveBeenCalledWith(
      'task-1',
      '✅ Done',
      expect.objectContaining({
        source: 'orchestrator',
        sessionId: 'ops-session-1',
      }),
    );
  });

  it('leaves the task status unchanged when a rejected intent sits inside the closing group', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const approveIntent = makeIntent({
      id: 'intent-1',
      kind: 'journal.setState',
      state: 'committed',
      group_id: 'closing-group-1',
    });
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      approveIntent,
      makeIntent({
        id: 'intent-2',
        kind: 'task.create',
        state: 'rejected',
        group_id: 'closing-group-1',
      }),
    ]);
    vi.mocked(groupHasOpsTerminalMember).mockImplementation(
      (groupId) => groupId === 'closing-group-1',
    );
    const orch = new PlanningOrchestrator(sm as any);

    await orch.handleDisposition({
      intent: approveIntent,
      disposition: 'approve',
    });
    await flush();

    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('leaves the task status unchanged when a needs_revision (pushback) member sits inside the closing group', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const approveIntent = makeIntent({
      id: 'intent-1',
      kind: 'journal.setState',
      state: 'committed',
      group_id: 'closing-group-1',
    });
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      approveIntent,
      makeIntent({
        id: 'intent-2',
        kind: 'task.create',
        state: 'needs_revision',
        group_id: 'closing-group-1',
      }),
    ]);
    vi.mocked(groupHasOpsTerminalMember).mockImplementation(
      (groupId) => groupId === 'closing-group-1',
    );
    const orch = new PlanningOrchestrator(sm as any);

    await orch.handleDisposition({
      intent: approveIntent,
      disposition: 'approve',
    });
    await flush();

    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('completeOpsTask and closeDeferredOpsTask agree: both close when the rejected intent is outside the closing group', async () => {
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({
        id: 'intent-1',
        kind: 'journal.setState',
        state: 'committed',
        group_id: 'closing-group-1',
      }),
      makeIntent({
        id: 'intent-2',
        kind: 'gate.verify',
        state: 'rejected',
        group_id: null,
      }),
    ]);
    vi.mocked(groupHasOpsTerminalMember).mockImplementation(
      (groupId) => groupId === 'closing-group-1',
    );

    await closeDeferredOpsTask(makeTerminalSession());
    await flush();
    expect(updateStatus).toHaveBeenCalledWith(
      'task-1',
      '✅ Done',
      expect.objectContaining({ source: 'orchestrator' }),
    );

    updateStatus.mockClear();
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const orch = new PlanningOrchestrator(sm as any);
    await orch.handleDisposition({
      intent: makeIntent({ id: 'intent-1', state: 'committed' }),
      disposition: 'approve',
    });
    await flush();
    expect(updateStatus).toHaveBeenCalledWith(
      'task-1',
      '✅ Done',
      expect.objectContaining({ source: 'orchestrator' }),
    );
  });

  it('completeOpsTask and closeDeferredOpsTask agree: both stay blocked when the rejected intent is inside the closing group', async () => {
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({
        id: 'intent-1',
        kind: 'journal.setState',
        state: 'committed',
        group_id: 'closing-group-1',
      }),
      makeIntent({
        id: 'intent-2',
        kind: 'task.create',
        state: 'rejected',
        group_id: 'closing-group-1',
      }),
    ]);
    vi.mocked(groupHasOpsTerminalMember).mockImplementation(
      (groupId) => groupId === 'closing-group-1',
    );

    await closeDeferredOpsTask(makeTerminalSession());
    await flush();
    expect(updateStatus).not.toHaveBeenCalled();

    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const orch = new PlanningOrchestrator(sm as any);
    await orch.handleDisposition({
      intent: makeIntent({ id: 'intent-1', state: 'committed' }),
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

  it.each([
    'pending',
    'candidate',
    'staged-proposal',
    'applied-pending-confirm',
  ] as const)(
    'leaves the task status unchanged when the ops_journal entry is at %s',
    async (state) => {
      const sm = makeSessionManager();
      vi.mocked(getSession).mockReturnValue(makeSessionRow());
      vi.mocked(getEntry).mockReturnValue(makeJournalEntry(state));
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

      expect(updateStatus).not.toHaveBeenCalled();
    },
  );

  it('leaves the task status unchanged when an ops session has an open PR — the PR-merge-driven path owns closure instead', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 42,
      repo: 'owner/repo',
    } as any);
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

    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('leaves the task status unchanged when the ops session has no ops_journal entry', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(getEntry).mockReturnValue(undefined);
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

    expect(updateStatus).not.toHaveBeenCalled();
  });
});
