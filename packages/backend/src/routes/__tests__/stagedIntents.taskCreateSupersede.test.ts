/**
 * task.create (and arch.createUnit) have no pre-existing taskId to dedup on,
 * so a session that notices a mistake and re-stages a corrected draft
 * previously had no supersede path — duplicates piled up until an operator
 * declined them by hand. This covers the fix: within one session, a re-stage
 * of the same (normalized) title supersedes the prior draft; different
 * titles and different sessions each stay independently live.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRecordEvent } = vi.hoisted(() => ({
  mockRecordEvent: vi.fn(),
}));

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: mockRecordEvent,
}));

import { db } from '../../db/db.js';
import { stageIntent } from '../stagedIntents.js';
import { getStagedIntent } from '../../db/queries.js';

beforeEach(() => {
  mockRecordEvent.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

describe('stageIntent — task.create supersede-on-restage', () => {
  it('re-staging with the same title and a changed payload supersedes the prior intent', () => {
    const first = stageIntent(
      'task.create',
      { title: 'Fix the widget', dependsOn: ['bad-id'] },
      'proj-1',
      null,
      'session-1',
    );

    const second = stageIntent(
      'task.create',
      { title: '  Fix the Widget  ', dependsOn: ['proj-1-task-42'] },
      'proj-1',
      null,
      'session-1',
    );

    expect(second.id).not.toBe(first.id);
    expect(second.supersedes).toBe(first.id);
    expect(getStagedIntent(first.id)!.state).toBe('superseded');
    expect(getStagedIntent(second.id)!.state).toBe('staged');
  });

  it('re-staging with the same title and an identical payload hash is a no-op returning the existing row', () => {
    const first = stageIntent(
      'task.create',
      { title: 'Fix the widget', dependsOn: [] },
      'proj-1',
      null,
      'session-1',
    );

    const second = stageIntent(
      'task.create',
      { title: 'Fix the widget', dependsOn: [] },
      'proj-1',
      null,
      'session-1',
    );

    expect(second.id).toBe(first.id);
    expect(getStagedIntent(first.id)!.state).toBe('staged');
  });

  it('three different titles in one session all stay live', () => {
    const a = stageIntent(
      'task.create',
      { title: 'Task A' },
      'proj-1',
      null,
      'session-1',
    );
    const b = stageIntent(
      'task.create',
      { title: 'Task B' },
      'proj-1',
      null,
      'session-1',
    );
    const c = stageIntent(
      'task.create',
      { title: 'Task C' },
      'proj-1',
      null,
      'session-1',
    );

    expect(getStagedIntent(a.id)!.state).toBe('staged');
    expect(getStagedIntent(b.id)!.state).toBe('staged');
    expect(getStagedIntent(c.id)!.state).toBe('staged');
  });

  it('two sessions staging the same title each keep their own live intent', () => {
    const first = stageIntent(
      'task.create',
      { title: 'Shared title' },
      'proj-1',
      null,
      'session-1',
    );
    const second = stageIntent(
      'task.create',
      { title: 'Shared title' },
      'proj-1',
      null,
      'session-2',
    );

    expect(second.id).not.toBe(first.id);
    expect(getStagedIntent(first.id)!.state).toBe('staged');
    expect(getStagedIntent(second.id)!.state).toBe('staged');
  });

  it('a supersede emits no staged_intent_disposition audit event', () => {
    stageIntent(
      'task.create',
      { title: 'Fix the widget', dependsOn: ['bad-id'] },
      'proj-1',
      null,
      'session-1',
    );

    mockRecordEvent.mockClear();

    stageIntent(
      'task.create',
      { title: 'Fix the widget', dependsOn: ['proj-1-task-42'] },
      'proj-1',
      null,
      'session-1',
    );

    expect(mockRecordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'staged_intent_disposition' }),
    );
  });

  it('an explicit supersedes id retires the named intent even when the title changed', () => {
    const first = stageIntent(
      'task.create',
      { title: 'Original title' },
      'proj-1',
      null,
      'session-1',
    );

    const second = stageIntent(
      'task.create',
      { title: 'Corrected title' },
      'proj-1',
      null,
      'session-1',
      null,
      null,
      first.id,
    );

    expect(second.id).not.toBe(first.id);
    expect(second.supersedes).toBe(first.id);
    expect(getStagedIntent(first.id)!.state).toBe('superseded');
    expect(getStagedIntent(second.id)!.state).toBe('staged');
  });
});
