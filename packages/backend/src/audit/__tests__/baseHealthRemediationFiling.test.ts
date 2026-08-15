/**
 * Tests for the base-health remediation filer
 * (packages/backend/src/audit/baseHealthRemediationFiling.ts).
 *
 * AC:
 *  - the first confirmation of a base content hash files exactly one Code
 *    task against the triggering task's milestone.
 *  - a second confirmation of the SAME content hash files no duplicate.
 *  - two concurrent confirmations for the same content hash never both file.
 *  - a createTask failure releases the claim so a later call can retry.
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
  getBaseHealthRemediationTracking,
} from '../../db/queries.js';
import type { NotionTask } from '../../notion/types.js';
import { recordAndMaybeFileBaseHealthRemediation } from '../baseHealthRemediationFiling.js';

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
  db.prepare('DELETE FROM base_health_remediation_tracking').run();
  db.prepare('DELETE FROM audit_log').run();
  createTaskMock.mockClear();
  createTaskMock.mockResolvedValue('notion:base-remediation-task-1');
});

function trigger(
  contentHash: string,
  outcome: 'partial_fail' | 'total_fail' = 'partial_fail',
) {
  return recordAndMaybeFileBaseHealthRemediation({
    projectId: PROJECT,
    contentHash,
    outcome,
    failingTestIds: outcome === 'partial_fail' ? ['suite.testA'] : [],
    triggeringTaskId: TRIGGERING_TASK_ID,
  });
}

describe('recordAndMaybeFileBaseHealthRemediation', () => {
  it('files exactly one Code task against the correct milestone on first confirmation', async () => {
    const first = await trigger('hash-a');
    expect(first.filed).toBe(true);
    expect(first.taskId).toBe('notion:base-remediation-task-1');
    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseId: MILESTONE_SOURCE_ID,
        type: '💻 Code',
      }),
    );

    const tracking = getBaseHealthRemediationTracking('hash-a');
    expect(tracking?.remediation_task_open).toBe(1);
    expect(tracking?.remediation_task_id).toBe(
      'notion:base-remediation-task-1',
    );
  });

  it('files no duplicate for a second confirmation of the same content hash', async () => {
    const first = await trigger('hash-b');
    expect(first.filed).toBe(true);

    const second = await trigger('hash-b');
    expect(second.filed).toBe(false);
    expect(second.reason).toBe('already-open');
    expect(createTaskMock).toHaveBeenCalledTimes(1);
  });

  it('files independently for a different content hash', async () => {
    await trigger('hash-c');
    const other = await trigger('hash-d');
    expect(other.filed).toBe(true);
    expect(createTaskMock).toHaveBeenCalledTimes(2);
  });

  it('never double-files when two confirmations race concurrently for the same content hash', async () => {
    let resolveCreate: (id: string) => void;
    createTaskMock.mockImplementationOnce(
      () => new Promise((resolve) => (resolveCreate = resolve)),
    );

    const raceA = trigger('hash-e');
    const raceB = trigger('hash-e');

    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveCreate!('notion:base-remediation-task-race');

    const [resultA, resultB] = await Promise.all([raceA, raceB]);
    const filedResults = [resultA, resultB].filter((r) => r.filed);
    expect(filedResults).toHaveLength(1);
    expect(createTaskMock).toHaveBeenCalledTimes(1);
  });

  it('swallows a createTask failure, releases the claim, and lets a later call retry', async () => {
    createTaskMock.mockRejectedValueOnce(new Error('Notion API timeout'));

    const failed = await trigger('hash-f');
    expect(failed.filed).toBe(false);
    expect(failed.reason).toBe('create-task-failed');

    const tracking = getBaseHealthRemediationTracking('hash-f');
    expect(tracking?.remediation_task_open).toBe(0);
    expect(tracking?.remediation_task_id).toBeNull();

    createTaskMock.mockResolvedValueOnce('notion:base-remediation-task-retry');
    const retried = await trigger('hash-f');
    expect(retried.filed).toBe(true);
    expect(retried.taskId).toBe('notion:base-remediation-task-retry');
  });

  it('skips filing (and releases the claim) when there is no triggering task', async () => {
    const result = await recordAndMaybeFileBaseHealthRemediation({
      projectId: PROJECT,
      contentHash: 'hash-g',
      outcome: 'total_fail',
      failingTestIds: [],
      triggeringTaskId: null,
    });
    expect(result.filed).toBe(false);
    expect(result.reason).toBe('no-triggering-task');
    expect(createTaskMock).not.toHaveBeenCalled();
  });
});
