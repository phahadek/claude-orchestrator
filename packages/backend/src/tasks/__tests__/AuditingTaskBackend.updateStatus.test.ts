import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRecordEvent = vi.fn();
const mockUpdateTaskStatusInBoardCaches = vi.fn();

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: (...args: unknown[]) => mockRecordEvent(...args),
}));

vi.mock('../../db/queries', () => ({
  upsertTaskCache: vi.fn(),
  updateTaskStatusInBoardCaches: (...args: unknown[]) =>
    mockUpdateTaskStatusInBoardCaches(...args),
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
});
