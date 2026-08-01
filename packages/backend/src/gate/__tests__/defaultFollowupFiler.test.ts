/**
 * Tests for gateReconciler's defaultFollowupFiler — the follow-up-task
 * filer a failing gate verification uses to resolve the Notion database id
 * for the fix task it creates. Regression coverage for the hand-rolled
 * board lookup (project.boards.find(...) ?? project.boardId) that could
 * never match gate_item.milestone (a canonical short id like 'M13') and
 * whose fallback (project.boardId) was not a Notion database id at all —
 * see resolveMilestoneDatabaseId in projects/milestoneResolver.ts.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const { createTaskMock } = vi.hoisted(() => ({
  createTaskMock: vi.fn(async () => 'notion:new-followup-task'),
}));
vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    type: 'notion',
    createTask: createTaskMock,
  }),
}));

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { insertItem } from '../gateStore.js';
import { defaultFollowupFiler } from '../gateReconciler.js';
import { ProjectService } from '../../projects/ProjectService.js';
import { UnknownMilestoneError } from '../../projects/milestoneResolver.js';

// M13's row id deliberately mirrors the legacy composite id-space
// (`<projectId>:<notionBoardId>`) production milestones M1-M3 carry — the
// same value the retired boardId fallback silently handed to createTask as
// a Notion database id. gate_item.milestone stores the canonical short id
// ('M13'), never this row id, so a test that reused the same value on both
// sides couldn't tell the fixed resolver apart from the retired lookup.
const M13_ROW_ID = 'defaultfollowupfiler-proj:legacyboard13';
const M13_SOURCE_ID = 'db00d3a1-aaaa-bbbb-cccc-1234567890ab';

beforeAll(() => {
  ProjectService.create({
    id: 'defaultfollowupfiler-proj',
    name: 'defaultFollowupFiler Test Project',
    projectDir: '/tmp/defaultfollowupfiler-proj',
  });
  ProjectService.createMilestone({
    id: M13_ROW_ID,
    projectId: 'defaultfollowupfiler-proj',
    name: 'M13',
    canonicalShortId: 'M13',
    sourceId: M13_SOURCE_ID,
  });
  ProjectService.createMilestone({
    id: 'defaultfollowupfiler-proj:legacyboard14',
    projectId: 'defaultfollowupfiler-proj',
    name: 'M14',
    canonicalShortId: 'M14',
    sourceId: null,
  });
});

beforeEach(() => {
  db.prepare('DELETE FROM gate_item_event').run();
  db.prepare('DELETE FROM gate_item_source').run();
  db.prepare('DELETE FROM gate_item').run();
  createTaskMock.mockClear();
});

function makeItem(overrides: Partial<Parameters<typeof insertItem>[0]> = {}) {
  return insertItem({
    project: 'defaultfollowupfiler-proj',
    milestone: 'M13',
    text: 'Verify the deploy script writes the new env var',
    classification: 'Read-Only',
    sources: [{ sourceTaskId: 'notion:abc', sourceTaskTitle: 'Add env var' }],
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  });
}

describe('defaultFollowupFiler.fileFollowupFixTask', () => {
  it('resolves the database id via resolveMilestoneDatabaseId for a canonical-short-id milestone and passes it to createTask', async () => {
    const item = makeItem();

    const result = await defaultFollowupFiler.fileFollowupFixTask(
      item,
      { disposition: 'fail' },
    );

    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseId: M13_SOURCE_ID,
        title: expect.stringContaining(item.text),
        type: '💻 Code',
      }),
    );
    expect(result.taskId).toBe('notion:new-followup-task');
  });

  it('throws UnknownMilestoneError — not project.boardId — for a milestone that does not resolve, and never calls createTask', async () => {
    const item = makeItem({ milestone: 'not-a-real-milestone' });

    await expect(
      defaultFollowupFiler.fileFollowupFixTask(item, { disposition: 'fail' }),
    ).rejects.toBeInstanceOf(UnknownMilestoneError);
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('throws UnknownMilestoneError for a resolved milestone with no source_id, and never calls createTask', async () => {
    const item = makeItem({ milestone: 'M14' });

    await expect(
      defaultFollowupFiler.fileFollowupFixTask(item, { disposition: 'fail' }),
    ).rejects.toBeInstanceOf(UnknownMilestoneError);
    expect(createTaskMock).not.toHaveBeenCalled();
  });
});
