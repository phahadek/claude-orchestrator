import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { mockDbQueries } from '../../__tests__/helpers/mockDbQueries';

/**
 * Coverage for docs task completion: a docs session's natural terminal
 * closes its target task only when the session never opened a PR (the
 * Notion-page-edit-only outcome) — see completeDocsTask in
 * PlanningOrchestrator.ts. A docs session that did open a PR leaves the
 * task's closure to the existing merge-driven path instead.
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

import {
  getSession,
  listStagedIntentsBySession,
  getPRBySessionId,
} from '../../db/queries';
import { getTaskBackend } from '../../tasks/TaskBackend';
import { PlanningOrchestrator } from '../PlanningOrchestrator';

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
    session_id: 'docs-session-1',
    session_type: 'docs',
    status: 'idle',
    task_id: 'task-1',
    project_id: 'project-1',
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  updateStatus.mockResolvedValue(undefined);
  vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
  vi.mocked(getPRBySessionId).mockReturnValue(null);
});

describe('PlanningOrchestrator — docs task completion', () => {
  it('transitions the target task to Done when a docs session reaches terminal with no PR opened', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    const orch = new PlanningOrchestrator(sm as any);

    orch.checkTerminal('docs-session-1');
    const terminal = orch.checkTerminal('docs-session-1');
    await flush();

    expect(terminal).toBe(true);
    expect(getTaskBackend).toHaveBeenCalledWith('project-1');
    expect(updateStatus).toHaveBeenCalledWith(
      'task-1',
      '✅ Done',
      expect.objectContaining({
        source: 'orchestrator',
        sessionId: 'docs-session-1',
      }),
    );
  });

  it('leaves the task status unchanged when a docs session opened a PR', async () => {
    const sm = makeSessionManager();
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 42,
      repo: 'owner/repo',
    } as any);
    const orch = new PlanningOrchestrator(sm as any);

    orch.checkTerminal('docs-session-1');
    const terminal = orch.checkTerminal('docs-session-1');
    await flush();

    expect(terminal).toBe(true);
    expect(updateStatus).not.toHaveBeenCalled();
  });
});
