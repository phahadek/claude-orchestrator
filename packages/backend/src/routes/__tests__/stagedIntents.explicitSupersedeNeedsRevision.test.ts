/**
 * Tests for the explicit-supersedes path of stageIntent (routes/stagedIntents.ts)
 * when the pointer names an intent that stage-time validation has already
 * moved to needs_revision. Before this fix explicitValid only accepted
 * ACTIVE_STATES (staged/approved), so a correction re-staged with
 * `supersedes` pointing at the exact needs_revision row it was fixing was
 * silently discarded: the caller got back `supersedes: null`, a fresh
 * unlinked intent was inserted, and the blocked original was orphaned in the
 * group forever.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import {
  stageIntent,
  ExplicitSupersedesError,
} from '../stagedIntents.js';
import { getStagedIntent, transitionStagedIntent } from '../../db/queries.js';

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

/** Drives a fresh `staged` intent through the stage-time-block path to needs_revision. */
function moveToNeedsRevision(id: string): void {
  transitionStagedIntent(id, 'pending_verification');
  transitionStagedIntent(id, 'needs_revision');
}

describe('stageIntent — explicit supersedes targeting a needs_revision intent', () => {
  it('supersedes a needs_revision target: persisted supersedes points at it, and it transitions out of needs_revision', () => {
    const blocked = stageIntent(
      'task.setStatus',
      { taskId: 't-1', status: 'Ready' },
      'proj-1',
      'group-1',
      'session-1',
    );
    moveToNeedsRevision(blocked.id);
    expect(getStagedIntent(blocked.id)!.state).toBe('needs_revision');

    const corrected = stageIntent(
      'task.setStatus',
      { taskId: 't-1', status: 'Backlog' },
      'proj-1',
      'group-1',
      'session-1',
      null,
      null,
      blocked.id,
    );

    // Assert against the persisted rows, not just the returned object.
    const persistedNew = getStagedIntent(corrected.id)!;
    expect(persistedNew.supersedes).toBe(blocked.id);
    expect(corrected.supersedes).toBe(persistedNew.supersedes);

    const persistedOld = getStagedIntent(blocked.id)!;
    expect(persistedOld.state).toBe('superseded');
    expect(persistedOld.state).not.toBe('needs_revision');
  });

  it('an explicit supersedes naming a staged intent still works (no regression)', () => {
    const first = stageIntent(
      'task.setStatus',
      { taskId: 't-2', status: 'Ready' },
      'proj-1',
      'group-1',
      'session-1',
    );
    expect(getStagedIntent(first.id)!.state).toBe('staged');

    const second = stageIntent(
      'task.setStatus',
      { taskId: 't-2', status: 'Backlog' },
      'proj-1',
      'group-1',
      'session-1',
      null,
      null,
      first.id,
    );

    expect(getStagedIntent(second.id)!.supersedes).toBe(first.id);
    expect(getStagedIntent(first.id)!.state).toBe('superseded');
  });

  it('an explicit supersedes naming an approved intent still works (no regression)', () => {
    const first = stageIntent(
      'task.setStatus',
      { taskId: 't-3', status: 'Ready' },
      'proj-1',
      'group-1',
      'session-1',
    );
    transitionStagedIntent(first.id, 'approved');

    const second = stageIntent(
      'task.setStatus',
      { taskId: 't-3', status: 'Backlog' },
      'proj-1',
      'group-1',
      'session-1',
      null,
      null,
      first.id,
    );

    expect(getStagedIntent(second.id)!.supersedes).toBe(first.id);
    expect(getStagedIntent(first.id)!.state).toBe('superseded');
  });

  it('an explicit supersedes naming an unknown id throws rather than silently persisting null', () => {
    expect(() =>
      stageIntent(
        'task.setStatus',
        { taskId: 't-4', status: 'Ready' },
        'proj-1',
        'group-1',
        'session-1',
        null,
        null,
        'no-such-intent-id',
      ),
    ).toThrow(ExplicitSupersedesError);

    // Nothing landed as an unlinked fresh row.
    const rows = db
      .prepare('SELECT * FROM staged_intent WHERE task_id = ?')
      .all('t-4');
    expect(rows.length).toBe(0);
  });

  it('an explicit supersedes naming a different kind throws', () => {
    const first = stageIntent(
      'task.setDependsOn',
      { taskId: 't-5', dependsOn: [] },
      'proj-1',
      'group-1',
      'session-1',
    );

    expect(() =>
      stageIntent(
        'task.setStatus',
        { taskId: 't-5', status: 'Ready' },
        'proj-1',
        'group-1',
        'session-1',
        null,
        null,
        first.id,
      ),
    ).toThrow(ExplicitSupersedesError);
  });

  it('an explicit supersedes naming a different session throws', () => {
    const first = stageIntent(
      'task.setStatus',
      { taskId: 't-6', status: 'Ready' },
      'proj-1',
      'group-1',
      'session-1',
    );

    expect(() =>
      stageIntent(
        'task.setStatus',
        { taskId: 't-6', status: 'Backlog' },
        'proj-1',
        'group-1',
        'session-2',
        null,
        null,
        first.id,
      ),
    ).toThrow(ExplicitSupersedesError);
  });

  it('an explicit supersedes naming an already-terminal (rejected) intent throws', () => {
    const first = stageIntent(
      'task.setStatus',
      { taskId: 't-7', status: 'Ready' },
      'proj-1',
      'group-1',
      'session-1',
    );
    transitionStagedIntent(first.id, 'rejected');

    expect(() =>
      stageIntent(
        'task.setStatus',
        { taskId: 't-7', status: 'Backlog' },
        'proj-1',
        'group-1',
        'session-1',
        null,
        null,
        first.id,
      ),
    ).toThrow(ExplicitSupersedesError);
  });

  it('the implicit payload-hash lookup still ignores needs_revision rows — a blocked intent is not resurrected as an implicit target', () => {
    const blocked = stageIntent(
      'task.setStatus',
      { taskId: 't-8', status: 'Ready' },
      'proj-1',
      'group-1',
      'session-1',
    );
    moveToNeedsRevision(blocked.id);

    // Re-emitting the identical payload with no explicit pointer must not
    // find the needs_revision row as an "existing" match of any kind — it
    // should land as a brand-new, unlinked staged intent.
    const fresh = stageIntent(
      'task.setStatus',
      { taskId: 't-8', status: 'Ready' },
      'proj-1',
      'group-1',
      'session-1',
    );

    expect(fresh.id).not.toBe(blocked.id);
    expect(fresh.supersedes).toBeNull();
    expect(getStagedIntent(blocked.id)!.state).toBe('needs_revision');
  });
});
