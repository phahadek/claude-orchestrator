import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

// ── Hoisted mock state ────────────────────────────────────────────────────────

const { mockRuntimeSettings } = vi.hoisted(() => {
  const mockRuntimeSettings: Record<string, unknown> = {
    capability_auto_approve_allowlist: [] as string[],
  };
  return { mockRuntimeSettings };
});

vi.mock('../config.js', () => ({
  runtimeSettings: mockRuntimeSettings,
}));

vi.mock('../db/queries.js', () => ({
  getSetting: () => undefined,
  setSetting: () => undefined,
  getAllSettings: () => ({}),
}));

vi.mock('../db/db', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

// Imported after mocks so they pick up the mocked db/config.
import { db } from '../db/db';
import { recordEvent } from '../audit/AuditLog';
import settingsRouter from '../routes/settings.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', settingsRouter);
  return app;
}

function disposition(
  projectId: string,
  capability: string,
  outcome: 'auto_approved' | 'operator_approved' | 'operator_denied' | 'declined',
) {
  recordEvent({
    event_type: 'capability_request_disposition',
    actor_type: outcome === 'auto_approved' ? 'system' : 'human',
    actor_id: 'sess-1',
    project_id: projectId,
    task_id: null,
    payload: {
      capability,
      disposition: outcome,
      provenance: outcome === 'auto_approved' ? 'auto' : 'operator',
    },
  });
}

beforeEach(() => {
  db.prepare('DELETE FROM audit_log').run();
  mockRuntimeSettings.capability_auto_approve_allowlist = [];
});

describe('GET /api/settings capability_auto_allow_suggestions', () => {
  it('suggests a key after 3 consecutive operator_approved dispositions with no denials', async () => {
    disposition('proj-a', 'Bash(psql:*)', 'operator_approved');
    disposition('proj-a', 'Bash(psql:*)', 'operator_approved');
    disposition('proj-a', 'Bash(psql:*)', 'operator_approved');

    const res = await supertest(buildApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.body.capability_auto_allow_suggestions).toEqual([
      { projectId: 'proj-a', capability: 'Bash(psql:*)', approvedStreak: 3 },
    ]);
  });

  it('does not suggest before 3 consecutive approvals', async () => {
    disposition('proj-a', 'Bash(psql:*)', 'operator_approved');
    disposition('proj-a', 'Bash(psql:*)', 'operator_approved');

    const res = await supertest(buildApp()).get('/');
    expect(res.body.capability_auto_allow_suggestions).toEqual([]);
  });

  it('permanently disqualifies a key once operator_denied is recorded, even after later approvals', async () => {
    disposition('proj-a', 'Bash(rm:*)', 'operator_approved');
    disposition('proj-a', 'Bash(rm:*)', 'operator_denied');
    disposition('proj-a', 'Bash(rm:*)', 'operator_approved');
    disposition('proj-a', 'Bash(rm:*)', 'operator_approved');
    disposition('proj-a', 'Bash(rm:*)', 'operator_approved');

    const res = await supertest(buildApp()).get('/');
    expect(res.body.capability_auto_allow_suggestions).toEqual([]);
  });

  it('permanently disqualifies a key once declined is recorded', async () => {
    disposition('proj-a', 'Bash(curl:*)', 'declined');
    disposition('proj-a', 'Bash(curl:*)', 'operator_approved');
    disposition('proj-a', 'Bash(curl:*)', 'operator_approved');
    disposition('proj-a', 'Bash(curl:*)', 'operator_approved');

    const res = await supertest(buildApp()).get('/');
    expect(res.body.capability_auto_allow_suggestions).toEqual([]);
  });

  it('keys strictly on (project_id, capability) — same capability in another project needs its own streak', async () => {
    disposition('proj-a', 'Bash(psql:*)', 'operator_approved');
    disposition('proj-a', 'Bash(psql:*)', 'operator_approved');
    disposition('proj-a', 'Bash(psql:*)', 'operator_approved');
    disposition('proj-b', 'Bash(psql:*)', 'operator_approved');
    disposition('proj-b', 'Bash(psql:*)', 'operator_approved');

    const res = await supertest(buildApp()).get('/');
    expect(res.body.capability_auto_allow_suggestions).toEqual([
      { projectId: 'proj-a', capability: 'Bash(psql:*)', approvedStreak: 3 },
    ]);
  });

  it('interleaved dispositions for other keys do not affect a key’s own consecutive count', async () => {
    disposition('proj-a', 'Bash(psql:*)', 'operator_approved');
    disposition('proj-a', 'Bash(other:*)', 'operator_denied');
    disposition('proj-a', 'Bash(psql:*)', 'operator_approved');
    disposition('proj-a', 'Bash(other:*)', 'operator_approved');
    disposition('proj-a', 'Bash(psql:*)', 'operator_approved');

    const res = await supertest(buildApp()).get('/');
    expect(res.body.capability_auto_allow_suggestions).toEqual([
      { projectId: 'proj-a', capability: 'Bash(psql:*)', approvedStreak: 3 },
    ]);
  });

  it('excludes a key already present in capability_auto_approve_allowlist', async () => {
    mockRuntimeSettings.capability_auto_approve_allowlist = ['Bash(psql:*)'];
    disposition('proj-a', 'Bash(psql:*)', 'operator_approved');
    disposition('proj-a', 'Bash(psql:*)', 'operator_approved');
    disposition('proj-a', 'Bash(psql:*)', 'operator_approved');

    const res = await supertest(buildApp()).get('/');
    expect(res.body.capability_auto_allow_suggestions).toEqual([]);
  });

  it('excludes a key matched by GRANT_DENYLIST_PATTERNS', async () => {
    disposition('proj-a', 'task-intent.apply', 'operator_approved');
    disposition('proj-a', 'task-intent.apply', 'operator_approved');
    disposition('proj-a', 'task-intent.apply', 'operator_approved');

    const res = await supertest(buildApp()).get('/');
    expect(res.body.capability_auto_allow_suggestions).toEqual([]);
  });
});
