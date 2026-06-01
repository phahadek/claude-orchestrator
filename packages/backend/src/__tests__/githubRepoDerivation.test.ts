import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import fs from 'fs';
import path from 'path';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockCreate, mockUpdate, mockGetById } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockGetById: vi.fn(),
}));

vi.mock('../projects/ProjectService.js', () => ({
  ProjectService: {
    list: vi.fn().mockReturnValue([]),
    getById: mockGetById,
    create: mockCreate,
    update: mockUpdate,
    delete: vi.fn().mockReturnValue(true),
    listMilestones: vi.fn().mockReturnValue([]),
    getMilestone: vi.fn(),
    createMilestone: vi.fn(),
    updateMilestone: vi.fn(),
    deleteMilestone: vi.fn(),
    count: vi.fn().mockReturnValue(0),
    setDataResidencyConfirmed: vi.fn(),
  },
}));

vi.mock('../db/queries.js', () => ({
  getMergeReadyPRs: vi.fn().mockReturnValue([]),
}));

vi.mock('../notion/NotionClient.js', () => ({
  NotionClient: class {},
  normalizeNotionId: vi.fn(),
}));

vi.mock('../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('../config.js', () => ({
  normalizePath: (p: string) => p,
}));

vi.mock('../github/GitHubClient.js', () => ({
  GitHubClient: class {
    async getRepo() {
      return { full_name: 'owner/repo' };
    }
  },
}));

import { projectsRouter } from '../routes/projects.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', projectsRouter);
  return app;
}

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    name: 'Test',
    projectDir: '/test',
    contextUrl: null,
    githubRepo: null,
    taskSource: 'notion',
    taskSourceConfig: null,
    gitMode: 'github',
    autoLaunchEnabled: false,
    autoLaunchMilestoneId: null,
    autoMergeEnabled: false,
    milestoneBranching: null,
    nonMilestoneSourceConfig: null,
    dataResidencyConfirmed: false,
    milestones: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

// Use a real directory that exists on disk so isExistingDirectory() passes without mocking fs.
const REAL_DIR = __dirname;

// ── POST /projects — github_repo derivation ────────────────────────────────────

describe('POST /api/projects — github_repo derivation from GitHub task source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockReturnValue(undefined); // no conflict
    mockCreate.mockImplementation((input: Record<string, unknown>) =>
      makeProject({ ...input, id: 'new-id' }),
    );
  });

  it('derives github_repo from taskSourceConfig when taskSource is github', async () => {
    const res = await supertest(buildApp())
      .post('/api/projects')
      .send({
        name: 'GH Proj',
        projectDir: REAL_DIR,
        taskSource: 'github',
        taskSourceConfig: { owner: 'myorg', repo: 'myrepo' },
      });

    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ githubRepo: 'myorg/myrepo' }),
    );
  });

  it('derived github_repo overrides an empty/missing body.githubRepo for github task source', async () => {
    const res = await supertest(buildApp())
      .post('/api/projects')
      .send({
        name: 'GH Proj',
        projectDir: REAL_DIR,
        taskSource: 'github',
        taskSourceConfig: { owner: 'acme', repo: 'frontend' },
        githubRepo: '', // would normally produce null
      });

    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ githubRepo: 'acme/frontend' }),
    );
  });

  it('preserves explicit githubRepo for non-github task source (notion)', async () => {
    const res = await supertest(buildApp()).post('/api/projects').send({
      name: 'Notion Proj',
      projectDir: REAL_DIR,
      taskSource: 'notion',
      githubRepo: 'org/legacy-repo',
    });

    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ githubRepo: 'org/legacy-repo' }),
    );
  });

  it('preserves explicit githubRepo for yaml task source', async () => {
    const res = await supertest(buildApp()).post('/api/projects').send({
      name: 'YAML Proj',
      projectDir: REAL_DIR,
      taskSource: 'yaml',
      githubRepo: 'org/yaml-repo',
    });

    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ githubRepo: 'org/yaml-repo' }),
    );
  });
});

// ── PATCH /projects/:id — github_repo derivation ──────────────────────────────

describe('PATCH /api/projects/:id — github_repo derivation from GitHub task source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockReturnValue(
      makeProject({
        taskSource: 'github',
        taskSourceConfig: '{"owner":"old","repo":"old-repo"}',
      }),
    );
    mockUpdate.mockImplementation(
      (_id: string, patch: Record<string, unknown>) =>
        makeProject({ ...patch }),
    );
  });

  it('derives github_repo when taskSourceConfig is updated', async () => {
    const res = await supertest(buildApp())
      .patch('/api/projects/p1')
      .send({
        taskSourceConfig: { owner: 'neworg', repo: 'newrepo' },
      });

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ github_repo: 'neworg/newrepo' }),
    );
  });

  it('does not set github_repo when taskSourceConfig is cleared (null)', async () => {
    const res = await supertest(buildApp())
      .patch('/api/projects/p1')
      .send({ taskSourceConfig: null });

    expect(res.status).toBe(200);
    const patch = mockUpdate.mock.calls[0][1] as Record<string, unknown>;
    expect(patch.github_repo).toBeUndefined();
  });

  it('does not override explicit githubRepo in body for non-github config updates', async () => {
    const res = await supertest(buildApp())
      .patch('/api/projects/p1')
      .send({ githubRepo: 'org/explicit-repo' });

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ github_repo: 'org/explicit-repo' }),
    );
  });
});

// ── schema.ts migration ────────────────────────────────────────────────────────

describe('schema.ts — github_repo backfill migration', () => {
  it('includes a migration UPDATE for github task source projects with null github_repo', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'schema.ts'),
      'utf-8',
    );
    expect(source).toContain("task_source = 'github'");
    expect(source).toContain('github_repo IS NULL');
    expect(source).toContain("json_extract(task_source_config, '$.owner')");
    expect(source).toContain("json_extract(task_source_config, '$.repo')");
  });

  it('migration UPDATE sets github_repo to owner/repo derived from task_source_config', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'schema.ts'),
      'utf-8',
    );
    // Must concatenate owner + '/' + repo
    expect(source).toMatch(/json_extract.*owner.*\/.*json_extract.*repo/s);
  });
});
