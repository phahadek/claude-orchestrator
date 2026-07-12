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

vi.mock('../db/queries', () => ({
  getSession: mockGetSession,
  getDeviceByToken: mockGetDeviceByToken,
  updateDeviceLastSeen: vi.fn(),
  getActiveDeviceCount: vi.fn().mockReturnValue(1),
  getTaskCache: vi.fn().mockReturnValue(null),
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

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
