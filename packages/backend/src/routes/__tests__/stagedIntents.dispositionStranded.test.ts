/**
 * The stranded-intent disposition escape hatch: an ops session that
 * discovers a staged intent left behind by a *different* session that has
 * since terminated can clear it, instead of the only route being
 * gate-state-client.mjs-style device-authed tooling a dispatched session's
 * environment doesn't carry. Opposite authorization shape from
 * withdrawIntent (own-session-only): authorized because the owning session
 * is terminal, never because it matches the caller.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

const { mockGetTaskBackend } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { insertSession, updateSessionStatus } from '../../db/queries';
import {
  stageIntent,
  dispositionStrandedIntent,
  StrandedIntentDispositionError,
} from '../stagedIntents';

function seedSession(
  sessionId: string,
  status: 'running' | 'done' | 'error' | 'killed' = 'running',
  taskId: string | null = 'task-1',
) {
  insertSession({
    session_id: sessionId,
    task_id: taskId,
    task_url: null,
    project_context_url: null,
    status: 'running',
    started_at: 0,
    session_type: 'ops',
    note: null,
    tags: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    compaction_count: 0,
    context_occupancy_tokens: 0,
    task_name: null,
    metadata: null,
    review_result: null,
    pause_reason: null,
    last_error_detail: null,
    events_pruned_at: null,
    granted_capabilities: '[]',
  });
  if (status !== 'running') {
    updateSessionStatus(sessionId, status);
  }
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockGetTaskBackend.mockReturnValue({
    type: 'notion',
    fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    setDependsOn: vi.fn().mockResolvedValue(undefined),
  });
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM sessions').run();
});

describe('dispositionStrandedIntent', () => {
  it('supersedes an intent whose owning session has terminated and is not the caller', () => {
    seedSession('dead-sess', 'done');
    seedSession('ops-sess', 'running');
    const intent = stageIntent(
      'task.setProperties',
      { taskId: 'task-1', patch: { priority: 'High' } },
      'proj-1',
      null,
      'dead-sess',
    );

    const dispositioned = dispositionStrandedIntent(
      intent.id,
      'owning session died mid-verification, clearing the wedged intent',
      'ops-sess',
    );

    expect(dispositioned.state).toBe('superseded');
    expect(dispositioned.dispositionReason).toBe(
      'owning session died mid-verification, clearing the wedged intent',
    );
  });

  it('refuses an intent whose owning session is still live', () => {
    seedSession('live-sess', 'running');
    seedSession('ops-sess', 'running');
    const intent = stageIntent(
      'task.setProperties',
      { taskId: 'task-1', patch: { priority: 'High' } },
      'proj-1',
      null,
      'live-sess',
    );

    expect(() =>
      dispositionStrandedIntent(intent.id, 'not actually stranded', 'ops-sess'),
    ).toThrow(StrandedIntentDispositionError);
  });

  it('handles each terminal session status (error, killed), not just done', () => {
    seedSession('ops-sess', 'running');
    for (const status of ['error', 'killed'] as const) {
      seedSession(`dead-${status}`, status);
      const intent = stageIntent(
        'task.setProperties',
        { taskId: 'task-1', patch: { priority: 'High' } },
        'proj-1',
        null,
        `dead-${status}`,
      );

      const dispositioned = dispositionStrandedIntent(
        intent.id,
        `owning session reached ${status}`,
        'ops-sess',
      );
      expect(dispositioned.state).toBe('superseded');
    }
  });

  it('hops a pending_verification intent through needs_revision to reach superseded', () => {
    seedSession('dead-sess', 'done');
    seedSession('ops-sess', 'running');
    const intent = stageIntent(
      'task.setProperties',
      { taskId: 'task-1', patch: { priority: 'High' } },
      'proj-1',
      null,
      'dead-sess',
    );
    db.prepare(
      `UPDATE staged_intent SET state = 'pending_verification' WHERE id = ?`,
    ).run(intent.id);

    const dispositioned = dispositionStrandedIntent(
      intent.id,
      'wedged mid-verify, owning session gone',
      'ops-sess',
    );

    expect(dispositioned.state).toBe('superseded');
  });

  it('requires a non-empty reason', () => {
    seedSession('dead-sess', 'done');
    const intent = stageIntent(
      'task.setProperties',
      { taskId: 'task-1', patch: { priority: 'High' } },
      'proj-1',
      null,
      'dead-sess',
    );

    expect(() =>
      dispositionStrandedIntent(intent.id, '   ', 'ops-sess'),
    ).toThrow(StrandedIntentDispositionError);
  });

  it('rejects an intent that is not found', () => {
    expect(() =>
      dispositionStrandedIntent('does-not-exist', 'reason', 'ops-sess'),
    ).toThrow(StrandedIntentDispositionError);
  });

  it('rejects re-dispositioning an already-terminal intent', () => {
    seedSession('dead-sess', 'done');
    seedSession('ops-sess', 'running');
    const intent = stageIntent(
      'task.setProperties',
      { taskId: 'task-1', patch: { priority: 'High' } },
      'proj-1',
      null,
      'dead-sess',
    );
    dispositionStrandedIntent(intent.id, 'first pass', 'ops-sess');

    expect(() =>
      dispositionStrandedIntent(intent.id, 'second pass', 'ops-sess'),
    ).toThrow(StrandedIntentDispositionError);
  });
});
