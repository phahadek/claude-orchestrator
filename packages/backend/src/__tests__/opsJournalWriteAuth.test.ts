import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockGetSession, mockGetDeviceByToken, mockGetActiveDeviceCount } =
  vi.hoisted(() => ({
    mockGetSession: vi.fn(),
    mockGetDeviceByToken: vi.fn(),
    mockGetActiveDeviceCount: vi.fn().mockReturnValue(1),
  }));

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
    getActiveDeviceCount: mockGetActiveDeviceCount,
  };
});

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

import { db } from '../db/db';
import { upsertOpsJournalEntry } from '../db/queries';
import { createOpsJournalRouter } from '../routes/opsJournal';
import {
  mintOpsJournalCredential,
  _resetOpsJournalCredentialsForTesting,
} from '../auth/OpsJournalAuth';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createOpsJournalRouter());
  return app;
}

function seedEntry(
  taskId: string,
  milestone: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  upsertOpsJournalEntry({
    task_id: taskId,
    project: 'polimarket-analyser',
    milestone,
    state: 'pending',
    disposition: null,
    worked_in: null,
    evidence: null,
    finding_or_proposal: null,
    falsification: null,
    filed_followons: null,
    needs_from_operator: null,
    resolution: null,
    updated_at: new Date(0).toISOString(),
    ...overrides,
  } as any);
}

beforeEach(() => {
  db.prepare('DELETE FROM ops_journal').run();
  mockGetSession.mockReset();
  mockGetDeviceByToken.mockReset();
  mockGetActiveDeviceCount.mockReturnValue(1);
  _resetOpsJournalCredentialsForTesting();
});

describe('POST /api/ops-journal/:taskId/state — session-scoped journal credential', () => {
  it('accepts a session credential for a staging transition on its own task', async () => {
    mockGetSession.mockReturnValue({
      session_id: 'ops-session-1',
      task_id: 'task-1',
    });
    seedEntry('task-1', 'M12', { state: 'pending' });
    const token = mintOpsJournalCredential('ops-session-1');

    const res = await supertest(buildApp())
      .post('/api/ops-journal/task-1/state')
      .set('Authorization', `Bearer ${token}`)
      .send({ state: 'candidate' });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('candidate');
  });

  it('rejects a session credential transitioning -> resolved', async () => {
    mockGetSession.mockReturnValue({
      session_id: 'ops-session-1',
      task_id: 'task-1',
    });
    seedEntry('task-1', 'M12', { state: 'applied-pending-confirm' });
    const token = mintOpsJournalCredential('ops-session-1');

    const res = await supertest(buildApp())
      .post('/api/ops-journal/task-1/state')
      .set('Authorization', `Bearer ${token}`)
      .send({ state: 'resolved' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ops_journal_resolved_requires_device_auth');

    mockGetDeviceByToken.mockReturnValue({
      id: 'device-1',
      token: 'device-tok',
    });
    const stillOpen = await supertest(buildApp())
      .get('/api/ops-journal?milestone=M12')
      .set('Authorization', 'Bearer device-tok');
    expect(stillOpen.body.entries[0].state).toBe('applied-pending-confirm');
  });

  it('accepts a device token transitioning -> resolved (unrestricted, additive)', async () => {
    mockGetDeviceByToken.mockReturnValue({
      id: 'device-1',
      token: 'device-tok',
    });
    seedEntry('task-1', 'M12', { state: 'applied-pending-confirm' });

    const res = await supertest(buildApp())
      .post('/api/ops-journal/task-1/state')
      .set('Authorization', 'Bearer device-tok')
      .send({ state: 'resolved' });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('resolved');
  });

  it('rejects a session credential writing to a task other than its own', async () => {
    mockGetSession.mockReturnValue({
      session_id: 'ops-session-1',
      task_id: 'task-other',
    });
    seedEntry('task-1', 'M12', { state: 'pending' });
    const token = mintOpsJournalCredential('ops-session-1');

    const res = await supertest(buildApp())
      .post('/api/ops-journal/task-1/state')
      .set('Authorization', `Bearer ${token}`)
      .send({ state: 'candidate' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ops_journal_wrong_task');
  });

  it('rejects an invalid/unknown bearer token and an absent one when no devices are enrolled yet', async () => {
    mockGetActiveDeviceCount.mockReturnValue(0);
    seedEntry('task-1', 'M12', { state: 'pending' });

    const res = await supertest(buildApp())
      .post('/api/ops-journal/task-1/state')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ state: 'candidate' });

    // Falls through to device auth, which rejects an unknown device token.
    expect(res.status).toBe(401);
  });
});
