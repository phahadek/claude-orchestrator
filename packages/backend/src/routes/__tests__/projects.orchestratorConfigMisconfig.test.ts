/**
 * GET /api/projects/:id/orchestrator-config must surface a gate-command vs
 * allowed_tools misconfiguration (naming the field, command, and binary)
 * even though loadOrchestratorConfig itself never throws on it — see
 * orchestrator-config.ts's validateGateCommandsAgainstAllowedTools.
 */

import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { insertProject } from '../../db/queries.js';
import { requireDeviceAuth } from '../../auth/DeviceAuth.js';
import { projectsRouter } from '../projects.js';

const PROJECT = 'proj-orch-config-misconfig';
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

describe('GET /api/projects/:id/orchestrator-config — misconfigurations', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-config-route-'));
    fs.writeFileSync(
      path.join(projectDir, '.claude-orchestrator.yml'),
      'analyze:\n  - some-uncovered-linter check\n',
    );

    db.prepare('DELETE FROM devices').run();
    db.prepare('DELETE FROM projects').run();

    insertDevice();
    insertProject({
      id: PROJECT,
      name: 'Project With Stale Config',
      project_dir: projectDir,
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('names the binary, command, and field for an uncovered analyze command', async () => {
    const res = await request(makeApp())
      .get(`/api/projects/${PROJECT}/orchestrator-config`)
      .set('Authorization', `Bearer ${DEVICE_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.misconfigurations).toEqual([
      expect.objectContaining({
        field: 'analyze',
        command: 'some-uncovered-linter check',
        binary: 'some-uncovered-linter',
      }),
    ]);
    expect(res.body.misconfigurations[0].message).toContain(
      'some-uncovered-linter',
    );
  });

  it('reports no misconfigurations when the config is clean', async () => {
    fs.writeFileSync(
      path.join(projectDir, '.claude-orchestrator.yml'),
      'verify:\n  - git status\n',
    );

    const res = await request(makeApp())
      .get(`/api/projects/${PROJECT}/orchestrator-config`)
      .set('Authorization', `Bearer ${DEVICE_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.misconfigurations).toEqual([]);
  });
});
