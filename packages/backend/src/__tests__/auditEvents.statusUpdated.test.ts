import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../audit/AuditLog', () => ({ recordEvent: vi.fn() }));

import { recordEvent } from '../audit/AuditLog';
import { AuditingTaskBackend } from '../tasks/TaskBackend';
import type { TaskBackend } from '../tasks/TaskBackend';

function makeInnerBackend(type: 'notion' | 'local' = 'notion'): TaskBackend {
  return {
    type,
    updateStatus: vi.fn().mockResolvedValue(undefined),
    attachPR: vi.fn().mockResolvedValue(undefined),
    fetchReadyTasks: vi.fn().mockResolvedValue([]),
    fetchTaskPage: vi.fn().mockResolvedValue(''),
    fetchNonMilestoneReadyTasks: vi.fn().mockResolvedValue([]),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AuditingTaskBackend — status_updated', () => {
  it('NotionTaskBackend.updateStatus writes one status_updated audit entry with expected payload', async () => {
    const inner = makeInnerBackend('notion');
    const backend = new AuditingTaskBackend(inner, 'proj-1');

    await backend.updateStatus('notion:abc', '👀 In Review');

    expect(vi.mocked(recordEvent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'status_updated',
        actor_type: 'system',
        project_id: 'proj-1',
        task_id: 'notion:abc',
        payload: expect.objectContaining({
          to: '👀 In Review',
          source: 'orchestrator',
        }),
      }),
    );
  });

  it('LocalTaskBackend.updateStatus writes one status_updated audit entry with expected payload', async () => {
    const inner = makeInnerBackend('local');
    const backend = new AuditingTaskBackend(inner, 'proj-local');

    await backend.updateStatus('yaml:my-task', '✅ Done');

    expect(vi.mocked(recordEvent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'status_updated',
        actor_type: 'system',
        project_id: 'proj-local',
        task_id: 'yaml:my-task',
        payload: expect.objectContaining({
          to: '✅ Done',
          source: 'orchestrator',
        }),
      }),
    );
  });

  it('source field is "orchestrator" when called from SessionManager lifecycle hooks', async () => {
    const inner = makeInnerBackend('notion');
    const backend = new AuditingTaskBackend(inner, 'proj-1');

    await backend.updateStatus('notion:abc', '🔄 In Progress', {
      source: 'orchestrator',
      sessionId: 'session-123',
    });

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'status_updated',
        actor_type: 'system',
        actor_id: 'session-123',
        payload: expect.objectContaining({ source: 'orchestrator' }),
      }),
    );
  });

  it('source field is "human" when called from the PATCH /api/tasks/:id/status route handler', async () => {
    const inner = makeInnerBackend('notion');
    const backend = new AuditingTaskBackend(inner, 'proj-1');

    await backend.updateStatus('notion:abc', '🗂️ Ready', { source: 'human' });

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'status_updated',
        actor_type: 'human',
        payload: expect.objectContaining({ source: 'human' }),
      }),
    );
  });

  it('actor_type is "human" when source is "human"', async () => {
    const inner = makeInnerBackend();
    const backend = new AuditingTaskBackend(inner, 'proj-1');

    await backend.updateStatus('notion:xyz', '✅ Done', { source: 'human' });

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ actor_type: 'human' }),
    );
  });

  it('actor_type is "system" when source is "orchestrator"', async () => {
    const inner = makeInnerBackend();
    const backend = new AuditingTaskBackend(inner, 'proj-1');

    await backend.updateStatus('notion:xyz', '✅ Done', { source: 'orchestrator' });

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ actor_type: 'system' }),
    );
  });

  it('defaults to source "orchestrator" when no options are passed', async () => {
    const inner = makeInnerBackend();
    const backend = new AuditingTaskBackend(inner, 'proj-1');

    await backend.updateStatus('notion:xyz', '✅ Done');

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ source: 'orchestrator' }),
      }),
    );
  });
});
