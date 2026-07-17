/**
 * Tests for seedService.backfillSeedTask — the entry point that fetches a
 * config-seed task's live body via TaskBackend and hands it to
 * seedBackfill.backfillConfigSeedTask.
 *
 * AC: happy path mints seed_item rows from the fetched body; a re-run is
 * idempotent (no duplicate rows, existing hash guard); a fetchTaskPage
 * failure surfaces as a not-found error; a task whose cached status has left
 * Backlog/Ready surfaces as an already-started error.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const { mockGetTaskBackend } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend.js', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

import { db } from '../../db/db.js';
import { upsertTaskCache } from '../../db/queries.js';
import { listByMilestoneAllProjects } from '../seedStore.js';
import { backfillSeedTask } from '../seedService.js';

const SEED_BODY = `#### Add config knob [notion:xyz]\n- feature_flag: new_pricing_tier = true\n`;

function makeBackend(fetchTaskPage = vi.fn().mockResolvedValue(SEED_BODY)) {
  return { type: 'notion' as const, fetchTaskPage };
}

beforeEach(() => {
  db.prepare('DELETE FROM seed_item_event').run();
  db.prepare('DELETE FROM seed_item_source').run();
  db.prepare('DELETE FROM seed_item').run();
  db.prepare('DELETE FROM task_cache').run();
  mockGetTaskBackend.mockReset();
});

describe('backfillSeedTask', () => {
  it('fetches the task body and mints seed_item rows', async () => {
    mockGetTaskBackend.mockReturnValue(makeBackend());
    upsertTaskCache(
      'notion:seed-task',
      JSON.stringify({ status: '🔲 Backlog' }),
    );

    const result = await backfillSeedTask({
      project: 'polimarket-analyser',
      taskId: 'notion:seed-task',
      milestone: 'M11',
    });

    expect(result.createdIds).toHaveLength(1);
    expect(mockGetTaskBackend).toHaveBeenCalledWith('polimarket-analyser');
    expect(listByMilestoneAllProjects('M11')).toHaveLength(1);
  });

  it('is idempotent: re-running mints no duplicate rows', async () => {
    mockGetTaskBackend.mockReturnValue(makeBackend());
    upsertTaskCache(
      'notion:seed-task',
      JSON.stringify({ status: '🔲 Backlog' }),
    );

    const input = {
      project: 'polimarket-analyser',
      taskId: 'notion:seed-task',
      milestone: 'M11',
    };
    await backfillSeedTask(input);
    const second = await backfillSeedTask(input);

    expect(second.createdIds).toHaveLength(0);
    expect(second.skippedIds).toHaveLength(1);
    expect(listByMilestoneAllProjects('M11')).toHaveLength(1);
  });

  it('throws a not-found error when fetchTaskPage fails', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend(vi.fn().mockRejectedValue(new Error('404 page not found'))),
    );

    await expect(
      backfillSeedTask({
        project: 'polimarket-analyser',
        taskId: 'notion:missing',
        milestone: 'M11',
      }),
    ).rejects.toThrow(/not found/);
  });

  it('throws an already-started error when the task has left Backlog/Ready', async () => {
    mockGetTaskBackend.mockReturnValue(makeBackend());
    upsertTaskCache('notion:seed-task', JSON.stringify({ status: '✅ Done' }));

    await expect(
      backfillSeedTask({
        project: 'polimarket-analyser',
        taskId: 'notion:seed-task',
        milestone: 'M11',
      }),
    ).rejects.toThrow(/already started/);
  });
});
