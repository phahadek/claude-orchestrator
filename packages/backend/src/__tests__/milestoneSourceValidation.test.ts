import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import type { Project } from '../projects/ProjectService.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../config.js', () => ({
  normalizePath: (p: string) => p,
  config: { notionApiKey: 'test-key' },
  GITHUB_TOKEN: 'test-github-token',
  GITHUB_REPO: 'acme/app',
  JIRA_HOST: 'https://mycompany.atlassian.net',
  JIRA_TOKEN: 'test-jira-token',
  JIRA_EMAIL: 'user@example.com',
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
    listMilestones: vi.fn().mockReturnValue([]),
    createMilestone: vi.fn().mockReturnValue({
      id: 'new-ms',
      projectId: 'p1',
      name: 'Test',
      sourceId: null,
      displayOrder: 0,
      createdAt: 0,
      updatedAt: 0,
    }),
    updateMilestone: vi.fn(),
    deleteMilestone: vi.fn(),
  },
}));

// Import after mocks
import { projectsRouter } from '../routes/projects.js';
import { ProjectService } from '../projects/ProjectService.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fakeProject(overrides: Partial<Project>): Project {
  return {
    id: 'p1',
    name: 'Test Project',
    projectDir: '/tmp/test',
    contextUrl: null,
    githubRepo: null,
    taskSource: 'notion',
    gitMode: 'github',
    autoLaunchEnabled: false,
    autoLaunchMilestoneId: null,
    autoMergeEnabled: false,
    milestoneBranching: null,
    nonMilestoneSourceConfig: null,
    taskSourceConfig: null,
    dataResidencyConfirmed: false,
    baseBranch: 'main',
    createdAt: 0,
    updatedAt: 0,
    milestones: [],
    ...overrides,
  };
}

// ── Test app ──────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', projectsRouter);
  return app;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(handler: (url: string) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => Promise.resolve(handler(url))),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ProjectService.getById).mockReturnValue(null);
  vi.mocked(ProjectService.getMilestone).mockReturnValue(null);
  vi.mocked(ProjectService.createMilestone).mockReturnValue({
    id: 'new-ms',
    projectId: 'p1',
    name: 'Test',
    sourceId: null,
    displayOrder: 0,
    createdAt: 0,
    updatedAt: 0,
  });
});

// ── GitHub milestone validation ───────────────────────────────────────────────

describe('GET /api/projects/:id/github/validate-milestone', () => {
  const PROJECT_ID = 'proj-github-1';
  const githubProject = fakeProject({
    id: PROJECT_ID,
    taskSource: 'github',
    taskSourceConfig: JSON.stringify({ owner: 'acme', repo: 'app' }),
  });

  it('returns 404 when project not found', async () => {
    const res = await supertest(buildApp()).get(
      `/api/projects/${PROJECT_ID}/github/validate-milestone?number=1`,
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 when project is not github source', async () => {
    vi.mocked(ProjectService.getById).mockReturnValue(
      fakeProject({ id: PROJECT_ID, taskSource: 'notion' }),
    );
    const res = await supertest(buildApp()).get(
      `/api/projects/${PROJECT_ID}/github/validate-milestone?number=1`,
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: expect.stringContaining('GitHub'),
    });
  });

  it('returns 400 when number param is missing', async () => {
    vi.mocked(ProjectService.getById).mockReturnValue(githubProject);
    const res = await supertest(buildApp()).get(
      `/api/projects/${PROJECT_ID}/github/validate-milestone`,
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: expect.stringContaining('number'),
    });
  });

  it('returns 400 when number is not a positive integer', async () => {
    vi.mocked(ProjectService.getById).mockReturnValue(githubProject);
    const res = await supertest(buildApp()).get(
      `/api/projects/${PROJECT_ID}/github/validate-milestone?number=abc`,
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: expect.stringContaining('positive integer'),
    });
  });

  it('returns milestone info for a valid number', async () => {
    vi.mocked(ProjectService.getById).mockReturnValue(githubProject);
    mockFetch((url) => {
      if (url.includes('/repos/acme/app/milestones/3')) {
        return jsonResponse({
          number: 3,
          node_id: 'node-3',
          title: 'Sprint 3',
          description: null,
          state: 'open',
          open_issues: 5,
          closed_issues: 2,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-15T00:00:00Z',
        });
      }
      return jsonResponse({ message: 'not found' }, 404);
    });

    const res = await supertest(buildApp()).get(
      `/api/projects/${PROJECT_ID}/github/validate-milestone?number=3`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: 'github-milestone',
      number: 3,
      title: 'Sprint 3',
      state: 'open',
    });
  });

  it('returns 400 when GitHub API returns an error', async () => {
    vi.mocked(ProjectService.getById).mockReturnValue(githubProject);
    mockFetch((_url) => jsonResponse({ message: 'Not Found' }, 404));

    const res = await supertest(buildApp()).get(
      `/api/projects/${PROJECT_ID}/github/validate-milestone?number=999`,
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });
});

// ── Jira Epic validation ──────────────────────────────────────────────────────

describe('GET /api/projects/:id/jira/validate-epic', () => {
  const PROJECT_ID = 'proj-jira-1';
  const jiraProject = fakeProject({
    id: PROJECT_ID,
    taskSource: 'jira',
    taskSourceConfig: JSON.stringify({
      host: 'https://mycompany.atlassian.net',
      project_key: 'MYPROJ',
    }),
  });

  it('returns 404 when project not found', async () => {
    const res = await supertest(buildApp()).get(
      `/api/projects/${PROJECT_ID}/jira/validate-epic?key=PROJ-1`,
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 when project is not jira source', async () => {
    vi.mocked(ProjectService.getById).mockReturnValue(
      fakeProject({ id: PROJECT_ID, taskSource: 'github' }),
    );
    const res = await supertest(buildApp()).get(
      `/api/projects/${PROJECT_ID}/jira/validate-epic?key=PROJ-1`,
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('Jira') });
  });

  it('returns 400 when key param is missing', async () => {
    vi.mocked(ProjectService.getById).mockReturnValue(jiraProject);
    const res = await supertest(buildApp()).get(
      `/api/projects/${PROJECT_ID}/jira/validate-epic`,
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('key') });
  });

  it('returns 400 when key is not a valid Jira Epic key', async () => {
    vi.mocked(ProjectService.getById).mockReturnValue(jiraProject);
    const res = await supertest(buildApp()).get(
      `/api/projects/${PROJECT_ID}/jira/validate-epic?key=not-valid`,
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: expect.stringContaining('PROJECT-123'),
    });
  });

  it('returns Epic info for a valid key', async () => {
    vi.mocked(ProjectService.getById).mockReturnValue(jiraProject);
    mockFetch((url) => {
      if (url.includes('/issue/MYPROJ-42')) {
        return jsonResponse({
          id: '10042',
          key: 'MYPROJ-42',
          fields: {
            summary: 'User authentication epic',
            status: { name: 'In Progress' },
            issuetype: { name: 'Epic' },
            priority: null,
            description: null,
          },
        });
      }
      return jsonResponse({ message: 'not found' }, 404);
    });

    const res = await supertest(buildApp()).get(
      `/api/projects/${PROJECT_ID}/jira/validate-epic?key=MYPROJ-42`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: 'jira-epic',
      key: 'MYPROJ-42',
      summary: 'User authentication epic',
    });
  });

  it('returns 400 when Jira API returns an error', async () => {
    vi.mocked(ProjectService.getById).mockReturnValue(jiraProject);
    mockFetch((_url) =>
      jsonResponse({ errorMessages: ['Issue does not exist'] }, 404),
    );

    const res = await supertest(buildApp()).get(
      `/api/projects/${PROJECT_ID}/jira/validate-epic?key=MYPROJ-999`,
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });
});

// ── Backend format validation (POST /api/projects/:id/milestones) ─────────────

describe('POST /api/projects/:id/milestones — sourceId format validation', () => {
  it('rejects a non-integer sourceId for github projects', async () => {
    vi.mocked(ProjectService.getById).mockReturnValue(
      fakeProject({ id: 'p1', taskSource: 'github' }),
    );
    const res = await supertest(buildApp())
      .post('/api/projects/p1/milestones')
      .send({ name: 'Sprint', sourceId: 'not-a-number' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: expect.stringContaining('positive integer'),
    });
  });

  it('rejects a malformed Jira Epic key for jira projects', async () => {
    vi.mocked(ProjectService.getById).mockReturnValue(
      fakeProject({ id: 'p1', taskSource: 'jira' }),
    );
    const res = await supertest(buildApp())
      .post('/api/projects/p1/milestones')
      .send({ name: 'Epic', sourceId: 'proj-1' }); // lowercase — invalid
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: expect.stringContaining('PROJECT-123'),
    });
  });

  it('rejects an invalid sourceId for notion projects', async () => {
    vi.mocked(ProjectService.getById).mockReturnValue(
      fakeProject({ id: 'p1', taskSource: 'notion' }),
    );
    const res = await supertest(buildApp())
      .post('/api/projects/p1/milestones')
      .send({ name: 'Board', sourceId: 'not-a-notion-id' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: expect.stringContaining('Notion'),
    });
  });

  it('accepts a valid integer sourceId for github projects', async () => {
    vi.mocked(ProjectService.getById).mockReturnValue(
      fakeProject({ id: 'p1', taskSource: 'github' }),
    );
    vi.mocked(ProjectService.createMilestone).mockReturnValue({
      id: 'new-ms',
      projectId: 'p1',
      name: 'Sprint 1',
      sourceId: '5',
      displayOrder: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    const res = await supertest(buildApp())
      .post('/api/projects/p1/milestones')
      .send({ name: 'Sprint 1', sourceId: '5' });
    expect(res.status).toBe(201);
  });

  it('accepts a valid Jira Epic key', async () => {
    vi.mocked(ProjectService.getById).mockReturnValue(
      fakeProject({ id: 'p1', taskSource: 'jira' }),
    );
    vi.mocked(ProjectService.createMilestone).mockReturnValue({
      id: 'new-ms',
      projectId: 'p1',
      name: 'Auth Epic',
      sourceId: 'PROJ-42',
      displayOrder: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    const res = await supertest(buildApp())
      .post('/api/projects/p1/milestones')
      .send({ name: 'Auth Epic', sourceId: 'PROJ-42' });
    expect(res.status).toBe(201);
  });

  it('allows any sourceId for yaml projects', async () => {
    vi.mocked(ProjectService.getById).mockReturnValue(
      fakeProject({ id: 'p1', taskSource: 'yaml' }),
    );
    vi.mocked(ProjectService.createMilestone).mockReturnValue({
      id: 'new-ms',
      projectId: 'p1',
      name: 'M1',
      sourceId: 'anything-goes',
      displayOrder: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    const res = await supertest(buildApp())
      .post('/api/projects/p1/milestones')
      .send({ name: 'M1', sourceId: 'anything-goes' });
    expect(res.status).toBe(201);
  });
});
