import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const {
  mockCreate,
  mockUpdate,
  mockGetById,
  mockGetMilestone,
  mockCreateMilestone,
  mockUpdateMilestone,
  mockNormalizeNotionId,
  mockGithubGetMilestone,
  mockJiraGetIssue,
} = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockGetById: vi.fn(),
  mockGetMilestone: vi.fn(),
  mockCreateMilestone: vi.fn(),
  mockUpdateMilestone: vi.fn(),
  mockNormalizeNotionId: vi.fn(),
  mockGithubGetMilestone: vi.fn(),
  mockJiraGetIssue: vi.fn(),
}));

vi.mock('../projects/ProjectService.js', () => ({
  ProjectService: {
    list: vi.fn().mockReturnValue([]),
    getById: mockGetById,
    create: mockCreate,
    update: mockUpdate,
    delete: vi.fn().mockReturnValue(true),
    listMilestones: vi.fn().mockReturnValue([]),
    getMilestone: mockGetMilestone,
    createMilestone: mockCreateMilestone,
    updateMilestone: mockUpdateMilestone,
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
  normalizeNotionId: mockNormalizeNotionId,
}));

vi.mock('../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('../config.js', () => ({
  normalizePath: (p: string) => p,
  JIRA_HOST: 'https://test.atlassian.net',
  JIRA_TOKEN: 'test-token',
  JIRA_EMAIL: 'test@test.com',
}));

vi.mock('../github/GitHubClient.js', () => ({
  GitHubClient: vi.fn().mockImplementation(() => ({
    listMilestones: vi.fn().mockResolvedValue([]),
    getMilestoneByNumber: mockGithubGetMilestone,
  })),
}));

vi.mock('../tasks/JiraClient.js', () => ({
  JiraClient: vi.fn().mockImplementation(() => ({
    getIssue: mockJiraGetIssue,
  })),
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

// ── POST /projects/:id/milestones — sourceId format validation ────────────────

describe('POST /api/projects/:id/milestones — sourceId format validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNormalizeNotionId.mockImplementation((id: string) =>
      /^[0-9a-f-]{36}$/.test(id) ? id : null,
    );
  });

  it('rejects GitHub sourceId that is not an integer', async () => {
    mockGetById.mockReturnValue(makeProject({ taskSource: 'github' }));
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/projects/p1/milestones')
      .send({ name: 'M1', sourceId: 'not-a-number' });

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/integer/i);
  });

  it('rejects GitHub sourceId that is zero', async () => {
    mockGetById.mockReturnValue(makeProject({ taskSource: 'github' }));
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/projects/p1/milestones')
      .send({ name: 'M1', sourceId: '0' });

    expect(res.status).toBe(400);
  });

  it('accepts valid GitHub sourceId (positive integer string)', async () => {
    mockGetById.mockReturnValue(makeProject({ taskSource: 'github' }));
    mockCreateMilestone.mockReturnValue({
      id: 'm1',
      projectId: 'p1',
      name: 'M1',
      sourceId: '42',
      displayOrder: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/projects/p1/milestones')
      .send({ name: 'M1', sourceId: '42' });

    expect(res.status).toBe(201);
  });

  it('rejects Jira sourceId with wrong format', async () => {
    mockGetById.mockReturnValue(makeProject({ taskSource: 'jira' }));
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/projects/p1/milestones')
      .send({ name: 'M1', sourceId: 'proj-123' });

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/PROJ-123/i);
  });

  it('accepts valid Jira Epic key', async () => {
    mockGetById.mockReturnValue(makeProject({ taskSource: 'jira' }));
    mockCreateMilestone.mockReturnValue({
      id: 'm1',
      projectId: 'p1',
      name: 'M1',
      sourceId: 'PROJ-123',
      displayOrder: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/projects/p1/milestones')
      .send({ name: 'M1', sourceId: 'PROJ-123' });

    expect(res.status).toBe(201);
  });

  it('rejects Notion sourceId that does not parse as a UUID', async () => {
    mockNormalizeNotionId.mockReturnValue(null);
    mockGetById.mockReturnValue(makeProject({ taskSource: 'notion' }));
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/projects/p1/milestones')
      .send({ name: 'M1', sourceId: 'not-a-notion-id' });

    expect(res.status).toBe(400);
  });

  it('accepts null sourceId for any source', async () => {
    mockGetById.mockReturnValue(makeProject({ taskSource: 'github' }));
    mockCreateMilestone.mockReturnValue({
      id: 'm1',
      projectId: 'p1',
      name: 'M1',
      sourceId: null,
      displayOrder: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/projects/p1/milestones')
      .send({ name: 'M1' });

    expect(res.status).toBe(201);
  });
});

// ── PATCH /milestones/:id — sourceId format validation ────────────────────────

describe('PATCH /api/milestones/:id — sourceId format validation', () => {
  const milestone = {
    id: 'ms1',
    projectId: 'p1',
    name: 'Old',
    sourceId: null,
    displayOrder: 0,
    createdAt: 0,
    updatedAt: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMilestone.mockReturnValue(milestone);
    mockUpdateMilestone.mockReturnValue({ ...milestone, name: 'Updated' });
  });

  it('rejects invalid GitHub sourceId on patch', async () => {
    mockGetById.mockReturnValue(makeProject({ taskSource: 'github' }));
    const app = buildApp();
    const res = await supertest(app)
      .patch('/api/milestones/ms1')
      .send({ sourceId: 'abc' });

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/integer/i);
  });

  it('rejects invalid Jira Epic key on patch', async () => {
    mockGetById.mockReturnValue(makeProject({ taskSource: 'jira' }));
    const app = buildApp();
    const res = await supertest(app)
      .patch('/api/milestones/ms1')
      .send({ sourceId: 'lowercase-123' });

    expect(res.status).toBe(400);
  });

  it('accepts valid GitHub sourceId on patch', async () => {
    mockGetById.mockReturnValue(makeProject({ taskSource: 'github' }));
    const app = buildApp();
    const res = await supertest(app)
      .patch('/api/milestones/ms1')
      .send({ sourceId: '7' });

    expect(res.status).toBe(200);
  });
});

// ── GET /projects/:id/github/validate-milestone ───────────────────────────────

describe('GET /api/projects/:id/github/validate-milestone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockReturnValue(
      makeProject({
        taskSource: 'github',
        taskSourceConfig: JSON.stringify({ owner: 'org', repo: 'repo' }),
      }),
    );
  });

  it('returns 400 for non-integer id', async () => {
    const app = buildApp();
    const res = await supertest(app).get(
      '/api/projects/p1/github/validate-milestone?id=abc',
    );

    expect(res.status).toBe(400);
  });

  it('returns milestone info for a valid number', async () => {
    mockGithubGetMilestone.mockResolvedValue({
      id: 3,
      title: 'Sprint 1',
      state: 'open',
      openIssues: 5,
      closedIssues: 2,
    });
    const app = buildApp();
    const res = await supertest(app).get(
      '/api/projects/p1/github/validate-milestone?id=3',
    );

    expect(res.status).toBe(200);
    expect((res.body as { title: string }).title).toBe('Sprint 1');
  });

  it('returns 400 when GitHub API throws', async () => {
    mockGithubGetMilestone.mockRejectedValue(new Error('Not Found'));
    const app = buildApp();
    const res = await supertest(app).get(
      '/api/projects/p1/github/validate-milestone?id=99',
    );

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('Not Found');
  });

  it('returns 400 for project with wrong task source', async () => {
    mockGetById.mockReturnValue(makeProject({ taskSource: 'notion' }));
    const app = buildApp();
    const res = await supertest(app).get(
      '/api/projects/p1/github/validate-milestone?id=1',
    );

    expect(res.status).toBe(400);
  });
});

// ── GET /projects/:id/jira/validate-milestone ─────────────────────────────────

describe('GET /api/projects/:id/jira/validate-milestone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockReturnValue(
      makeProject({
        taskSource: 'jira',
        taskSourceConfig: JSON.stringify({
          host: 'https://test.atlassian.net',
          project_key: 'PROJ',
        }),
      }),
    );
  });

  it('returns 400 for malformed Epic key', async () => {
    const app = buildApp();
    const res = await supertest(app).get(
      '/api/projects/p1/jira/validate-milestone?id=proj-123',
    );

    expect(res.status).toBe(400);
  });

  it('returns epic info for a valid Epic key', async () => {
    mockJiraGetIssue.mockResolvedValue({
      key: 'PROJ-123',
      fields: {
        summary: 'My Epic',
        status: { name: 'In Progress' },
        issuetype: { name: 'Epic' },
      },
    });
    const app = buildApp();
    const res = await supertest(app).get(
      '/api/projects/p1/jira/validate-milestone?id=PROJ-123',
    );

    expect(res.status).toBe(200);
    expect((res.body as { key: string }).key).toBe('PROJ-123');
    expect((res.body as { summary: string }).summary).toBe('My Epic');
  });

  it('returns 400 when Jira API throws', async () => {
    mockJiraGetIssue.mockRejectedValue(new Error('Issue not found'));
    const app = buildApp();
    const res = await supertest(app).get(
      '/api/projects/p1/jira/validate-milestone?id=PROJ-999',
    );

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('Issue not found');
  });

  it('returns 400 for project with wrong task source', async () => {
    mockGetById.mockReturnValue(makeProject({ taskSource: 'notion' }));
    const app = buildApp();
    const res = await supertest(app).get(
      '/api/projects/p1/jira/validate-milestone?id=PROJ-1',
    );

    expect(res.status).toBe(400);
  });
});
