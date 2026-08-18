/**
 * Tests for the base-health remediation filer
 * (packages/backend/src/audit/baseHealthRemediationFiling.ts).
 *
 * AC:
 *  - the first confirmation of a set of base-failing test ids files exactly
 *    one Code task against the triggering task's milestone.
 *  - a second confirmation with a DIFFERENT content hash but the SAME (or
 *    overlapping) failing test ids files no duplicate while the first's
 *    remediation task remains open.
 *  - a partial_fail confirmation with zero failing test ids is never filed.
 *  - a single triggering task's repeated total_fail confirmations — even
 *    across a drifting failure_reason — file at most one remediation task.
 *  - once the linked task closes, a subsequent confirmation of the same
 *    identity files a fresh task (reopen-on-close).
 *  - two concurrent confirmations for overlapping test ids never both file
 *    for the overlap.
 *  - a createTask failure releases every claimed row so a later call can
 *    retry.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const { createTaskMock } = vi.hoisted(() => ({
  createTaskMock: vi.fn(async () => 'notion:base-remediation-task-1'),
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
  getBaseHealthRemediationTestTracking,
  getBaseHealthRemediationReasonTracking,
} from '../../db/queries.js';
import type { NotionTask } from '../../notion/types.js';
import {
  recordAndMaybeFileBaseHealthRemediation,
  closeBaseHealthRemediationTaskIfLinked,
} from '../baseHealthRemediationFiling.js';

const PROJECT = 'base-health-remediation-proj';
const MILESTONE_ROW_ID = 'base-health-remediation-proj:board-m1';
const MILESTONE_SOURCE_ID = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';
const TRIGGERING_TASK_ID = 'notion:triggering-task-1';

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
    name: 'Base Health Remediation Test Project',
    projectDir: '/tmp/base-health-remediation-proj',
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
  db.prepare('DELETE FROM base_health_remediation_test_tracking').run();
  db.prepare('DELETE FROM base_health_remediation_reason_tracking').run();
  db.prepare('DELETE FROM base_health_remediation_reason_counts').run();
  db.prepare('DELETE FROM audit_log').run();
  createTaskMock.mockClear();
  createTaskMock.mockResolvedValue('notion:base-remediation-task-1');
});

function partialFailTrigger(
  contentHash: string,
  failingTestIds: string[],
  triggeringTaskId: string | null = TRIGGERING_TASK_ID,
) {
  return recordAndMaybeFileBaseHealthRemediation({
    projectId: PROJECT,
    contentHash,
    outcome: 'partial_fail',
    failingTestIds,
    failureReason: null,
    triggeringTaskId,
  });
}

function totalFailTrigger(
  contentHash: string,
  failureReason: string | null,
  triggeringTaskId: string | null = TRIGGERING_TASK_ID,
) {
  return recordAndMaybeFileBaseHealthRemediation({
    projectId: PROJECT,
    contentHash,
    outcome: 'total_fail',
    failingTestIds: [],
    failureReason,
    triggeringTaskId,
  });
}

describe('recordAndMaybeFileBaseHealthRemediation — partial_fail', () => {
  it('files exactly one Code task against the correct milestone on first confirmation', async () => {
    const first = await partialFailTrigger('hash-a', ['suite.testA']);
    expect(first.filed).toBe(true);
    expect(first.taskId).toBe('notion:base-remediation-task-1');
    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseId: MILESTONE_SOURCE_ID,
        type: '💻 Code',
      }),
    );

    const tracking = getBaseHealthRemediationTestTracking(
      PROJECT,
      'suite.testA',
    );
    expect(tracking?.remediation_task_open).toBe(1);
    expect(tracking?.remediation_task_id).toBe(
      'notion:base-remediation-task-1',
    );
  });

  it('does not double-file when a later confirmation has a different content hash but the same failing test ids', async () => {
    const first = await partialFailTrigger('hash-b1', ['suite.testB']);
    expect(first.filed).toBe(true);

    // Same test id, but the base tree's content hash has changed (e.g. an
    // unrelated file changed) — must dedupe against the still-open row, not
    // re-file just because the hash differs.
    const second = await partialFailTrigger('hash-b2', ['suite.testB']);
    expect(second.filed).toBe(false);
    expect(second.reason).toBe('already-open');
    expect(createTaskMock).toHaveBeenCalledTimes(1);
  });

  it('claims and files only the newly-uncovered ids when a confirmation partially overlaps an open remediation', async () => {
    const first = await partialFailTrigger('hash-c1', ['suite.testC']);
    expect(first.filed).toBe(true);

    const second = await partialFailTrigger('hash-c2', [
      'suite.testC',
      'suite.testD',
    ]);
    expect(second.filed).toBe(true);
    expect(createTaskMock).toHaveBeenCalledTimes(2);
    const secondBody = createTaskMock.mock.calls[1][0].body as string;
    expect(secondBody).toContain('suite.testD');
    expect(secondBody).not.toContain('suite.testC');

    const trackingD = getBaseHealthRemediationTestTracking(
      PROJECT,
      'suite.testD',
    );
    expect(trackingD?.remediation_task_id).toBe(
      'notion:base-remediation-task-1',
    );
  });

  it('never files for a partial_fail confirmation with zero failing test ids', async () => {
    const result = await partialFailTrigger('hash-empty', []);
    expect(result.filed).toBe(false);
    expect(result.reason).toBe('no-evidence');
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('reopens (files a fresh task) once the previously linked task closes', async () => {
    const first = await partialFailTrigger('hash-d1', ['suite.testE']);
    expect(first.filed).toBe(true);

    closeBaseHealthRemediationTaskIfLinked(
      first.taskId!,
      new Date().toISOString(),
    );

    createTaskMock.mockResolvedValueOnce('notion:base-remediation-task-2');
    const second = await partialFailTrigger('hash-d2', ['suite.testE']);
    expect(second.filed).toBe(true);
    expect(second.taskId).toBe('notion:base-remediation-task-2');
    expect(createTaskMock).toHaveBeenCalledTimes(2);
  });

  it('never double-files when two confirmations race concurrently for the same failing test id', async () => {
    let resolveCreate: (id: string) => void;
    createTaskMock.mockImplementationOnce(
      () => new Promise((resolve) => (resolveCreate = resolve)),
    );

    const raceA = partialFailTrigger('hash-e', ['suite.testF']);
    const raceB = partialFailTrigger('hash-e', ['suite.testF']);

    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveCreate!('notion:base-remediation-task-race');

    const [resultA, resultB] = await Promise.all([raceA, raceB]);
    const filedResults = [resultA, resultB].filter((r) => r.filed);
    expect(filedResults).toHaveLength(1);
    expect(createTaskMock).toHaveBeenCalledTimes(1);
  });

  it('swallows a createTask failure, releases every claimed row, and lets a later call retry', async () => {
    createTaskMock.mockRejectedValueOnce(new Error('Notion API timeout'));

    const failed = await partialFailTrigger('hash-f', [
      'suite.testG',
      'suite.testH',
    ]);
    expect(failed.filed).toBe(false);
    expect(failed.reason).toBe('create-task-failed');

    for (const testId of ['suite.testG', 'suite.testH']) {
      const tracking = getBaseHealthRemediationTestTracking(PROJECT, testId);
      expect(tracking?.remediation_task_open).toBe(0);
      expect(tracking?.remediation_task_id).toBeNull();
    }

    createTaskMock.mockResolvedValueOnce('notion:base-remediation-task-retry');
    const retried = await partialFailTrigger('hash-f', [
      'suite.testG',
      'suite.testH',
    ]);
    expect(retried.filed).toBe(true);
    expect(retried.taskId).toBe('notion:base-remediation-task-retry');
  });

  it('skips filing (releasing every claimed row) when there is no triggering task', async () => {
    const result = await partialFailTrigger('hash-g', ['suite.testI'], null);
    expect(result.filed).toBe(false);
    expect(result.reason).toBe('no-triggering-task');
    expect(createTaskMock).not.toHaveBeenCalled();

    const tracking = getBaseHealthRemediationTestTracking(
      PROJECT,
      'suite.testI',
    );
    expect(tracking?.remediation_task_open).toBe(0);
  });
});

describe('recordAndMaybeFileBaseHealthRemediation — total_fail', () => {
  it('files exactly one Code task keyed on (project, failure_reason)', async () => {
    const first = await totalFailTrigger('hash-h', 'oom_killed');
    expect(first.filed).toBe(true);
    expect(createTaskMock).toHaveBeenCalledTimes(1);

    const tracking = getBaseHealthRemediationReasonTracking(
      PROJECT,
      'oom_killed',
    );
    expect(tracking?.remediation_task_open).toBe(1);
  });

  it('files at most one remediation task across a single triggering task’s repeated confirmations, even when failure_reason drifts mid-retry', async () => {
    const first = await totalFailTrigger('hash-i1', 'timeout');
    expect(first.filed).toBe(true);
    expect(createTaskMock).toHaveBeenCalledTimes(1);

    // Same triggering task retries and this time the base tree has moved,
    // landing on a different failure_reason — still a pass-through no-op.
    const second = await totalFailTrigger('hash-i2', 'oom_killed');
    expect(second.filed).toBe(false);
    expect(second.reason).toBe('already-counted-for-task');

    const third = await totalFailTrigger('hash-i3', 'timeout');
    expect(third.filed).toBe(false);
    expect(third.reason).toBe('already-counted-for-task');

    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(
      getBaseHealthRemediationReasonTracking(PROJECT, 'oom_killed'),
    ).toBeUndefined();
  });

  it('files independently for a different triggering task even under the same failure_reason', async () => {
    const otherTaskId = 'notion:triggering-task-2';
    upsertTaskCache(
      `board:${MILESTONE_ROW_ID}`,
      JSON.stringify([
        notionTaskStub(TRIGGERING_TASK_ID),
        notionTaskStub(otherTaskId),
      ]),
    );

    const first = await totalFailTrigger('hash-j1', 'timeout');
    expect(first.filed).toBe(true);

    const second = await totalFailTrigger('hash-j2', 'timeout', otherTaskId);
    expect(second.filed).toBe(false);
    expect(second.reason).toBe('already-open');
    expect(createTaskMock).toHaveBeenCalledTimes(1);
  });

  it('reopens (files a fresh task) once the previously linked task closes', async () => {
    const first = await totalFailTrigger('hash-k1', 'generic');
    expect(first.filed).toBe(true);

    closeBaseHealthRemediationTaskIfLinked(
      first.taskId!,
      new Date().toISOString(),
    );

    const otherTaskId = 'notion:triggering-task-3';
    upsertTaskCache(
      `board:${MILESTONE_ROW_ID}`,
      JSON.stringify([
        notionTaskStub(TRIGGERING_TASK_ID),
        notionTaskStub(otherTaskId),
      ]),
    );
    createTaskMock.mockResolvedValueOnce('notion:base-remediation-task-2');
    const second = await totalFailTrigger('hash-k2', 'generic', otherTaskId);
    expect(second.filed).toBe(true);
    expect(second.taskId).toBe('notion:base-remediation-task-2');
  });

  it('skips filing when there is no triggering task', async () => {
    const result = await totalFailTrigger('hash-l', 'timeout', null);
    expect(result.filed).toBe(false);
    expect(result.reason).toBe('no-triggering-task');
    expect(createTaskMock).not.toHaveBeenCalled();
  });
});
