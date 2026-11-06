/**
 * Ready-flip no longer allocates or rewrites migration numbers: a task whose
 * Files/paths section lists a *(new)* migration without a number promotes
 * cleanly and its body is left untouched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetTaskBackend } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/queries')>();
  return {
    ...actual,
    getTaskCache: vi.fn().mockReturnValue(null),
  };
});

import { db } from '../../db/db';
import { stageIntent, commitGroupIntents } from '../stagedIntents';
import { recordAccretionMarker } from '../../gate/gateStore';
import { recordAccretionMarker as recordSeedAccretionMarker } from '../../seed/seedStore';

const migrationRaw = 'packages/backend/migrations/NNN_add_thing.sql *(new)*';

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM gate_accretion').run();
  db.prepare('DELETE FROM seed_accretion').run();
});

describe('Ready-flip with an unnumbered *(new)* migration entry', () => {
  it('promotes without error and never patches the body or allocates a number', async () => {
    const patchBodySection = vi.fn().mockResolvedValue(undefined);
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue(
          `## Summary\nClean.\n\n## Files / paths affected\n- ${migrationRaw}\n`,
        ),
      updateStatus,
      setDependsOn: vi.fn().mockResolvedValue(undefined),
      patchBodySection,
    });

    const taskId = 'notion:mig-unnumbered';
    const groupId = 'group-mig-unnumbered';
    recordAccretionMarker({
      sourceTaskId: taskId,
      project: 'proj-mig',
      milestone: 'M1',
      decision: 'n/a',
      reason: 'This task type is exempt from gate accretion.',
      accretedAt: new Date(0).toISOString(),
    });
    recordSeedAccretionMarker({
      sourceTaskId: taskId,
      project: 'proj-mig',
      milestone: 'M1',
      decision: 'n/a',
      accretedAt: new Date(0).toISOString(),
    });

    stageIntent(
      'task.setDependsOn',
      { taskId, dependsOn: [] },
      'proj-mig',
      groupId,
    );
    stageIntent(
      'task.setStatus',
      {
        taskId,
        status: 'Ready',
        groomingGate: {
          size_check: { decision: 'n/a' },
          type_check: { decision: 'none' },
          seam_check: { decision: 'n/a' },
          type: '💻 Code',
          filesPathsEntries: [
            { raw: migrationRaw, isNew: true, existsInRepo: false },
          ],
        },
      },
      'proj-mig',
      groupId,
    );

    const result = await commitGroupIntents(groupId, {
      override: false,
      reason: '',
      autoApprove: true,
      actorType: 'human',
    });

    expect(result.status).toBe(200);
    expect(updateStatus).toHaveBeenCalled();
    expect(patchBodySection).not.toHaveBeenCalled();
  });
});
