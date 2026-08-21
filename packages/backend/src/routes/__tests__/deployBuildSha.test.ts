/**
 * Tests for GET /api/deploy/build-sha (packages/backend/src/routes/deploy.ts).
 *
 * AC: the route returns the SHA embedded into this process's own build —
 * the identity check verify's playbook step curls to confirm which build is
 * actually serving. The module reads it once, from the path named by
 * DEPLOY_BUILD_SHA_PATH (npm run build writes the real one to dist/), so the
 * env var must be set before the route module is first imported.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('../../deploy/deployService.js', () => ({
  reportProjectDeploy: vi.fn(),
  getLatestDeployRun: vi.fn(),
  listDeployRunEvents: vi.fn(),
  DeployRunConflictError: class DeployRunConflictError extends Error {},
}));

vi.mock('../../deploy/DeployOrchestrator.js', () => ({
  DeployOrchestrator: vi
    .fn()
    .mockImplementation(() => ({ startDeploy: vi.fn() })),
  buildDeployAgenticTaskId: vi.fn(),
}));

vi.mock('../../db/queries.js', () => ({
  getProjectRowById: vi.fn(),
  getProjectDeployedShaRow: vi.fn(),
  listMergedSince: vi.fn(),
  getSession: vi.fn(),
  hasActiveCapabilityRequestForSession: vi.fn(),
  markSessionDone: vi.fn(),
  setSessionTerminalCompletionReason: vi.fn(),
  insertCompletingSignal: vi.fn(),
  TERMINAL_SESSION_STATUSES: new Set(),
  getLatestOpsSessionByTaskId: vi.fn(),
}));

vi.mock('../../deploy/loadPlaybook.js', () => ({
  loadDeployPlaybook: vi.fn(),
}));

let tmpDir: string;
let buildShaPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-build-sha-'));
  buildShaPath = path.join(tmpDir, 'build-sha.txt');
  fs.writeFileSync(buildShaPath, 'abc123def456789\n');
  process.env.DEPLOY_BUILD_SHA_PATH = buildShaPath;
});

afterAll(() => {
  delete process.env.DEPLOY_BUILD_SHA_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /api/deploy/build-sha', () => {
  it('returns the SHA embedded into this build at npm run build time', async () => {
    const { createDeployRouter } = await import('../deploy.js');
    const app = express();
    app.use('/api', createDeployRouter());

    const res = await request(app).get('/api/deploy/build-sha');

    expect(res.status).toBe(200);
    // Plain text, not a JSON envelope — verify's identity_capture curls this
    // endpoint and compares the raw body byte-for-byte against target_sha.
    expect(res.text).toBe('abc123def456789');
  });
});
