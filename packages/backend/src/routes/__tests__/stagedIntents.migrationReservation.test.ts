/**
 * Migration-number reservation: Ready-flip allocation + body-prose sync.
 *
 * AC: a *(new)* migration placeholder entry in a task's Files/paths section
 * is rewritten to the freshly-allocated number as part of the same
 * correlated group's apply, strictly before the Ready flip itself commits;
 * an actual staged Ready-flip group commit (not just a direct function
 * call) leaves the applied task's body reflecting the number the
 * reservation table recorded.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

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
import {
  createStagedIntentsRouter,
  stageIntent,
  commitGroupIntents,
} from '../stagedIntents';
import { recordAccretionMarker } from '../../gate/gateStore';
import { recordAccretionMarker as recordSeedAccretionMarker } from '../../seed/seedStore';
import { getReservationForTask } from '../../db/migrationReservation';

function codeGroomingGate(migrationRaw: string) {
  return {
    size_check: { decision: 'n/a' },
    type_check: { decision: 'none' },
    type: '💻 Code',
    filesPathsEntries: [
      { raw: migrationRaw, isNew: true, existsInRepo: false },
    ],
  };
}

function migrationBody(migrationRaw: string) {
  return (
    '## Summary\nClean.\n\n' + `## Files / paths affected\n- ${migrationRaw}\n`
  );
}

function recordAccretion(taskId: string) {
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
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM gate_accretion').run();
  db.prepare('DELETE FROM seed_accretion').run();
  db.prepare('DELETE FROM migration_reservation_event').run();
  db.prepare('DELETE FROM migration_reservation').run();
});

describe('Ready-flip apply-time migration-number allocation (direct commitGroupIntents call)', () => {
  it('rewrites the *(new)* migration entry to the allocated number before the Ready flip commits', async () => {
    const migrationRaw =
      'packages/backend/migrations/NNN_add_thing.sql *(new)*';
    const calls: string[] = [];
    const patchBodySection = vi.fn().mockImplementation(async () => {
      calls.push('patchBodySection');
    });
    const updateStatus = vi.fn().mockImplementation(async () => {
      calls.push('setStatus');
    });
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue(migrationBody(migrationRaw)),
      updateStatus,
      setDependsOn: vi.fn().mockResolvedValue(undefined),
      patchBodySection,
    });

    const taskId = 'notion:mig-direct';
    const groupId = 'group-mig-direct';
    recordAccretion(taskId);

    stageIntent(
      'task.setDependsOn',
      { taskId, dependsOn: [] },
      'proj-mig',
      groupId,
    );
    const setStatus = stageIntent(
      'task.setStatus',
      { taskId, status: 'Ready', groomingGate: codeGroomingGate(migrationRaw) },
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
    expect(setStatus.id).toBeTruthy();

    // Ordering: the body-prose sync happens before the flip's own setStatus call.
    expect(calls).toEqual(['patchBodySection', 'setStatus']);

    expect(patchBodySection).toHaveBeenCalledWith(
      taskId,
      'Files / paths affected',
      expect.objectContaining({
        operation: 'replace',
        find: migrationRaw,
        replaceWith: expect.stringContaining(
          'packages/backend/migrations/0001_add_thing.sql',
        ),
      }),
    );

    const reservation = getReservationForTask(taskId);
    expect(reservation).toBeDefined();
    expect(reservation?.number).toBe(1);
  });

  it('never allocates when the Files/paths section has no pending migration placeholder', async () => {
    const patchBodySection = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue(
          '## Summary\nClean.\n\n## Files / paths affected\n- packages/backend/src/foo.ts *(new)*\n',
        ),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      setDependsOn: vi.fn().mockResolvedValue(undefined),
      patchBodySection,
    });

    const taskId = 'notion:mig-none';
    const groupId = 'group-mig-none';
    recordAccretion(taskId);

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
          type: '💻 Code',
          filesPathsEntries: [
            {
              raw: 'packages/backend/src/foo.ts',
              isNew: true,
              existsInRepo: false,
            },
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
    expect(patchBodySection).not.toHaveBeenCalled();
    expect(getReservationForTask(taskId)).toBeUndefined();
  });
});

describe('Ready-flip apply-time migration-number allocation (actual staged group commit over HTTP)', () => {
  it('leaves the applied task body reflecting the reservation table’s recorded number', async () => {
    const migrationRaw =
      'packages/backend/migrations/NNN_add_thing.sql *(new)*';
    const patchBodySection = vi.fn().mockResolvedValue(undefined);
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue(migrationBody(migrationRaw)),
      updateStatus,
      setDependsOn: vi.fn().mockResolvedValue(undefined),
      patchBodySection,
    });

    const app = makeApp();
    const agent = supertest(app);
    const taskId = 'notion:mig-http';
    const groupId = 'group-mig-http';
    recordAccretion(taskId);

    const dependsOn = await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId: 'proj-mig',
      groupId,
      payload: { taskId, dependsOn: [] },
    });
    const setStatus = await agent.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId: 'proj-mig',
      groupId,
      payload: {
        taskId,
        status: 'Ready',
        groomingGate: codeGroomingGate(migrationRaw),
      },
    });

    await agent
      .post(`/api/staged-intents/${dependsOn.body.id}/approve`)
      .send({});
    await agent
      .post(`/api/staged-intents/${setStatus.body.id}/approve`)
      .send({});

    const commit = await agent
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});

    expect(commit.status).toBe(200);
    expect(commit.body.committed.sort()).toEqual(
      [dependsOn.body.id, setStatus.body.id].sort(),
    );

    const reservation = getReservationForTask(taskId);
    expect(reservation).toBeDefined();

    const paddedNumber = String(reservation!.number).padStart(4, '0');
    expect(patchBodySection).toHaveBeenCalledWith(
      taskId,
      'Files / paths affected',
      expect.objectContaining({
        operation: 'replace',
        find: migrationRaw,
        replaceWith: expect.stringContaining(
          `packages/backend/migrations/${paddedNumber}_add_thing.sql`,
        ),
      }),
    );
    expect(updateStatus).toHaveBeenCalledWith(
      taskId,
      '🗂️ Ready',
      expect.objectContaining({ source: 'human' }),
    );
  });
});
