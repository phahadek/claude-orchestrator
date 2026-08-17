/**
 * routeStageTimeBlock's planning.noOp auto-resolve hook
 * (maybeAutoResolveCodeNoOp): a standard or ops session's standalone
 * planning.noOp — the terminal declaration that a dispatched task's work is
 * already satisfied elsewhere — commits itself immediately at stage time
 * (no operator Acknowledge required), drives the task to Done with the
 * resolving evidence recorded, and drives the staging session to a
 * distinct terminal status/reason. A groom/design no-op (still "nothing to
 * change this turn", not "already done") is untouched.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockGetTaskBackend } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { insertSession, getStagedIntent, getSession } from '../../db/queries';
import { stageIntent, routeStageTimeBlock } from '../stagedIntents';

// Seeded as 'idle' rather than 'running' — markSessionDone defers a
// running→done write until the in-flight turn drains (see its in-flight
// guard doc comment), same as every other completion path. Seeding idle
// (a resumed session concluding its no-op) isolates the auto-resolve
// behavior itself from that unrelated, already-covered deferral mechanism.
function seedSession(
  sessionId: string,
  overrides: Partial<{ task_id: string; session_type: string }> = {},
) {
  insertSession({
    session_id: sessionId,
    task_id: overrides.task_id ?? 'task-1',
    task_url: null,
    project_context_url: null,
    status: 'idle',
    started_at: 0,
    session_type: (overrides.session_type ?? 'standard') as never,
  });
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM sessions').run();
});

describe('planning.noOp auto-resolve at stage time', () => {
  it('auto-commits, closes the task Done with evidence, and terminates a standard session', async () => {
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    const appendImplementationNote = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      updateStatus,
      appendImplementationNote,
    });

    seedSession('sess-code-1', { task_id: 'task-1', session_type: 'standard' });
    const intent = stageIntent(
      'planning.noOp',
      {
        taskId: 'task-1',
        reason: 'already resolved by commit 95507034 on dev',
      },
      'proj-1',
      null,
      'sess-code-1',
    );

    const result = await routeStageTimeBlock(intent, undefined);

    expect(result.state).toBe('committed');
    expect(getStagedIntent(intent.id)?.state).toBe('committed');
    expect(updateStatus).toHaveBeenCalledWith('task-1', '✅ Done');
    expect(appendImplementationNote).toHaveBeenCalledWith(
      'task-1',
      expect.stringContaining('95507034'),
    );

    const session = getSession('sess-code-1');
    expect(session?.status).toBe('done');
    expect(session?.terminal_completion_reason).toBe('no_op_resolved');
  });

  it('does the same for an ops session', async () => {
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    const appendImplementationNote = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      updateStatus,
      appendImplementationNote,
    });

    seedSession('sess-ops-1', { task_id: 'task-2', session_type: 'ops' });
    const intent = stageIntent(
      'planning.noOp',
      { taskId: 'task-2', reason: 'already resolved by PR #42' },
      'proj-1',
      null,
      'sess-ops-1',
    );

    const result = await routeStageTimeBlock(intent, undefined);

    expect(result.state).toBe('committed');
    expect(updateStatus).toHaveBeenCalledWith('task-2', '✅ Done');
    expect(getSession('sess-ops-1')?.terminal_completion_reason).toBe(
      'no_op_resolved',
    );
  });

  it('leaves a groom session no-op untouched (still requires operator Acknowledge)', async () => {
    const updateStatus = vi.fn();
    mockGetTaskBackend.mockReturnValue({ type: 'notion', updateStatus });

    seedSession('sess-groom-1', { task_id: 'task-3', session_type: 'groom' });
    const intent = stageIntent(
      'planning.noOp',
      { taskId: 'task-3', reason: 'nothing to groom this turn' },
      'proj-1',
      null,
      'sess-groom-1',
    );

    const result = await routeStageTimeBlock(intent, undefined);

    expect(result.state).toBe('staged');
    expect(updateStatus).not.toHaveBeenCalled();
    expect(getSession('sess-groom-1')?.status).toBe('idle');
  });

  it('leaves a grouped planning.noOp untouched — it commits only via the group-commit path', async () => {
    const updateStatus = vi.fn();
    mockGetTaskBackend.mockReturnValue({ type: 'notion', updateStatus });

    seedSession('sess-code-grouped', {
      task_id: 'task-4',
      session_type: 'standard',
    });
    const intent = stageIntent(
      'planning.noOp',
      { taskId: 'task-4', reason: 'nothing else to add' },
      'proj-1',
      'g-1',
      'sess-code-grouped',
    );

    const result = await routeStageTimeBlock(intent, undefined);

    expect(result.state).toBe('staged');
    expect(updateStatus).not.toHaveBeenCalled();
  });
});
