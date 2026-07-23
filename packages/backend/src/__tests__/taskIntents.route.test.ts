import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockGetTaskBackend, mockGetSession, mockGetDeviceByToken } = vi.hoisted(
  () => ({
    mockGetTaskBackend: vi.fn(),
    mockGetSession: vi.fn(),
    mockGetDeviceByToken: vi.fn(),
  }),
);

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

// Isolated in-memory db (test/helpers/setupTestDb.ts) instead of the real
// file-backed singleton — otherwise staged_intent rows persist across test
// cases (and test files, and CI runs) and produce spurious dedup/lock
// collisions.
vi.mock('../db/db', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/queries')>();
  return {
    ...actual,
    getSession: mockGetSession,
    getDeviceByToken: mockGetDeviceByToken,
    updateDeviceLastSeen: vi.fn(),
    getActiveDeviceCount: vi.fn().mockReturnValue(1),
    getTaskCache: vi.fn().mockReturnValue(null),
  };
});

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

import { db } from '../db/db';
import { createTaskIntentsRouter } from '../routes/taskIntents';
import { createStagedIntentsRouter } from '../routes/stagedIntents';
import { requireDeviceAuth } from '../auth/DeviceAuth';
import {
  mintStageCredential,
  _resetStageCredentialsForTesting,
} from '../auth/SessionStageAuth';

/** App wired like the real server: the loopback stage endpoint ahead of
 *  device auth, then the human/device-authed staged-intents surface behind it. */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createTaskIntentsRouter());
  app.use('/api', requireDeviceAuth);
  app.use('/api', createStagedIntentsRouter());
  return app;
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockGetSession.mockReset();
  mockGetDeviceByToken.mockReset();
  _resetStageCredentialsForTesting();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

describe('POST /api/task-intents — loopback session stage endpoint', () => {
  it("stages an intent for the session credential's project without touching the task backend", async () => {
    mockGetSession.mockReturnValue({
      session_id: 'session-1',
      project_id: 'proj-1',
    });
    const token = mintStageCredential('session-1');

    const res = await supertest(buildApp())
      .post('/api/task-intents')
      .set('Authorization', `Bearer ${token}`)
      .send({
        kind: 'task.setStatus',
        payload: { taskId: 't-1', status: 'Done' },
      });

    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('task.setStatus');
    expect(res.body.projectId).toBe('proj-1');
    expect(mockGetTaskBackend).not.toHaveBeenCalled();
  });

  it('stages an intent with the provided groupId so correlated writes can be presented together', async () => {
    mockGetSession.mockReturnValue({
      session_id: 'session-1',
      project_id: 'proj-1',
    });
    const token = mintStageCredential('session-1');

    const res = await supertest(buildApp())
      .post('/api/task-intents')
      .set('Authorization', `Bearer ${token}`)
      .send({
        kind: 'task.setDependsOn',
        payload: { taskId: 't-1', dependsOn: ['t-0'] },
        groupId: 'batch-1',
      });

    expect(res.status).toBe(201);
    expect(res.body.groupId).toBe('batch-1');
  });

  it("stages the /groom skill's structured proposal fields on a Ready-flip decision, not free prose", async () => {
    mockGetSession.mockReturnValue({
      session_id: 'session-1',
      project_id: 'proj-1',
    });
    const token = mintStageCredential('session-1');

    const groomProposal = {
      achieves: 'Stops re-ingesting unchanged HLTV items.',
      openQuestions: 'None.',
      automatedTests: 'dedupe drops a duplicate GUID.',
      manualVerification: 'Covered by gate only.',
      operationalSeed: 'None.',
    };

    const res = await supertest(buildApp())
      .post('/api/task-intents')
      .set('Authorization', `Bearer ${token}`)
      .send({
        kind: 'task.setStatus',
        payload: { taskId: 't-1', status: 'Ready' },
        groupId: 'batch-1',
        groomProposal,
      });

    expect(res.status).toBe(201);
    expect(res.body.groomProposal).toEqual(groomProposal);
    // Structured, not free prose: every field is its own string, not one
    // paragraph packed into decisionProposal.
    expect(typeof res.body.groomProposal.achieves).toBe('string');
    expect(typeof res.body.groomProposal.openQuestions).toBe('string');
    expect(typeof res.body.groomProposal.automatedTests).toBe('string');
    expect(typeof res.body.groomProposal.manualVerification).toBe('string');
    expect(typeof res.body.groomProposal.operationalSeed).toBe('string');
  });

  it('drops a malformed groomProposal (missing fields) rather than staging a partial one', async () => {
    mockGetSession.mockReturnValue({
      session_id: 'session-1',
      project_id: 'proj-1',
    });
    const token = mintStageCredential('session-1');

    const res = await supertest(buildApp())
      .post('/api/task-intents')
      .set('Authorization', `Bearer ${token}`)
      .send({
        kind: 'task.setStatus',
        payload: { taskId: 't-2', status: 'Ready' },
        groomProposal: { achieves: 'Only this field.' },
      });

    expect(res.status).toBe(201);
    expect(res.body.groomProposal).toBeNull();
  });

  it('rejects an unknown intent kind', async () => {
    mockGetSession.mockReturnValue({
      session_id: 'session-1',
      project_id: 'proj-1',
    });
    const token = mintStageCredential('session-1');

    const res = await supertest(buildApp())
      .post('/api/task-intents')
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'task.apply', payload: {} });

    expect(res.status).toBe(400);
  });

  it('rejects a request with no session credential', async () => {
    const res = await supertest(buildApp())
      .post('/api/task-intents')
      .send({ kind: 'task.setStatus', payload: {} });
    expect(res.status).toBe(401);
  });

  it('stages gate.accrete, seed.stage, and journal.setState for a session credential', async () => {
    mockGetSession.mockReturnValue({
      session_id: 'session-1',
      project_id: 'proj-1',
    });
    const token = mintStageCredential('session-1');

    for (const [kind, payload] of [
      [
        'gate.accrete',
        {
          sourceTask: {
            id: 'notion:abc',
            title: 'T',
            project: 'proj-1',
            milestone: 'M1',
          },
          items: [],
          classification: 'n/a',
        },
      ],
      [
        'seed.stage',
        {
          sourceTask: {
            id: 'notion:def',
            title: 'T',
            project: 'proj-1',
            milestone: 'M1',
          },
          seeds: [],
          decision: 'n/a',
        },
      ],
      ['journal.setState', { taskId: 'notion:ghi', state: 'candidate' }],
    ] as const) {
      const res = await supertest(buildApp())
        .post('/api/task-intents')
        .set('Authorization', `Bearer ${token}`)
        .send({ kind, payload });
      expect(res.status).toBe(201);
      expect(res.body.kind).toBe(kind);
    }
  });

  it('rejects an apply attempt made with a session credential — the stage token cannot authenticate to the device-gated apply route', async () => {
    mockGetSession.mockReturnValue({
      session_id: 'session-1',
      project_id: 'proj-1',
    });
    const token = mintStageCredential('session-1');
    // A session credential is never a device token, so requireDeviceAuth (which
    // gates /staged-intents/:id/apply) must reject it outright.
    mockGetDeviceByToken.mockReturnValue(null);

    const res = await supertest(buildApp())
      .post('/api/staged-intents/some-id/apply')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(401);
    expect(mockGetTaskBackend).not.toHaveBeenCalled();
  });
});
