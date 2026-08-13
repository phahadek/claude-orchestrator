import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { mockDbQueries } from '../../__tests__/helpers/mockDbQueries';

/**
 * Dual-write coverage for markTerminal's completing-signal mirror (see the
 * staged-intent planning-family migration onto session/completingSignalRegistry.ts
 * and sessionStatusDeriver.ts): every markTerminal call for a design/groom/
 * docs/ops session must mirror its terminal reason into
 * completing_signal_ledger as a 'staged_intent' signal, purely additive
 * ahead of any read-side cutover. setSessionTerminalCompletionReason and
 * insertCompletingSignal are deliberately left un-mocked here (real
 * db/queries implementations against the shared in-memory test DB — see
 * testSetupDb.ts) so this asserts the actual ledger row, not a mock call.
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
  findIncompleteOpsTerminalGroupsForSession: vi.fn().mockReturnValue([]),
  isOpsTerminalClosingSetMember: vi.fn().mockReturnValue(false),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(() => ({
    updateStatus: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../routes/tasks', () => ({
  emitTaskUpdated: vi.fn(),
  broadcastTaskStatusChanged: vi.fn(),
}));

import { getSession, listStagedIntentsBySession } from '../../db/queries';
import { listCompletingSignalsForSession } from '../../db/queries';
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
    session_id: 'dual-write-session',
    session_type: 'design',
    status: 'idle',
    task_id: 'task-dual-write',
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
    task_id: 'task-dual-write',
    project_id: 'project-1',
    session_id: 'dual-write-session',
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
});

describe('PlanningOrchestrator markTerminal — completing-signal dual-write', () => {
  it('mirrors a design session terminal reason into completing_signal_ledger as a staged_intent signal', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      makeIntent({ id: 'intent-1', state: 'committed' }),
    ]);
    const orch = new PlanningOrchestrator(sm as any);

    orch.checkTerminal('dual-write-session');
    const terminal = orch.checkTerminal('dual-write-session');
    await flush();

    expect(terminal).toBe(true);
    const signals = listCompletingSignalsForSession('dual-write-session');
    expect(signals).toContainEqual(
      expect.objectContaining({
        session_id: 'dual-write-session',
        task_id: 'task-dual-write',
        session_type: 'design',
        signal_class: 'staged_intent',
        signal_value: 'planning_no_pending_dispositions',
      }),
    );
  });

  it('mirrors an operator-ended ops session terminal reason into completing_signal_ledger', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(
      makeSessionRow({
        session_id: 'ops-operator-end-session',
        session_type: 'ops',
        task_id: 'task-ops-1',
      }),
    );
    const orch = new PlanningOrchestrator(sm as any);

    orch.endSession('ops-operator-end-session');
    await flush();

    const signals = listCompletingSignalsForSession('ops-operator-end-session');
    expect(signals).toContainEqual(
      expect.objectContaining({
        session_id: 'ops-operator-end-session',
        task_id: 'task-ops-1',
        session_type: 'ops',
        signal_class: 'staged_intent',
        signal_value: 'planning_operator_end',
      }),
    );
  });
});
