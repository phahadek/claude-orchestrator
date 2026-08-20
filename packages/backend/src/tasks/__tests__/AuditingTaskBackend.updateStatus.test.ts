import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRecordEvent = vi.fn();
const mockUpdateTaskStatusInBoardCaches = vi.fn();
const mockGetTaskStatusFromCache = vi.fn();
const mockRecordTaskStatusWrite = vi.fn();
const mockCloseFlakyRemediationTaskIfLinked = vi.fn();

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: (...args: unknown[]) => mockRecordEvent(...args),
}));

vi.mock('../../audit/flakyRemediationFiling', () => ({
  closeFlakyRemediationTaskIfLinked: (...args: unknown[]) =>
    mockCloseFlakyRemediationTaskIfLinked(...args),
}));

vi.mock('../../db/queries', () => ({
  upsertTaskCache: vi.fn(),
  updateTaskStatusInBoardCaches: (...args: unknown[]) =>
    mockUpdateTaskStatusInBoardCaches(...args),
  getTaskStatusFromCache: (...args: unknown[]) =>
    mockGetTaskStatusFromCache(...args),
  recordTaskStatusWrite: (...args: unknown[]) =>
    mockRecordTaskStatusWrite(...args),
}));

import { AuditingTaskBackend } from '../TaskBackend';
import type { TaskBackend } from '../TaskBackend';

function makeInnerBackend(overrides: Partial<TaskBackend> = {}): TaskBackend {
  return {
    type: 'notion',
    fetchReadyTasks: vi.fn(),
    attachPR: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    fetchTaskPage: vi.fn(),
    fetchTaskSummary: vi.fn(),
    fetchNonMilestoneReadyTasks: vi.fn(),
    updateNotes: vi.fn(),
    appendImplementationNote: vi.fn(),
    listTasksByStatus: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  mockRecordEvent.mockReset();
  mockUpdateTaskStatusInBoardCaches.mockReset();
  mockGetTaskStatusFromCache.mockReset();
  mockRecordTaskStatusWrite.mockReset();
  mockCloseFlakyRemediationTaskIfLinked.mockReset();
});

describe('AuditingTaskBackend.updateStatus', () => {
  it('patches the board caches with the task id and display-status string for a status write that does not go through BackendTaskWriteCommands.setStatus', async () => {
    const inner = makeInnerBackend();
    const backend = new AuditingTaskBackend(inner, 'proj-1');

    // A direct-backend-path write, e.g. PlanningOrchestrator calling
    // backend.updateStatus directly rather than via
    // BackendTaskWriteCommands.setStatus.
    await backend.updateStatus('notion:abc', '🔄 In Progress', {
      source: 'orchestrator',
      sessionId: 'sess-1',
    });

    expect(inner.updateStatus).toHaveBeenCalledWith(
      'notion:abc',
      '🔄 In Progress',
    );
    expect(mockUpdateTaskStatusInBoardCaches).toHaveBeenCalledWith(
      'notion:abc',
      '🔄 In Progress',
    );
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'status_updated',
        task_id: 'notion:abc',
      }),
    );
  });

  it('records the cached prior status as from, not the value being written', async () => {
    const inner = makeInnerBackend();
    const backend = new AuditingTaskBackend(inner, 'proj-1');
    mockGetTaskStatusFromCache.mockReturnValue('🗂️ Ready');

    await backend.updateStatus('notion:abc', '🔄 In Progress', {
      source: 'orchestrator',
      sessionId: 'sess-1',
    });

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          from: '🗂️ Ready',
          to: '🔄 In Progress',
        }),
      }),
    );
    expect(mockRecordEvent.mock.calls[0][0].payload).not.toHaveProperty(
      'notes',
    );
  });

  it('records a different cached prior status for a second transition, proving from is not hardcoded to the write value', async () => {
    const inner = makeInnerBackend();
    const backend = new AuditingTaskBackend(inner, 'proj-1');
    mockGetTaskStatusFromCache.mockReturnValue('🔄 In Progress');

    await backend.updateStatus('notion:abc', '✅ Done', {
      source: 'orchestrator',
      sessionId: 'sess-1',
    });

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          from: '🔄 In Progress',
          to: '✅ Done',
        }),
      }),
    );
  });

  it('records from: null with the explanatory note when there is no cached prior status', async () => {
    const inner = makeInnerBackend();
    const backend = new AuditingTaskBackend(inner, 'proj-1');
    mockGetTaskStatusFromCache.mockReturnValue(null);

    await backend.updateStatus('notion:abc', '🔄 In Progress', {
      source: 'orchestrator',
      sessionId: 'sess-1',
    });

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          from: null,
          notes: 'previous status not captured',
        }),
      }),
    );
  });

  it('resolves the prior status from cache only, issuing no task-source fetch', async () => {
    const inner = makeInnerBackend();
    const backend = new AuditingTaskBackend(inner, 'proj-1');
    mockGetTaskStatusFromCache.mockReturnValue('🗂️ Ready');

    await backend.updateStatus('notion:abc', '🔄 In Progress', {
      source: 'orchestrator',
      sessionId: 'sess-1',
    });

    expect(mockGetTaskStatusFromCache).toHaveBeenCalledWith('notion:abc');
    expect(inner.fetchTaskPage).not.toHaveBeenCalled();
    expect(inner.fetchTaskSummary).not.toHaveBeenCalled();
    expect(inner.fetchReadyTasks).not.toHaveBeenCalled();
  });

  it('still writes the status update and audit event when resolving the prior status throws', async () => {
    const inner = makeInnerBackend();
    const backend = new AuditingTaskBackend(inner, 'proj-1');
    mockGetTaskStatusFromCache.mockImplementation(() => {
      throw new Error('cache read failed');
    });

    await backend.updateStatus('notion:abc', '🔄 In Progress', {
      source: 'orchestrator',
      sessionId: 'sess-1',
    });

    expect(inner.updateStatus).toHaveBeenCalledWith(
      'notion:abc',
      '🔄 In Progress',
    );
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          from: null,
          to: '🔄 In Progress',
          notes: 'previous status not captured',
        }),
      }),
    );
  });

  it('closes any linked flaky-remediation tracking on a transition to a terminal status', async () => {
    const inner = makeInnerBackend();
    const backend = new AuditingTaskBackend(inner, 'proj-1');

    await backend.updateStatus('notion:abc', '✅ Done', {
      source: 'orchestrator',
      sessionId: 'sess-1',
    });

    expect(mockCloseFlakyRemediationTaskIfLinked).toHaveBeenCalledWith(
      'notion:abc',
      expect.any(String),
    );
  });

  it('does not attempt to close flaky-remediation tracking on a non-terminal transition', async () => {
    const inner = makeInnerBackend();
    const backend = new AuditingTaskBackend(inner, 'proj-1');

    await backend.updateStatus('notion:abc', '🔄 In Progress', {
      source: 'orchestrator',
      sessionId: 'sess-1',
    });

    expect(mockCloseFlakyRemediationTaskIfLinked).not.toHaveBeenCalled();
  });
});
