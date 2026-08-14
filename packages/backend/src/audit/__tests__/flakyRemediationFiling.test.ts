/**
 * Tests for the remediation-route half of lane-side flaky disposition
 * (packages/backend/src/audit/flakyRemediationFiling.ts).
 *
 * AC:
 *  - crossing the threshold (2 distinct triggering PRs) with no currently-
 *    open linked task files exactly one new Code task, against the correct
 *    milestone.
 *  - a third+ distinct triggering PR while the filed task is still open
 *    files no additional task.
 *  - two auto-dispositions from the same PR count as one toward the
 *    threshold, not two.
 *  - once the linked task reaches a terminal status, a subsequent
 *    threshold-crossing files a fresh task.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const { createTaskMock } = vi.hoisted(() => ({
  createTaskMock: vi.fn(async () => 'notion:remediation-task-1'),
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
  upsertTaskCache,
  getFlakyRemediationTracking,
} from '../../db/queries.js';
import type { NotionTask } from '../../notion/types.js';
import {
  recordAndMaybeFileFlakyRemediation,
  closeFlakyRemediationTaskIfLinked,
} from '../flakyRemediationFiling.js';

const PROJECT = 'flaky-remediation-proj';
const MILESTONE_ROW_ID = 'flaky-remediation-proj:board-m1';
const MILESTONE_SOURCE_ID = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
const TRIGGERING_TASK_ID = 'notion:triggering-task-1';
const REPO = 'org/repo';

function notionTaskStub(id: string): NotionTask {
  return {
    id,
    title: 'Some task',
    status: '🔄 In Progress',
    type: '💻 Code',
    dependsOn: [],
    notionUrl: 'https://notion.so/x',
  };
}

beforeAll(() => {
  ProjectService.create({
    id: PROJECT,
    name: 'Flaky Remediation Test Project',
    projectDir: '/tmp/flaky-remediation-proj',
  });
  ProjectService.createMilestone({
    id: MILESTONE_ROW_ID,
    projectId: PROJECT,
    name: 'M1',
    canonicalShortId: 'M1',
    sourceId: MILESTONE_SOURCE_ID,
  });
  upsertTaskCache(
    `board:${MILESTONE_ROW_ID}`,
    JSON.stringify([notionTaskStub(TRIGGERING_TASK_ID)]),
  );
});

beforeEach(() => {
  db.prepare('DELETE FROM flaky_remediation_tracking').run();
  db.prepare('DELETE FROM flaky_remediation_pr_counts').run();
  db.prepare('DELETE FROM audit_log').run();
  createTaskMock.mockClear();
  createTaskMock.mockResolvedValue('notion:remediation-task-1');
});

function trigger(testId: string, prNumber: number) {
  return recordAndMaybeFileFlakyRemediation({
    projectId: PROJECT,
    testId,
    testName: 'some test',
    prNumber,
    repo: REPO,
    triggeringTaskId: TRIGGERING_TASK_ID,
  });
}

describe('recordAndMaybeFileFlakyRemediation', () => {
  it('files exactly one Code task against the correct milestone once 2 distinct PRs cross the threshold', async () => {
    const first = await trigger('test-a', 101);
    expect(first.filed).toBe(false);
    expect(createTaskMock).not.toHaveBeenCalled();

    const second = await trigger('test-a', 102);
    expect(second.filed).toBe(true);
    expect(second.taskId).toBe('notion:remediation-task-1');
    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseId: MILESTONE_SOURCE_ID,
        type: '💻 Code',
      }),
    );

    const tracking = getFlakyRemediationTracking('test-a');
    expect(tracking?.remediation_task_open).toBe(1);
    expect(tracking?.remediation_task_id).toBe('notion:remediation-task-1');
    expect(tracking?.auto_disposition_count).toBe(2);
  });

  it('files no additional task for a third+ distinct triggering PR while the filed task is still open', async () => {
    await trigger('test-b', 201);
    await trigger('test-b', 202);
    expect(createTaskMock).toHaveBeenCalledTimes(1);

    const third = await trigger('test-b', 203);
    expect(third.filed).toBe(false);
    expect(third.reason).toBe('already-open');
    expect(createTaskMock).toHaveBeenCalledTimes(1);

    const tracking = getFlakyRemediationTracking('test-b');
    expect(tracking?.auto_disposition_count).toBe(3);
  });

  it('counts two auto-dispositions from the same PR as one toward the threshold', async () => {
    const first = await trigger('test-c', 301);
    expect(first.filed).toBe(false);
    expect(first.reason).toBe('below-threshold');

    // Same PR retriggers (force-push retriggering f2) — must not alone cross the threshold.
    const retry = await trigger('test-c', 301);
    expect(retry.filed).toBe(false);
    expect(retry.reason).toBe('already-counted-for-pr');
    expect(createTaskMock).not.toHaveBeenCalled();

    const tracking = getFlakyRemediationTracking('test-c');
    expect(tracking?.auto_disposition_count).toBe(1);

    const second = await trigger('test-c', 302);
    expect(second.filed).toBe(true);
    expect(createTaskMock).toHaveBeenCalledTimes(1);
  });

  it('files a fresh task once the previously linked task reaches a terminal status', async () => {
    await trigger('test-d', 401);
    const filed = await trigger('test-d', 402);
    expect(filed.filed).toBe(true);
    expect(createTaskMock).toHaveBeenCalledTimes(1);

    // A further threshold-crossing while the task is still open files nothing.
    await trigger('test-d', 403);
    expect(createTaskMock).toHaveBeenCalledTimes(1);

    closeFlakyRemediationTaskIfLinked(
      'notion:remediation-task-1',
      new Date(1).toISOString(),
    );
    const closed = getFlakyRemediationTracking('test-d');
    expect(closed?.remediation_task_open).toBe(0);

    createTaskMock.mockResolvedValueOnce('notion:remediation-task-2');
    const fresh = await trigger('test-d', 404);
    expect(fresh.filed).toBe(true);
    expect(fresh.taskId).toBe('notion:remediation-task-2');
    expect(createTaskMock).toHaveBeenCalledTimes(2);
  });

  it('never double-files when two threshold-crossing calls race concurrently for the same test_id', async () => {
    // Pre-seed the count to 1 so both concurrent calls land on the exact
    // same threshold-crossing PR-count transition (1 -> 2), maximizing the
    // TOCTOU window between the dedup check and the eventual createTask call.
    await trigger('test-e', 501);
    createTaskMock.mockClear();

    let resolveCreate: (id: string) => void;
    createTaskMock.mockImplementationOnce(
      () => new Promise((resolve) => (resolveCreate = resolve)),
    );

    const raceA = trigger('test-e', 502);
    const raceB = trigger('test-e', 503);

    // Let both calls reach their claim attempt before the in-flight
    // createTask resolves — only one should have won the claim.
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveCreate!('notion:remediation-task-race');

    const [resultA, resultB] = await Promise.all([raceA, raceB]);
    const filedResults = [resultA, resultB].filter((r) => r.filed);
    expect(filedResults).toHaveLength(1);
    expect(createTaskMock).toHaveBeenCalledTimes(1);

    const tracking = getFlakyRemediationTracking('test-e');
    expect(tracking?.remediation_task_open).toBe(1);
    expect(tracking?.remediation_task_id).toBe('notion:remediation-task-race');
  });

  it('swallows a createTask failure, releases the claim, and lets a later call retry', async () => {
    await trigger('test-f', 601);
    createTaskMock.mockRejectedValueOnce(new Error('Notion API timeout'));

    const failed = await trigger('test-f', 602);
    expect(failed.filed).toBe(false);
    expect(failed.reason).toBe('create-task-failed');

    const tracking = getFlakyRemediationTracking('test-f');
    expect(tracking?.remediation_task_open).toBe(0);
    expect(tracking?.remediation_task_id).toBeNull();

    createTaskMock.mockResolvedValueOnce('notion:remediation-task-retry');
    const retried = await trigger('test-f', 603);
    expect(retried.filed).toBe(true);
    expect(retried.taskId).toBe('notion:remediation-task-retry');
  });
});
