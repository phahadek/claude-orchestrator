/**
 * Tests for the per-flow arm routes (packages/backend/src/routes/milestones.ts).
 *
 * AC: PUT upserts and writes a flow_arm_changed audit row with the previous
 * value; GET returns effective per-flow state with source.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename } from 'path';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { createMilestonesRouter } from '../milestones.js';
import { insertProject, insertMilestone } from '../../db/queries.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createMilestonesRouter());
  return app;
}

beforeEach(() => {
  db.prepare('DELETE FROM flow_arm').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('GET /api/milestones/:milestoneId/arm', () => {
  it('returns effective per-flow state with source, defaulting absent flows', async () => {
    const res = await request(makeApp()).get('/api/milestones/m1/arm');

    expect(res.status).toBe(200);
    expect(res.body.groom).toEqual({ armed: false, source: 'default' });
    expect(res.body.design).toEqual({ armed: false, source: 'default' });
    expect(res.body.ops).toEqual({ armed: false, source: 'default' });
    expect(res.body['gate-verify']).toEqual({
      armed: false,
      source: 'default',
    });
  });
});

describe('PUT /api/milestones/:milestoneId/arm/:flow', () => {
  it('upserts the arm value and reflects it in a subsequent GET', async () => {
    const putRes = await request(makeApp())
      .put('/api/milestones/m1/arm/design')
      .send({ armed: true });

    expect(putRes.status).toBe(200);
    expect(putRes.body).toEqual({
      milestoneId: 'm1',
      flow: 'design',
      armed: true,
    });

    const getRes = await request(makeApp()).get('/api/milestones/m1/arm');
    expect(getRes.body.design).toEqual({ armed: true, source: 'row' });
  });

  it('writes a flow_arm_changed audit row carrying the previous value', async () => {
    await request(makeApp())
      .put('/api/milestones/m1/arm/groom')
      .send({ armed: false });

    const rows = db
      .prepare(`SELECT * FROM audit_log WHERE event_type = 'flow_arm_changed'`)
      .all() as Array<{ payload: string }>;
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload);
    expect(payload).toEqual({
      milestone: 'm1',
      flow: 'groom',
      armed: false,
      previous: false,
    });
  });

  it('rejects an unknown flow', async () => {
    const res = await request(makeApp())
      .put('/api/milestones/m1/arm/nope')
      .send({ armed: true });
    expect(res.status).toBe(400);
  });

  it('rejects a non-boolean armed value', async () => {
    const res = await request(makeApp())
      .put('/api/milestones/m1/arm/groom')
      .send({ armed: 'yes' });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/milestones/:milestoneId/arm/:flow — grooming manifest registration gate', () => {
  let repoDir: string;
  let configDir: string;

  beforeEach(() => {
    db.prepare('DELETE FROM milestones').run();
    db.prepare('DELETE FROM projects').run();
    repoDir = mkdtempSync(join(tmpdir(), 'arm-gate-repo-'));
    configDir = mkdtempSync(join(tmpdir(), 'arm-gate-config-'));
    const projectKey = basename(repoDir);
    mkdirSync(join(configDir, 'projects', projectKey), { recursive: true });
    writeFileSync(
      join(configDir, 'projects', projectKey, 'grooming.json'),
      JSON.stringify({ milestones: { M12: { board: 'board-12' } } }),
    );
    process.env.ORCHESTRATOR_CONFIG_DIR = configDir;

    insertProject({
      id: 'arm-gate-project',
      name: 'Arm Gate Project',
      project_dir: repoDir,
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });
  });

  afterEach(() => {
    delete process.env.ORCHESTRATOR_CONFIG_DIR;
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it('rejects arming a flow for a milestone absent from the manifest, naming both the milestone and the registered set', async () => {
    insertMilestone({
      id: 'm-unregistered',
      project_id: 'arm-gate-project',
      name: 'M14 — Unregistered',
      source_id: 'board-14',
      canonical_short_id: 'M14',
      display_order: 1,
    });

    const res = await request(makeApp())
      .put('/api/milestones/m-unregistered/arm/groom')
      .send({ armed: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('M14');
    expect(res.body.error).toContain('M12');
  });

  it('leaves arming a registered milestone unaffected', async () => {
    insertMilestone({
      id: 'm-registered',
      project_id: 'arm-gate-project',
      name: 'M12 — Registered',
      source_id: 'board-12',
      canonical_short_id: 'M12',
      display_order: 0,
    });

    const res = await request(makeApp())
      .put('/api/milestones/m-registered/arm/groom')
      .send({ armed: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      milestoneId: 'm-registered',
      flow: 'groom',
      armed: true,
    });
  });

  it('does not gate disarming an unregistered milestone', async () => {
    insertMilestone({
      id: 'm-unregistered-2',
      project_id: 'arm-gate-project',
      name: 'M15 — Unregistered',
      source_id: 'board-15',
      canonical_short_id: 'M15',
      display_order: 2,
    });

    const res = await request(makeApp())
      .put('/api/milestones/m-unregistered-2/arm/groom')
      .send({ armed: false });

    expect(res.status).toBe(200);
  });
});
