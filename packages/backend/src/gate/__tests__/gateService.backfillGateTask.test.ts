/**
 * Tests for gateService.backfillGateTask — the entry point that fetches a
 * Gate task's live body via TaskBackend and hands it to
 * gateBackfill.backfillGateBody.
 *
 * AC: happy path mints gate_item rows from the fetched body; a re-run is
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
import { listByMilestoneAllProjects } from '../gateStore.js';
import { backfillGateTask } from '../gateService.js';

const GATE_BODY = `#### Add env var [notion:abc]\n- Verify the deploy script writes the new env var\n`;

function makeBackend(fetchTaskPage = vi.fn().mockResolvedValue(GATE_BODY)) {
  return { type: 'notion' as const, fetchTaskPage };
}

beforeEach(() => {
  db.prepare('DELETE FROM gate_item_event').run();
  db.prepare('DELETE FROM gate_item_source').run();
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM task_cache').run();
  mockGetTaskBackend.mockReset();
});

describe('backfillGateTask', () => {
  it('fetches the task body and mints gate_item rows', async () => {
    mockGetTaskBackend.mockReturnValue(makeBackend());
    upsertTaskCache(
      'notion:gate-task',
      JSON.stringify({ status: '🔲 Backlog' }),
    );

    const result = await backfillGateTask({
      project: 'polimarket-analyser',
      taskId: 'notion:gate-task',
      milestone: 'M11',
    });

    expect(result.created).toBe(1);
    expect(mockGetTaskBackend).toHaveBeenCalledWith('polimarket-analyser');
    expect(listByMilestoneAllProjects('M11')).toHaveLength(1);
  });

  it('is idempotent: re-running mints no duplicate rows', async () => {
    mockGetTaskBackend.mockReturnValue(makeBackend());
    upsertTaskCache(
      'notion:gate-task',
      JSON.stringify({ status: '🔲 Backlog' }),
    );

    const input = {
      project: 'polimarket-analyser',
      taskId: 'notion:gate-task',
      milestone: 'M11',
    };
    await backfillGateTask(input);
    const second = await backfillGateTask(input);

    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);
    expect(listByMilestoneAllProjects('M11')).toHaveLength(1);
  });

  it('throws a not-found error when fetchTaskPage fails', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend(vi.fn().mockRejectedValue(new Error('404 page not found'))),
    );

    await expect(
      backfillGateTask({
        project: 'polimarket-analyser',
        taskId: 'notion:missing',
        milestone: 'M11',
      }),
    ).rejects.toThrow(/not found/);
  });

  it('throws an already-started error when the task has left Backlog/Ready', async () => {
    mockGetTaskBackend.mockReturnValue(makeBackend());
    upsertTaskCache(
      'notion:gate-task',
      JSON.stringify({ status: '🔄 In Progress' }),
    );

    await expect(
      backfillGateTask({
        project: 'polimarket-analyser',
        taskId: 'notion:gate-task',
        milestone: 'M11',
      }),
    ).rejects.toThrow(/already started/);
  });
});
