/**
 * The planning.noOp decision-surface kind: a dispatched planning session's
 * deliberate declaration that a turn reached terminal with nothing to
 * change. Purely informational/auditable — no operator disposition is
 * offered for it (see StagedIntentPanel.tsx's isNoOp guard) — but it must
 * still be well-formed at stage time (see PlanningOrchestrator's
 * terminal-no-decision backstop, which treats it as "staged a decision").
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { stageIntent, KNOWN_INTENT_KINDS } from '../stagedIntents';

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
});

describe('planning.noOp decision-surface kind', () => {
  it('is a known intent kind', () => {
    expect(KNOWN_INTENT_KINDS.has('planning.noOp')).toBe(true);
  });

  it('stages with a taskId and a reason', () => {
    const intent = stageIntent(
      'planning.noOp',
      { taskId: 'task-1', reason: 'task is already Ready, nothing to add' },
      'proj-1',
      null,
      'sess-1',
    );
    expect(intent.state).toBe('staged');
    expect(intent.kind).toBe('planning.noOp');
    expect(intent.payload).toEqual({
      taskId: 'task-1',
      reason: 'task is already Ready, nothing to add',
    });
  });

  it('rejects at stage time when reason is missing, before any row is written', () => {
    expect(() =>
      stageIntent(
        'planning.noOp',
        { taskId: 'task-1' },
        'proj-1',
        null,
        'sess-2',
      ),
    ).toThrow(/reason.*required/i);

    const rows = db
      .prepare("SELECT * FROM staged_intent WHERE kind = 'planning.noOp'")
      .all();
    expect(rows).toHaveLength(0);
  });

  it('rejects at stage time when reason is blank', () => {
    expect(() =>
      stageIntent(
        'planning.noOp',
        { taskId: 'task-1', reason: '   ' },
        'proj-1',
        null,
        'sess-3',
      ),
    ).toThrow(/reason.*required/i);
  });

  it('rejects at stage time when taskId is missing', () => {
    expect(() =>
      stageIntent(
        'planning.noOp',
        { reason: 'nothing to change' },
        'proj-1',
        null,
        'sess-4',
      ),
    ).toThrow(/taskId is required/i);
  });

  it('accepts an optional skippedKind naming the intent kind this pass produced nothing of', () => {
    const intent = stageIntent(
      'planning.noOp',
      {
        taskId: 'task-1',
        reason: 'no implementation work beyond the locked decisions',
        skippedKind: 'task.create',
      },
      'proj-1',
      null,
      'sess-5',
    );
    expect(intent.state).toBe('staged');
    expect(intent.payload).toEqual({
      taskId: 'task-1',
      reason: 'no implementation work beyond the locked decisions',
      skippedKind: 'task.create',
    });
  });

  it('omitting skippedKind retains the existing whole-turn no-op semantics unchanged', () => {
    const intent = stageIntent(
      'planning.noOp',
      { taskId: 'task-1', reason: 'task is already Ready, nothing to add' },
      'proj-1',
      null,
      'sess-6',
    );
    expect(intent.payload).toEqual({
      taskId: 'task-1',
      reason: 'task is already Ready, nothing to add',
    });
  });

  it('still requires a non-empty reason when skippedKind is carried', () => {
    expect(() =>
      stageIntent(
        'planning.noOp',
        { taskId: 'task-1', skippedKind: 'task.create' },
        'proj-1',
        null,
        'sess-7',
      ),
    ).toThrow(/reason.*required/i);
  });

  it('rejects a blank skippedKind', () => {
    expect(() =>
      stageIntent(
        'planning.noOp',
        { taskId: 'task-1', reason: 'nothing to change', skippedKind: '   ' },
        'proj-1',
        null,
        'sess-8',
      ),
    ).toThrow(/skippedKind/i);
  });
});
