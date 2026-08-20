/**
 * Tests for the operator-driven grouped Investigation filing route
 * (packages/backend/src/audit/flakyRemediationFiling.ts).
 *
 * AC:
 *  - a batch claim atomically claims a whole test_id[] set, all-or-nothing
 *    (rejects the whole batch on any conflict).
 *  - on a simulated backend.createTask failure after a successful batch
 *    claim, every claimed test_id is released back to open=0.
 *  - fileFlakyInvestigationTask files exactly one Investigation task at
 *    Backlog covering every valid selected test, rejects any test_id not
 *    currently flagged flaky or already tracked open, and links every
 *    covered test_id's tracking row to the created task.
 *  - closing a task linked to N tracking rows clears all N rows (N > 1).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const { createTaskMock } = vi.hoisted(() => ({
  createTaskMock: vi.fn(async () => 'notion:investigation-task-1'),
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
import { ProjectService } from '../../projects/ProjectService.js';
import {
  getFlakyRemediationTracking,
  tryClaimFlakyRemediationFilingBatch,
  setFlakyRemediationLinkedTask,
} from '../../db/queries.js';
import {
  fileFlakyInvestigationTask,
  closeFlakyRemediationTaskIfLinked,
  FlakyInvestigationFilingError,
} from '../flakyRemediationFiling.js';

const PROJECT = 'flaky-investigation-proj';
const MILESTONE_ROW_ID = 'flaky-investigation-proj:board-m1';
const MILESTONE_SOURCE_ID = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';

function insertRollupRow(testId: string, name = testId): void {
  db.prepare(
    `INSERT INTO flagged_flaky_tests_rollup
       (project_id, test_id, name, sample_count, transition_count, computed_at)
     VALUES (@project_id, @test_id, @name, @sample_count, @transition_count, @computed_at)`,
  ).run({
    project_id: PROJECT,
    test_id: testId,
    name,
    sample_count: 10,
    transition_count: 4,
    computed_at: 1700000000000,
  });
}

beforeAll(() => {
  ProjectService.create({
    id: PROJECT,
    name: 'Flaky Investigation Test Project',
    projectDir: '/tmp/flaky-investigation-proj',
  });
  ProjectService.createMilestone({
    id: MILESTONE_ROW_ID,
    projectId: PROJECT,
    name: 'M1',
    canonicalShortId: 'M1',
    sourceId: MILESTONE_SOURCE_ID,
  });
});

beforeEach(() => {
  db.prepare('DELETE FROM flaky_remediation_tracking').run();
  db.prepare('DELETE FROM flagged_flaky_tests_rollup').run();
  db.prepare('DELETE FROM audit_log').run();
  createTaskMock.mockClear();
  createTaskMock.mockResolvedValue('notion:investigation-task-1');
});

describe('tryClaimFlakyRemediationFilingBatch', () => {
  it('atomically claims a whole test_id[] set', () => {
    const ok = tryClaimFlakyRemediationFilingBatch(
      ['test-a', 'test-b', 'test-c'],
      new Date(1).toISOString(),
    );
    expect(ok).toBe(true);
    for (const id of ['test-a', 'test-b', 'test-c']) {
      expect(getFlakyRemediationTracking(id)?.remediation_task_open).toBe(1);
    }
  });

  it('rejects the whole batch when any test_id is already open — none of the batch is claimed', () => {
    setFlakyRemediationLinkedTask(
      'test-b',
      'notion:already-open-task',
      true,
      new Date(1).toISOString(),
    );

    const ok = tryClaimFlakyRemediationFilingBatch(
      ['test-a', 'test-b', 'test-c'],
      new Date(2).toISOString(),
    );
    expect(ok).toBe(false);

    // Rolled back in full — test-a and test-c must NOT have been claimed
    // even though they had no conflict of their own.
    expect(getFlakyRemediationTracking('test-a')).toBeUndefined();
    expect(getFlakyRemediationTracking('test-c')).toBeUndefined();
    expect(getFlakyRemediationTracking('test-b')?.remediation_task_id).toBe(
      'notion:already-open-task',
    );
  });
});

describe('fileFlakyInvestigationTask', () => {
  it('files exactly one Investigation task at Backlog covering every valid selected test, and links every tracking row', async () => {
    insertRollupRow('test-a');
    insertRollupRow('test-b');

    const result = await fileFlakyInvestigationTask({
      projectId: PROJECT,
      milestoneId: MILESTONE_ROW_ID,
      testIds: ['test-a', 'test-b'],
    });

    expect(result.taskId).toBe('notion:investigation-task-1');
    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseId: MILESTONE_SOURCE_ID,
        type: '🔎 Investigation',
        body: expect.stringContaining('test-a'),
      }),
    );
    const body = createTaskMock.mock.calls[0][0].body as string;
    expect(body).toContain('test-b');

    for (const id of ['test-a', 'test-b']) {
      const tracking = getFlakyRemediationTracking(id);
      expect(tracking?.remediation_task_open).toBe(1);
      expect(tracking?.remediation_task_id).toBe('notion:investigation-task-1');
    }
  });

  it('rejects a test_id not currently flagged flaky, before claiming anything', async () => {
    insertRollupRow('test-a');
    // 'test-z' is not in flagged_flaky_tests_rollup.

    await expect(
      fileFlakyInvestigationTask({
        projectId: PROJECT,
        milestoneId: MILESTONE_ROW_ID,
        testIds: ['test-a', 'test-z'],
      }),
    ).rejects.toMatchObject({ reason: 'not-flagged-flaky' });

    expect(createTaskMock).not.toHaveBeenCalled();
    expect(getFlakyRemediationTracking('test-a')).toBeUndefined();
  });

  it('rejects a test_id already tracked open', async () => {
    insertRollupRow('test-a');
    insertRollupRow('test-b');
    setFlakyRemediationLinkedTask(
      'test-b',
      'notion:other-open-task',
      true,
      new Date(1).toISOString(),
    );

    await expect(
      fileFlakyInvestigationTask({
        projectId: PROJECT,
        milestoneId: MILESTONE_ROW_ID,
        testIds: ['test-a', 'test-b'],
      }),
    ).rejects.toMatchObject({ reason: 'already-open' });

    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('releases every claimed test_id back to open=0 when backend.createTask fails', async () => {
    insertRollupRow('test-a');
    insertRollupRow('test-b');
    createTaskMock.mockRejectedValueOnce(new Error('Notion API timeout'));

    await expect(
      fileFlakyInvestigationTask({
        projectId: PROJECT,
        milestoneId: MILESTONE_ROW_ID,
        testIds: ['test-a', 'test-b'],
      }),
    ).rejects.toThrow('Notion API timeout');

    for (const id of ['test-a', 'test-b']) {
      const tracking = getFlakyRemediationTracking(id);
      expect(tracking?.remediation_task_open).toBe(0);
      expect(tracking?.remediation_task_id).toBeNull();
    }

    // A later retry succeeds normally.
    createTaskMock.mockResolvedValueOnce('notion:investigation-task-retry');
    const retried = await fileFlakyInvestigationTask({
      projectId: PROJECT,
      milestoneId: MILESTONE_ROW_ID,
      testIds: ['test-a', 'test-b'],
    });
    expect(retried.taskId).toBe('notion:investigation-task-retry');
  });

  it('rejects an unresolvable milestone', async () => {
    insertRollupRow('test-a');

    await expect(
      fileFlakyInvestigationTask({
        projectId: PROJECT,
        milestoneId: 'not-a-real-milestone',
        testIds: ['test-a'],
      }),
    ).rejects.toMatchObject({ reason: 'unknown-milestone' });

    expect(createTaskMock).not.toHaveBeenCalled();
    expect(getFlakyRemediationTracking('test-a')?.remediation_task_open).toBe(
      0,
    );
  });
});

describe('closeFlakyRemediationTaskIfLinked', () => {
  it('clears all N tracking rows linked to a closing task, N > 1', async () => {
    insertRollupRow('test-a');
    insertRollupRow('test-b');
    insertRollupRow('test-c');

    const filed = await fileFlakyInvestigationTask({
      projectId: PROJECT,
      milestoneId: MILESTONE_ROW_ID,
      testIds: ['test-a', 'test-b', 'test-c'],
    });

    closeFlakyRemediationTaskIfLinked(filed.taskId, new Date(2).toISOString());

    for (const id of ['test-a', 'test-b', 'test-c']) {
      const tracking = getFlakyRemediationTracking(id);
      expect(tracking?.remediation_task_open).toBe(0);
    }
  });

  it('is a no-op for a task id with no linked tracking rows', () => {
    expect(() =>
      closeFlakyRemediationTaskIfLinked(
        'notion:no-such-task',
        new Date(1).toISOString(),
      ),
    ).not.toThrow();
  });
});

// Sanity check that the error class carries a machine-readable reason for
// the route to map to an HTTP status.
describe('FlakyInvestigationFilingError', () => {
  it('carries the reason code', () => {
    const err = new FlakyInvestigationFilingError('not-flagged-flaky', 'x');
    expect(err.reason).toBe('not-flagged-flaky');
  });
});
