/**
 * Regression coverage for the "supersede only the blocked member" fix: when
 * one member of a grooming intent group is blocked at stage time, only that
 * member should be superseded — its unblocked siblings (gate.accrete,
 * seed.stage, task.setDependsOn, all sitting cleanly at `staged`) must be
 * left in place, not retired and re-staged. Before this fix nothing enforced
 * that scope; a session correcting one blocked member had no signal telling
 * it the untouched siblings were fine as-is.
 *
 * This exercises the real MCP-tool call shape (stageIntent invoked directly
 * with a sessionId — the path explicit `supersedes` validation actually
 * runs on; the human/device POST /staged-intents route never carries a
 * sessionId, so its explicit-supersedes branch is a no-op) followed by the
 * REST commit endpoint, mirroring stagedIntents.groupAccretionOrdering.test.ts.
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

vi.mock('../../projects/ProjectService', () => ({
  ProjectService: {
    getById: (id: string) => {
      if (id !== 'polimarket-analyser') return undefined;
      return {
        id,
        milestones: [{ id: 'M12', name: 'M12', canonicalShortId: 'M12' }],
      };
    },
  },
}));

import { db } from '../../db/db';
import { createStagedIntentsRouter, stageIntent } from '../stagedIntents';
import { getAccretionMarker as getGateAccretionMarker } from '../../gate/gateStore';
import { getAccretionMarker as getSeedAccretionMarker } from '../../seed/seedStore';
import {
  getStagedIntent,
  transitionStagedIntent,
  listStagedIntentsByGroup,
} from '../../db/queries';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

function makeBackend() {
  return {
    type: 'yaml' as const,
    updateStatus: vi.fn().mockResolvedValue(undefined),
    setDependsOn: vi.fn().mockResolvedValue(undefined),
    fetchTaskPage: vi.fn().mockResolvedValue(''),
  };
}

async function approve(app: ReturnType<typeof buildApp>, id: string) {
  const res = await supertest(app)
    .post(`/api/staged-intents/${id}/approve`)
    .send({});
  expect(res.status).toBe(200);
}

/** Drives a fresh `staged` intent through the stage-time-block path to needs_revision, mirroring explicitSupersedeNeedsRevision.test.ts. */
function moveToNeedsRevision(id: string): void {
  transitionStagedIntent(id, 'pending_verification');
  transitionStagedIntent(id, 'needs_revision');
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockGetTaskBackend.mockReturnValue(makeBackend());
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM gate_accretion').run();
  db.prepare('DELETE FROM seed_accretion').run();
});

describe('correcting one blocked group member leaves its unblocked siblings untouched', () => {
  it('supersedes only the blocked task.setStatus member; gate.accrete/seed.stage/task.setDependsOn siblings keep their original ids and the group still commits', async () => {
    const app = buildApp();
    const taskId = 'code-task-scope-1';
    const groupId = 'group-scope-1';
    const sessionId = 'sess-scope-1';

    const gateIntent = stageIntent(
      'gate.accrete',
      {
        sourceTask: {
          id: taskId,
          title: 'Some Code task',
          project: 'polimarket-analyser',
          milestone: 'M12',
        },
        items: [],
        classification: 'n/a',
        reason: 'This task type is exempt from gate accretion.',
      },
      'proj-1',
      groupId,
      sessionId,
    );
    const seedIntent = stageIntent(
      'seed.stage',
      {
        sourceTask: {
          id: taskId,
          title: 'Some Code task',
          project: 'polimarket-analyser',
          milestone: 'M12',
        },
        seeds: [],
        decision: 'n/a',
      },
      'proj-1',
      groupId,
      sessionId,
    );
    const dependsOnIntent = stageIntent(
      'task.setDependsOn',
      { taskId, dependsOn: [] },
      'proj-1',
      groupId,
      sessionId,
    );
    const statusIntent = stageIntent(
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
            {
              raw: 'packages/backend/src/foo.ts',
              isNew: true,
              existsInRepo: false,
            },
          ],
        },
      },
      'proj-1',
      groupId,
      sessionId,
    );

    // Simulate the blocked member: stage-time validation sent this one back.
    moveToNeedsRevision(statusIntent.id);
    expect(getStagedIntent(statusIntent.id)!.state).toBe('needs_revision');

    // The correction supersedes ONLY the blocked task.setStatus intent — the
    // three siblings are never touched.
    const correctedStatus = stageIntent(
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
            {
              raw: 'packages/backend/src/foo.ts',
              isNew: true,
              existsInRepo: false,
            },
          ],
        },
      },
      'proj-1',
      groupId,
      sessionId,
      null,
      null,
      statusIntent.id,
    );
    expect(correctedStatus.supersedes).toBe(statusIntent.id);
    expect(getStagedIntent(statusIntent.id)!.state).toBe('superseded');

    // Siblings kept their original ids and states — never retired/re-staged.
    expect(getStagedIntent(gateIntent.id)!.id).toBe(gateIntent.id);
    expect(getStagedIntent(gateIntent.id)!.state).toBe('staged');
    expect(getStagedIntent(seedIntent.id)!.id).toBe(seedIntent.id);
    expect(getStagedIntent(seedIntent.id)!.state).toBe('staged');
    expect(getStagedIntent(dependsOnIntent.id)!.id).toBe(dependsOnIntent.id);
    expect(getStagedIntent(dependsOnIntent.id)!.state).toBe('staged');

    const groupMembers = listStagedIntentsByGroup(groupId);
    expect(groupMembers.map((r) => r.id).sort()).toEqual(
      [
        gateIntent.id,
        seedIntent.id,
        dependsOnIntent.id,
        statusIntent.id,
        correctedStatus.id,
      ].sort(),
    );

    await approve(app, gateIntent.id);
    await approve(app, seedIntent.id);
    await approve(app, dependsOnIntent.id);
    await approve(app, correctedStatus.id);

    const res = await supertest(app)
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});

    expect(res.status).toBe(200);
    // hasGroupAccretionIntent still found the untouched gate.accrete/
    // seed.stage siblings — the accretion markers landed for real.
    expect(getGateAccretionMarker(taskId)).toBeDefined();
    expect(getSeedAccretionMarker(taskId)).toBeDefined();
  });
});
