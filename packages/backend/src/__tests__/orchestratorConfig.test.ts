import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../config.js', () => ({
  normalizePath: (p: string) => p,
  config: { notionApiKey: 'test-key' },
}));

vi.mock('../db/queries.js', () => ({
  upsertTaskCache: vi.fn(),
  getCacheAge: vi.fn().mockReturnValue(Infinity),
  getTaskCache: vi.fn().mockReturnValue(null),
  updateTaskCacheStatus: vi.fn(),
  getMergeReadyPRs: vi.fn().mockReturnValue([]),
}));

vi.mock('../projects/ProjectService.js', () => ({
  ProjectService: {
    list: vi.fn().mockReturnValue([]),
    getById: vi.fn().mockReturnValue(null),
    getMilestone: vi.fn().mockReturnValue(null),
  },
}));

// Import after mocks
import { projectsRouter } from '../routes/projects.js';
import { ProjectService } from '../projects/ProjectService.js';

// ── Test app ─────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', projectsRouter);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/projects/:id/orchestrator-config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-route-'));
    vi.mocked(ProjectService.getById).mockReturnValue(null);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns 404 when project does not exist', async () => {
    vi.mocked(ProjectService.getById).mockReturnValue(null);
    const res = await supertest(buildApp()).get(
      '/api/projects/missing-id/orchestrator-config',
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      error: expect.stringContaining('missing-id'),
    });
  });

  it('returns present: false and default values when .claude-orchestrator.yml is absent', async () => {
    vi.mocked(ProjectService.getById).mockReturnValue({
      id: 'proj-1',
      projectDir: tmpDir,
    } as never);

    const res = await supertest(buildApp()).get(
      '/api/projects/proj-1/orchestrator-config',
    );
    expect(res.status).toBe(200);
    expect(res.body.present).toBe(false);
    expect(res.body.config).toMatchObject({
      autofix: [],
      verify: [],
      ci_check_name: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    });
  });

  it('returns present: true and parsed values when .claude-orchestrator.yml exists', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude-orchestrator.yml'),
      [
        'autofix:',
        '  - npm run format:write',
        'verify:',
        '  - npx tsc --noEmit',
        'allowed_tools:',
        '  - Bash(node:*)',
        'ci_check_name:',
        '  - build',
        'bash_rules:',
        '  - Use npx for bare commands.',
        'bootstrap_script: ./scripts/setup.sh',
      ].join('\n'),
      'utf-8',
    );
    vi.mocked(ProjectService.getById).mockReturnValue({
      id: 'proj-2',
      projectDir: tmpDir,
    } as never);

    const res = await supertest(buildApp()).get(
      '/api/projects/proj-2/orchestrator-config',
    );
    expect(res.status).toBe(200);
    expect(res.body.present).toBe(true);
    expect(res.body.config).toMatchObject({
      autofix: ['npm run format:write'],
      verify: ['npx tsc --noEmit'],
      allowed_tools: ['Bash(node:*)'],
      ci_check_name: ['build'],
      bash_rules: ['Use npx for bare commands.'],
      bootstrap_script: './scripts/setup.sh',
    });
  });
});
