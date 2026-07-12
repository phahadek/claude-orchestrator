import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRecordEvent = vi.fn();

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: (...args: unknown[]) => mockRecordEvent(...args),
}));

vi.mock('../../db/queries', () => ({
  upsertTaskCache: vi.fn(),
}));

import { AuditingTaskBackend } from '../TaskBackend';
import type { TaskBackend } from '../TaskBackend';

function makeInnerBackend(overrides: Partial<TaskBackend> = {}): TaskBackend {
  return {
    type: 'notion',
    fetchReadyTasks: vi.fn(),
    attachPR: vi.fn(),
    updateStatus: vi.fn(),
    fetchTaskPage: vi.fn(),
    fetchNonMilestoneReadyTasks: vi.fn(),
    updateNotes: vi.fn(),
    appendImplementationNote: vi.fn(),
    listTasksByStatus: vi.fn(),
    archive: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  mockRecordEvent.mockReset();
});

describe('AuditingTaskBackend.archive', () => {
  it('archives the page and emits a task_archived audit event', async () => {
    const inner = makeInnerBackend();
    const backend = new AuditingTaskBackend(inner, 'proj-1');

    await backend.archive('notion:abc', { source: 'human', sessionId: null });

    expect(inner.archive).toHaveBeenCalledWith('notion:abc');
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'task_archived',
        actor_type: 'human',
        project_id: 'proj-1',
        task_id: 'notion:abc',
      }),
    );
  });

  it('throws when the inner backend does not support archive', async () => {
    const inner = makeInnerBackend({ archive: undefined });
    const backend = new AuditingTaskBackend(inner, 'proj-1');

    await expect(backend.archive('notion:abc')).rejects.toThrow(
      /not supported/i,
    );
  });
});
