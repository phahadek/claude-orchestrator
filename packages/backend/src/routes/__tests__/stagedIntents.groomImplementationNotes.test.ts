/**
 * A groom session's mandate is validating a Backlog task's scope, size and
 * dependencies — never producing or recording the task's own deliverable.
 * task.patchBodySection targeting Implementation notes is "the implementing
 * session fills it" per the authoring standard: a design/ops session's
 * legitimate closing synthesis, and a groom session staging it instead is
 * exactly a groom executing (and recording) its target's work rather than
 * scoping it. Covers stageIntent's stage-time rejection and that every other
 * session type / every other section is unaffected.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { insertSession } from '../../db/queries';
import { stageIntent } from '../stagedIntents';

function seedSession(sessionId: string, sessionType: string) {
  insertSession({
    session_id: sessionId,
    task_id: 'task-1',
    task_url: null,
    project_context_url: null,
    status: 'idle',
    started_at: 0,
    session_type: sessionType,
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
}

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM sessions').run();
});

describe('task.patchBodySection — Implementation notes write, groom-scoped refusal', () => {
  it('is rejected when staged by a groom session', () => {
    seedSession('session-groom', 'groom');
    expect(() =>
      stageIntent(
        'task.patchBodySection',
        {
          taskId: 'task-1',
          section: 'Implementation notes',
          operation: 'replace',
          find: '> To be filled in during/after task completion.',
          replaceWith: 'Decided branch (b).',
        },
        'proj-1',
        null,
        'session-groom',
      ),
    ).toThrow(/Implementation notes/);
  });

  it('is rejected regardless of heading-text casing/whitespace', () => {
    seedSession('session-groom', 'groom');
    expect(() =>
      stageIntent(
        'task.patchBodySection',
        {
          taskId: 'task-1',
          section: '  implementation notes  ',
          operation: 'append',
          content: 'Decided branch (b).',
        },
        'proj-1',
        null,
        'session-groom',
      ),
    ).toThrow(/Implementation notes/);
  });

  it.each(['design', 'review'])(
    'is accepted when staged by a %s session',
    (sessionType) => {
      seedSession(`session-${sessionType}`, sessionType);
      const staged = stageIntent(
        'task.patchBodySection',
        {
          taskId: 'task-1',
          section: 'Implementation notes',
          operation: 'append',
          content: 'Closing synthesis.',
        },
        'proj-1',
        null,
        `session-${sessionType}`,
      );
      expect(staged.state).toBe('staged');
    },
  );

  it('is accepted when staged by an ops session (grouped, per the ops-terminal invariant)', () => {
    seedSession('session-ops', 'ops');
    const staged = stageIntent(
      'task.patchBodySection',
      {
        taskId: 'task-1',
        section: 'Implementation notes',
        operation: 'append',
        content: 'Closing synthesis.',
      },
      'proj-1',
      'group-1',
      'session-ops',
    );
    expect(staged.state).toBe('staged');
  });

  it('a groom session may still patch other sections, unaffected', () => {
    seedSession('session-groom', 'groom');
    const staged = stageIntent(
      'task.patchBodySection',
      {
        taskId: 'task-1',
        section: 'Context',
        operation: 'append',
        content: 'a scoping correction',
      },
      'proj-1',
      null,
      'session-groom',
    );
    expect(staged.state).toBe('staged');
  });

  it('a human/device-authenticated stage (no sessionId) is unaffected', () => {
    const staged = stageIntent(
      'task.patchBodySection',
      {
        taskId: 'task-1',
        section: 'Implementation notes',
        operation: 'append',
        content: 'manual note',
      },
      'proj-1',
    );
    expect(staged.state).toBe('staged');
  });
});
