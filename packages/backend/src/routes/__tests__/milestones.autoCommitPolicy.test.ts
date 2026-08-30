/**
 * Integration tests for the gate-verify auto-commit policy routes
 * (packages/backend/src/routes/milestones.ts), hit through the real Express
 * router rather than a mocked API client — the frontend's
 * `gateVerifyPolicyApi` (packages/frontend/src/api/flowArm.ts) must call
 * these exact paths or its requests fall through to the SPA catch-all and
 * return an HTML 200 instead of JSON.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { createMilestonesRouter } from '../milestones.js';
import { GATE_VERIFY_AUTO_COMMIT_DISPOSITION_CLASSES } from '../stagedIntents.js';
import { getGateVerifyAutoCommitPolicy } from '../../db/queries.js';
import { ProjectService } from '../../projects/ProjectService.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createMilestonesRouter());
  return app;
}

beforeEach(() => {
  db.prepare('DELETE FROM gate_verify_auto_commit_policy').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('GET /api/milestones/:milestoneId/auto-commit-policy', () => {
  it('returns one row per disposition class, defaulting to unarmed', async () => {
    const res = await request(makeApp()).get(
      '/api/milestones/m1/auto-commit-policy',
    );

    expect(res.status).toBe(200);
    for (const cls of GATE_VERIFY_AUTO_COMMIT_DISPOSITION_CLASSES) {
      expect(res.body[cls]).toEqual({ armed: false });
    }
  });
});

describe('PUT /api/milestones/:milestoneId/auto-commit-policy/:class', () => {
  it('upserts the policy and reflects it in a subsequent GET', async () => {
    const putRes = await request(makeApp())
      .put('/api/milestones/m1/auto-commit-policy/pass')
      .send({ armed: true });

    expect(putRes.status).toBe(200);
    expect(putRes.body).toMatchObject({
      milestoneId: 'm1',
      dispositionClass: 'pass',
      armed: true,
    });

    const getRes = await request(makeApp()).get(
      '/api/milestones/m1/auto-commit-policy',
    );
    expect(getRes.body.pass).toEqual({ armed: true });
  });

  it('rejects an unknown disposition class', async () => {
    const res = await request(makeApp())
      .put('/api/milestones/m1/auto-commit-policy/bogus')
      .send({ armed: true });
    expect(res.status).toBe(400);
  });

  it('rejects a non-boolean armed value', async () => {
    const res = await request(makeApp())
      .put('/api/milestones/m1/auto-commit-policy/pass')
      .send({ armed: 'yes' });
    expect(res.status).toBe(400);
  });

  it('never falls through to a non-JSON response for the frontend-facing path', async () => {
    const res = await request(makeApp()).get(
      '/api/milestones/m1/auto-commit-policy',
    );
    expect(res.headers['content-type']).toMatch(/json/);
  });
});

describe('auto-commit-policy routes keyed by the DB board UUID (arm UI input)', () => {
  it('resolves the DB board UUID to the canonical short id, so the armed state is readable/effective under the canonical short id', async () => {
    if (!ProjectService.getById('proj-policy-uuid')) {
      ProjectService.create({
        id: 'proj-policy-uuid',
        name: 'Project Policy UUID',
        projectDir: '/tmp/proj-policy-uuid',
      });
      ProjectService.createMilestone({
        id: 'ms-uuid-policy-m7',
        projectId: 'proj-policy-uuid',
        name: 'M7',
        canonicalShortId: 'M7',
        sourceId: 'db00d3a1-aaaa-bbbb-cccc-1234567890ff',
      });
    }

    const putRes = await request(makeApp())
      .put('/api/milestones/ms-uuid-policy-m7/auto-commit-policy/pass')
      .send({ armed: true });

    expect(putRes.status).toBe(200);
    expect(putRes.body).toMatchObject({
      dispositionClass: 'pass',
      armed: true,
    });

    // The route response echoes the resolved key, not the raw UUID input.
    expect(putRes.body.milestoneId).toBe('M7');

    // Reading back via the UUID must also resolve to the same row.
    const getRes = await request(makeApp()).get(
      '/api/milestones/ms-uuid-policy-m7/auto-commit-policy',
    );
    expect(getRes.body.pass).toEqual({ armed: true });

    // And the eligibility check — which always reads by canonical short id —
    // must see the policy as armed.
    expect(getGateVerifyAutoCommitPolicy('M7', 'pass')).toBe(true);
  });
});
