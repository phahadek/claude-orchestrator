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
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { insertProject } from '../../db/queries.js';
import { requireDeviceAuth } from '../../auth/DeviceAuth.js';
import { projectsRouter } from '../projects.js';

const PROJECT = 'proj-arch-flip';
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
