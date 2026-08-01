/**
 * A caller-supplied milestone on a staged intent must be normalized through
 * resolveMilestoneForProject before it reaches the row — otherwise a DB UUID
 * or display name spawns a shadow key-space the milestone decision panel
 * never queries (it only ever queries by canonical short id). Covers both
 * write sites in stageIntent: the fresh-row path (routes/stagedIntents.ts
 * :2504-ish) and the supersede path (:2475-ish), which has its own
 * `milestone ?? existing.milestone ?? null` fallback.
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

const projectServiceMock = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock('../../projects/ProjectService', () => ({
  ProjectService: projectServiceMock,
}));

import { db } from '../../db/db.js';
import { stageIntent } from '../stagedIntents.js';
import { getStagedIntent } from '../../db/queries.js';
import { UnknownMilestoneError } from '../../projects/milestoneResolver.js';

const M13 = {
  id: '42eb1ff4-4dab-4274-8b54-96d3d260f4f3',
  name: 'M13 — Orchestrator-Owned Planning',
  canonicalShortId: 'M13',
};
const M14 = {
  id: 'ms-uuid-14',
  name: 'M14',
  canonicalShortId: 'M14',
};

beforeEach(() => {
  mockRecordEvent.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  projectServiceMock.getById.mockReset();
  projectServiceMock.getById.mockReturnValue({
    id: 'proj-1',
    milestones: [M13, M14],
  });
});

describe('stageIntent — caller-supplied milestone normalization', () => {
  it('normalizes a milestone DB UUID to the canonical short id', () => {
    const intent = stageIntent(
      'task.create',
      { title: 'Task A' },
      'proj-1',
      null,
      'session-1',
      null,
      null,
      null,
      M13.id,
    );
    expect(intent.milestone).toBe('M13');
    expect(getStagedIntent(intent.id)!.milestone).toBe('M13');
  });

  it('normalizes a milestone full display name to the canonical short id', () => {
    const intent = stageIntent(
      'task.create',
      { title: 'Task B' },
      'proj-1',
      null,
      'session-1',
      null,
      null,
      null,
      M13.name,
    );
    expect(intent.milestone).toBe('M13');
  });

  it('leaves an already-canonical short id unchanged (no double-resolution failure)', () => {
    const intent = stageIntent(
      'task.create',
      { title: 'Task C' },
      'proj-1',
      null,
      'session-1',
      null,
      null,
      null,
      'M13',
    );
    expect(intent.milestone).toBe('M13');
  });

  it('keeps a null/omitted milestone as null', () => {
    const intent = stageIntent(
      'task.create',
      { title: 'Task D' },
      'proj-1',
      null,
      'session-1',
    );
    expect(intent.milestone).toBeNull();
    expect(getStagedIntent(intent.id)!.milestone).toBeNull();
  });

  it('rejects an unresolvable milestone at stage time, naming the known milestones', () => {
    expect(() =>
      stageIntent(
        'task.create',
        { title: 'Task E' },
        'proj-1',
        null,
        'session-1',
        null,
        null,
        null,
        'not-a-real-milestone',
      ),
    ).toThrow(UnknownMilestoneError);
    try {
      stageIntent(
        'task.create',
        { title: 'Task E again' },
        'proj-1',
        null,
        'session-1',
        null,
        null,
        null,
        'not-a-real-milestone',
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownMilestoneError);
      expect((err as Error).message).toContain(M13.name);
      expect((err as Error).message).toContain(M14.name);
    }
  });

  it('does not persist an unresolvable milestone row', () => {
    const before = db
      .prepare('SELECT COUNT(*) as c FROM staged_intent')
      .get() as { c: number };
    expect(() =>
      stageIntent(
        'task.create',
        { title: 'Task F' },
        'proj-1',
        null,
        'session-1',
        null,
        null,
        null,
        'nonsense-milestone',
      ),
    ).toThrow(UnknownMilestoneError);
    const after = db
      .prepare('SELECT COUNT(*) as c FROM staged_intent')
      .get() as { c: number };
    expect(after.c).toBe(before.c);
  });

  it('normalizes on the supersede path the same way as the create path', () => {
    const first = stageIntent(
      'task.create',
      { title: 'Restaged task', dependsOn: [] },
      'proj-1',
      null,
      'session-1',
      null,
      null,
      null,
      'M13',
    );

    const second = stageIntent(
      'task.create',
      { title: 'Restaged task', dependsOn: ['proj-1-task-1'] },
      'proj-1',
      null,
      'session-1',
      null,
      null,
      null,
      M13.id,
    );

    expect(second.supersedes).toBe(first.id);
    expect(second.milestone).toBe('M13');
    expect(getStagedIntent(second.id)!.milestone).toBe('M13');
  });

  it('supersede path falls back to the existing row milestone, still canonical, when none is supplied', () => {
    const first = stageIntent(
      'task.create',
      { title: 'Restaged task 2', dependsOn: [] },
      'proj-1',
      null,
      'session-1',
      null,
      null,
      null,
      M13.id,
    );

    const second = stageIntent(
      'task.create',
      { title: 'Restaged task 2', dependsOn: ['proj-1-task-1'] },
      'proj-1',
      null,
      'session-1',
    );

    expect(second.supersedes).toBe(first.id);
    expect(second.milestone).toBe('M13');
  });

  it('leaves payload.milestone on task.create untouched — it identifies the target board, not the envelope milestone', () => {
    const intent = stageIntent(
      'task.create',
      { title: 'Task G', databaseId: 'db-1', milestone: M13.id },
      'proj-1',
      null,
      'session-1',
    );
    expect(intent.milestone).toBeNull();
    const stored = getStagedIntent(intent.id)!;
    const payload = JSON.parse(stored.payload);
    expect(payload.milestone).toBe(M13.id);
  });
});
