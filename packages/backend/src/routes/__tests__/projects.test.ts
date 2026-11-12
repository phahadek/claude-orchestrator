/**
 * Tests for PATCH /api/projects/:id's arch_store_adopted dual-read flip
 * (packages/backend/src/routes/projects.ts).
 *
 * AC: the flag is settable through the projects route, rejected without
 * device auth, and the toggle records an arch_store_adopted_toggled audit
 * event carrying its prior value.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { insertProject, insertMilestone } from '../../db/queries.js';
import { requireDeviceAuth } from '../../auth/DeviceAuth.js';
import { projectsRouter, setProjectBroadcast } from '../projects.js';

const PROJECT = 'proj-arch-flip';
const MILESTONE = 'milestone-wrap-test';
const DEVICE_TOKEN = 'valid-device-token';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', requireDeviceAuth);
  app.use('/api', projectsRouter);
  return app;
}

function insertDevice() {
  db.prepare(
    `INSERT INTO devices (id, name, user_agent, last_ip, last_seen, enrolled_at, token, revoked)
     VALUES (@id, @name, NULL, NULL, NULL, @enrolled_at, @token, 0)`,
  ).run({
    id: 'device-1',
    name: 'Test Device',
    enrolled_at: Date.now(),
    token: DEVICE_TOKEN,
  });
}

beforeEach(() => {
  db.prepare('DELETE FROM devices').run();
  db.prepare('DELETE FROM milestones').run();
  db.prepare('DELETE FROM projects').run();
  db.prepare('DELETE FROM audit_log').run();

  insertDevice();
  insertProject({
    id: PROJECT,
    name: 'Project With Arch Flip',
    project_dir: '/tmp/project-arch-flip',
    context_url: null,
    github_repo: null,
    task_source: 'notion',
  });
  insertMilestone({
    id: MILESTONE,
    project_id: PROJECT,
    name: 'M1 Wrap Test',
    source_id: null,
    canonical_short_id: 'M1',
  });
});

describe('PATCH /api/projects/:id — archStoreAdopted', () => {
  it('is rejected without device auth', async () => {
    const res = await request(makeApp())
      .patch(`/api/projects/${PROJECT}`)
      .send({ archStoreAdopted: true });

    expect(res.status).toBe(401);

    const row = db
      .prepare('SELECT arch_store_adopted FROM projects WHERE id = ?')
      .get(PROJECT) as { arch_store_adopted: number };
    expect(row.arch_store_adopted).toBe(0);
  });

  it('flips the flag through the route when authenticated, and records an audit event carrying the prior value', async () => {
    const res = await request(makeApp())
      .patch(`/api/projects/${PROJECT}`)
      .set('Authorization', `Bearer ${DEVICE_TOKEN}`)
      .send({ archStoreAdopted: true });

    expect(res.status).toBe(200);
    expect(res.body.archStoreAdopted).toBe(true);

    const row = db
      .prepare('SELECT arch_store_adopted FROM projects WHERE id = ?')
      .get(PROJECT) as { arch_store_adopted: number };
    expect(row.arch_store_adopted).toBe(1);

    const events = db
      .prepare(
        `SELECT * FROM audit_log WHERE event_type = 'arch_store_adopted_toggled'`,
      )
      .all() as { project_id: string; payload: string }[];
    expect(events).toHaveLength(1);
    expect(events[0].project_id).toBe(PROJECT);
    expect(JSON.parse(events[0].payload)).toEqual({
      projectId: PROJECT,
      previousValue: false,
      newValue: true,
    });
  });

  it('applies remaining patch fields alongside the audited flip', async () => {
    const res = await request(makeApp())
      .patch(`/api/projects/${PROJECT}`)
      .set('Authorization', `Bearer ${DEVICE_TOKEN}`)
      .send({ archStoreAdopted: true, name: 'Renamed Project' });

    expect(res.status).toBe(200);
    expect(res.body.archStoreAdopted).toBe(true);
    expect(res.body.name).toBe('Renamed Project');
  });
});

describe('PATCH /api/projects/:id — codeAutoApproveEnabled', () => {
  it('persists the toggle and broadcasts the change', async () => {
    const broadcast = vi.fn();
    setProjectBroadcast(broadcast);

    const res = await request(makeApp())
      .patch(`/api/projects/${PROJECT}`)
      .set('Authorization', `Bearer ${DEVICE_TOKEN}`)
      .send({ codeAutoApproveEnabled: true });

    expect(res.status).toBe(200);
    expect(res.body.codeAutoApproveEnabled).toBe(true);
    const row = db
      .prepare('SELECT code_auto_approve_enabled FROM projects WHERE id = ?')
      .get(PROJECT) as { code_auto_approve_enabled: number };
    expect(row.code_auto_approve_enabled).toBe(1);
    expect(broadcast).toHaveBeenCalledWith({
      type: 'project_code_auto_approve_changed',
      projectId: PROJECT,
      codeAutoApproveEnabled: true,
    });
  });
});

describe('POST /api/projects/:id/milestones — displayOrder default', () => {
  const post = (body: Record<string, unknown>) =>
    request(makeApp())
      .post(`/api/projects/${PROJECT}/milestones`)
      .set('Authorization', `Bearer ${DEVICE_TOKEN}`)
      .send(body);

  it('defaults to max(display_order) + 1 when none is supplied', async () => {
    db.prepare('UPDATE milestones SET display_order = 16 WHERE id = ?').run(
      MILESTONE,
    );
    const res = await post({ name: 'M17 Next' });
    expect(res.status).toBe(201);
    expect(res.body.displayOrder).toBe(17);
  });

  it('honours an explicit displayOrder', async () => {
    db.prepare('UPDATE milestones SET display_order = 16 WHERE id = ?').run(
      MILESTONE,
    );
    const res = await post({ name: 'Inserted', displayOrder: 5 });
    expect(res.status).toBe(201);
    expect(res.body.displayOrder).toBe(5);
  });

  it('gives the first milestone of a project displayOrder 0', async () => {
    db.prepare('DELETE FROM milestones').run();
    const res = await post({ name: 'First' });
    expect(res.status).toBe(201);
    expect(res.body.displayOrder).toBe(0);
  });
});

describe('PATCH /api/milestones/:id — grooming manifest sync', () => {
  const OLD_BOARD = 'adce9d8d-9b55-4407-9a6b-287acb89c63a';
  const NEW_BOARD = '85e3f20a-abc5-4ea5-9402-f8220bd511f6';
  let root: string;
  let manifestPath: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ms-patch-'));
    const dir = join(root, 'config', 'projects', 'proj-dir');
    mkdirSync(dir, { recursive: true });
    manifestPath = join(dir, 'grooming.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({ milestones: { M1: { board: OLD_BOARD } } }) + '\n',
    );
    prevEnv = process.env.ORCHESTRATOR_CONFIG_DIR;
    process.env.ORCHESTRATOR_CONFIG_DIR = join(root, 'config');
    db.prepare('UPDATE projects SET project_dir = ? WHERE id = ?').run(
      join(root, 'proj-dir'),
      PROJECT,
    );
    db.prepare('UPDATE milestones SET source_id = ? WHERE id = ?').run(
      OLD_BOARD,
      MILESTONE,
    );
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.ORCHESTRATOR_CONFIG_DIR;
    else process.env.ORCHESTRATOR_CONFIG_DIR = prevEnv;
    rmSync(root, { recursive: true, force: true });
  });

  const patch = (body: Record<string, unknown>) =>
    request(makeApp())
      .patch(`/api/milestones/${MILESTONE}`)
      .set('Authorization', `Bearer ${DEVICE_TOKEN}`)
      .send(body);

  it('updates the manifest board when sourceId changes', async () => {
    const res = await patch({ sourceId: NEW_BOARD });
    expect(res.status).toBe(200);
    const row = db
      .prepare('SELECT source_id FROM milestones WHERE id = ?')
      .get(MILESTONE) as { source_id: string };
    expect(row.source_id).toBe(NEW_BOARD);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.milestones.M1.board).toBe(NEW_BOARD);
  });

  it('leaves the manifest file unwritten when only the name changes', async () => {
    const before = readFileSync(manifestPath, 'utf8');
    const mtime = statSync(manifestPath).mtimeMs;
    const res = await patch({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(readFileSync(manifestPath, 'utf8')).toBe(before);
    expect(statSync(manifestPath).mtimeMs).toBe(mtime);
  });
});

describe('POST /api/milestones/:id/wrapped', () => {
  it('sets wrapped_at through updateMilestone (no raw SQL) and records a milestone_wrapped audit event', async () => {
    const before = Date.now();
    const res = await request(makeApp())
      .post(`/api/milestones/${MILESTONE}/wrapped`)
      .set('Authorization', `Bearer ${DEVICE_TOKEN}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.wrappedAt).toBeGreaterThanOrEqual(before);

    const row = db
      .prepare('SELECT wrapped_at FROM milestones WHERE id = ?')
      .get(MILESTONE) as { wrapped_at: number | null };
    expect(row.wrapped_at).not.toBeNull();
    expect(row.wrapped_at).toBeGreaterThanOrEqual(before);

    const events = db
      .prepare(`SELECT * FROM audit_log WHERE event_type = 'milestone_wrapped'`)
      .all() as { project_id: string; payload: string }[];
    expect(events).toHaveLength(1);
    expect(events[0].project_id).toBe(PROJECT);
    expect(JSON.parse(events[0].payload)).toEqual({
      milestoneId: MILESTONE,
      wrappedAt: row.wrapped_at,
    });
  });

  it('404s for an unknown milestone id', async () => {
    const res = await request(makeApp())
      .post('/api/milestones/does-not-exist/wrapped')
      .set('Authorization', `Bearer ${DEVICE_TOKEN}`)
      .send({});

    expect(res.status).toBe(404);
  });

  it('409s without moving the timestamp on a second call against an already-wrapped milestone', async () => {
    const first = await request(makeApp())
      .post(`/api/milestones/${MILESTONE}/wrapped`)
      .set('Authorization', `Bearer ${DEVICE_TOKEN}`)
      .send({});
    expect(first.status).toBe(200);

    const rowAfterFirst = db
      .prepare('SELECT wrapped_at FROM milestones WHERE id = ?')
      .get(MILESTONE) as { wrapped_at: number | null };

    const second = await request(makeApp())
      .post(`/api/milestones/${MILESTONE}/wrapped`)
      .set('Authorization', `Bearer ${DEVICE_TOKEN}`)
      .send({});
    expect(second.status).toBe(409);

    const rowAfterSecond = db
      .prepare('SELECT wrapped_at FROM milestones WHERE id = ?')
      .get(MILESTONE) as { wrapped_at: number | null };
    expect(rowAfterSecond.wrapped_at).toBe(rowAfterFirst.wrapped_at);

    const events = db
      .prepare(`SELECT * FROM audit_log WHERE event_type = 'milestone_wrapped'`)
      .all();
    expect(events).toHaveLength(1);
  });
});
