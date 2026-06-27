import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

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

import { projectsRouter } from '../routes/projects.js';
import type { CreateProjectInput } from '../projects/ProjectService.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

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
    baseBranch: 'dev',
    milestones: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

const REAL_DIR = __dirname;

// ── POST /projects — baseBranch ───────────────────────────────────────────────

describe('POST /api/projects — baseBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockReturnValue(undefined); // no conflict
    mockCreate.mockImplementation((input: CreateProjectInput) =>
      makeProject({ baseBranch: input.baseBranch ?? 'dev' }),
    );
  });

  it('saves baseBranch: main when provided', async () => {
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/projects')
      .send({ name: 'Repo', projectDir: REAL_DIR, baseBranch: 'main' });

    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: 'main' }),
    );
  });

  it('defaults baseBranch to dev when not provided', async () => {
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/projects')
      .send({ name: 'Repo', projectDir: REAL_DIR });

    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: 'dev' }),
    );
  });

  it('returns baseBranch in response body', async () => {
    mockCreate.mockReturnValue(makeProject({ baseBranch: 'main' }));
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/projects')
      .send({ name: 'Repo', projectDir: REAL_DIR, baseBranch: 'main' });

    expect(res.status).toBe(201);
    expect((res.body as Record<string, unknown>).baseBranch).toBe('main');
  });
});

// ── POST /projects — dataResidencyConfirmed ───────────────────────────────────

describe('POST /api/projects — dataResidencyConfirmed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockReturnValue(undefined);
    mockCreate.mockImplementation((input: CreateProjectInput) =>
      makeProject({ dataResidencyConfirmed: input.dataResidencyConfirmed ?? false }),
    );
  });

  it('passes dataResidencyConfirmed: true to ProjectService.create', async () => {
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/projects')
      .send({ name: 'Repo', projectDir: REAL_DIR, dataResidencyConfirmed: true });

    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ dataResidencyConfirmed: true }),
    );
    expect((res.body as Record<string, unknown>).dataResidencyConfirmed).toBe(true);
  });

  it('defaults dataResidencyConfirmed to false when not provided', async () => {
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/projects')
      .send({ name: 'Repo', projectDir: REAL_DIR });

    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ dataResidencyConfirmed: false }),
    );
  });
});

// ── PATCH /projects/:id — baseBranch ─────────────────────────────────────────

describe('PATCH /api/projects/:id — baseBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockReturnValue(makeProject());
    mockUpdate.mockImplementation(
      (_id: string, patch: Record<string, unknown>) =>
        makeProject({ baseBranch: patch.base_branch ?? 'dev' }),
    );
  });

  it('updates base_branch when baseBranch is provided', async () => {
    const app = buildApp();
    const res = await supertest(app)
      .patch('/api/projects/p1')
      .send({ baseBranch: 'main' });

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ base_branch: 'main' }),
    );
  });

  it('does not set base_branch in patch when baseBranch is absent', async () => {
    const app = buildApp();
    const res = await supertest(app)
      .patch('/api/projects/p1')
      .send({ name: 'Updated' });

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      'p1',
      expect.not.objectContaining({ base_branch: expect.anything() }),
    );
  });

  it('returns updated baseBranch in response body', async () => {
    mockUpdate.mockReturnValue(makeProject({ baseBranch: 'main' }));
    const app = buildApp();
    const res = await supertest(app)
      .patch('/api/projects/p1')
      .send({ baseBranch: 'main' });

    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).baseBranch).toBe('main');
  });
});
