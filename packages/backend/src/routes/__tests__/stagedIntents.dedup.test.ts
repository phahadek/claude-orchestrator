/**
 * Tests for the content-idempotent banked-approval dedup path of
 * stageIntent (routes/stagedIntents.ts): a re-emission identical to a
 * standing staged/approved intent is a no-op that preserves it; a
 * differing re-emission supersedes it and re-enters `staged`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { stageIntent } from '../stagedIntents.js';
import { transitionStagedIntent, getStagedIntent } from '../../db/queries.js';

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

describe('stageIntent — content-idempotent dedup', () => {
  it('an identical re-emission is a no-op that preserves a standing approval', () => {
    const first = stageIntent(
      'task.setStatus',
      { taskId: 't-1', status: 'Ready' },
      'proj-1',
      'group-1',
    );
    transitionStagedIntent(first.id, 'approved');

    const second = stageIntent(
      'task.setStatus',
      { taskId: 't-1', status: 'Ready' },
      'proj-1',
      'group-2',
    );

    expect(second.id).toBe(first.id);
    expect(second.state).toBe('approved');
    expect(getStagedIntent(first.id)!.state).toBe('approved');
  });

  it('a differing re-emission supersedes the standing intent and re-opens staged', () => {
    const first = stageIntent(
      'task.setStatus',
      { taskId: 't-1', status: 'Ready' },
      'proj-1',
      'group-1',
    );
    transitionStagedIntent(first.id, 'approved');

    const second = stageIntent(
      'task.setStatus',
      { taskId: 't-1', status: 'Backlog' },
      'proj-1',
      'group-2',
    );

    expect(second.id).not.toBe(first.id);
    expect(second.state).toBe('staged');
    expect(second.supersedes).toBe(first.id);
    expect(getStagedIntent(first.id)!.state).toBe('superseded');
  });

  it('task.create never dedups — every stage is a fresh intent', () => {
    const first = stageIntent('task.create', { title: 'New task' }, 'proj-1');
    const second = stageIntent('task.create', { title: 'New task' }, 'proj-1');

    expect(second.id).not.toBe(first.id);
  });
});
