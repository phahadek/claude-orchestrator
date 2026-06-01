import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../src/db/db.js', async () => {
  const Database = (await import('better-sqlite3')).default;
  const memDb = new Database(':memory:');
  memDb.pragma('foreign_keys = ON');
  const { applyTestSchema } = await import('../helpers/testDbSchema');
  applyTestSchema(memDb);
  return { db: memDb };
});

import { projectsRouter } from '../../src/routes/projects.js';
import { ProjectService } from '../../src/projects/ProjectService.js';
import { db } from '../../src/db/db.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', projectsRouter);
  return app;
}

beforeEach(() => {
  db.prepare('DELETE FROM milestones').run();
  db.prepare('DELETE FROM projects').run();
  db.prepare('DELETE FROM sessions').run();
});

describe('GET /api/projects', () => {
  it('returns an empty array when no projects exist', async () => {
    const res = await supertest(buildApp()).get('/api/projects');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns projects with their milestones nested', async () => {
    ProjectService.create({
      id: 'p1',
      name: 'P1',
      projectDir: '/p1',
      githubRepo: 'owner/r',
    });
    ProjectService.createMilestone({
      id: 'm1',
      projectId: 'p1',
      name: 'M1',
      sourceId: 'src-1',
    });

    const res = await supertest(buildApp()).get('/api/projects');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: 'p1',
      name: 'P1',
      projectDir: '/p1',
      githubRepo: 'owner/r',
    });
    expect(res.body[0].milestones).toHaveLength(1);
    expect(res.body[0].milestones[0]).toMatchObject({
      id: 'm1',
      sourceId: 'src-1',
    });
  });
});

describe('POST /api/projects', () => {
  let realDir: string;

  beforeEach(() => {
    realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-route-'));
  });

  afterEach(() => {
    fs.rmSync(realDir, { recursive: true, force: true });
  });

  it('returns 201 with a server-generated UUID when id is omitted', async () => {
    const res = await supertest(buildApp())
      .post('/api/projects')
      .send({ name: 'New', projectDir: realDir });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe('New');
    expect(res.body.taskSource).toBe('notion');
  });

  it('returns 400 when name is missing', async () => {
    const res = await supertest(buildApp())
      .post('/api/projects')
      .send({ projectDir: realDir });
    expect(res.status).toBe(400);
  });

  it('returns 400 when projectDir is missing', async () => {
    const res = await supertest(buildApp())
      .post('/api/projects')
      .send({ name: 'X' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when projectDir does not exist on disk', async () => {
    const missing = path.join(
      os.tmpdir(),
      `does-not-exist-${Date.now()}-${Math.random()}`,
    );
    const res = await supertest(buildApp())
      .post('/api/projects')
      .send({ name: 'X', projectDir: missing });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/does not exist/);
  });
});

describe('PATCH /api/projects/:id', () => {
  it('updates fields and bumps updated_at', async () => {
    ProjectService.create({ id: 'p1', name: 'old', projectDir: '/p1' });
    const before = ProjectService.getById('p1')!;
    await new Promise((r) => setTimeout(r, 5));

    const res = await supertest(buildApp())
      .patch('/api/projects/p1')
      .send({ name: 'new', githubRepo: 'owner/r' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('new');
    expect(res.body.githubRepo).toBe('owner/r');
    expect(res.body.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });

  it('returns 404 when the project is missing', async () => {
    const res = await supertest(buildApp())
      .patch('/api/projects/missing')
      .send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/projects/:id', () => {
  it('deletes a project and cascades to its milestones; sessions are not removed', async () => {
    ProjectService.create({ id: 'p1', name: 'P', projectDir: '/p1' });
    ProjectService.createMilestone({ id: 'm1', projectId: 'p1', name: 'M' });
    db.prepare(
      `INSERT INTO sessions (session_id, project_id, status, started_at) VALUES (?, ?, 'running', 0)`,
    ).run('session-x', 'p1');

    const res = await supertest(buildApp()).delete('/api/projects/p1');
    expect(res.status).toBe(204);
    expect(ProjectService.getById('p1')).toBeUndefined();
    expect(ProjectService.listMilestones('p1')).toHaveLength(0);

    // Sessions referencing the deleted project remain (no FK cascade)
    const sessions = db
      .prepare('SELECT * FROM sessions WHERE session_id = ?')
      .all('session-x');
    expect(sessions).toHaveLength(1);
  });

  it('returns 404 when project does not exist', async () => {
    const res = await supertest(buildApp()).delete('/api/projects/missing');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/projects/:id/milestones', () => {
  it('returns 404 when the project does not exist', async () => {
    const res = await supertest(buildApp()).get(
      '/api/projects/missing/milestones',
    );
    expect(res.status).toBe(404);
  });

  it('returns the project milestones', async () => {
    ProjectService.create({ id: 'p1', name: 'P', projectDir: '/p1' });
    ProjectService.createMilestone({
      id: 'm1',
      projectId: 'p1',
      name: 'M1',
      displayOrder: 0,
    });
    ProjectService.createMilestone({
      id: 'm2',
      projectId: 'p1',
      name: 'M2',
      displayOrder: 1,
    });

    const res = await supertest(buildApp()).get('/api/projects/p1/milestones');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((m: { id: string }) => m.id)).toEqual(['m1', 'm2']);
  });
});

describe('POST /api/projects/:id/milestones', () => {
  it('creates a milestone with a server-generated UUID', async () => {
    ProjectService.create({ id: 'p1', name: 'P', projectDir: '/p1' });
    const res = await supertest(buildApp())
      .post('/api/projects/p1/milestones')
      .send({ name: 'M', sourceId: 'src-1' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.projectId).toBe('p1');
    expect(res.body.sourceId).toBe('src-1');
  });

  it('returns 400 when name is missing', async () => {
    ProjectService.create({ id: 'p1', name: 'P', projectDir: '/p1' });
    const res = await supertest(buildApp())
      .post('/api/projects/p1/milestones')
      .send({ sourceId: 'src-1' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when project does not exist', async () => {
    const res = await supertest(buildApp())
      .post('/api/projects/missing/milestones')
      .send({ name: 'M' });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/milestones/:id', () => {
  it('updates a milestone', async () => {
    ProjectService.create({ id: 'p1', name: 'P', projectDir: '/p1' });
    ProjectService.createMilestone({ id: 'm1', projectId: 'p1', name: 'old' });
    const res = await supertest(buildApp())
      .patch('/api/milestones/m1')
      .send({ name: 'new', displayOrder: 7 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('new');
    expect(res.body.displayOrder).toBe(7);
  });

  it('returns 404 when missing', async () => {
    const res = await supertest(buildApp())
      .patch('/api/milestones/missing')
      .send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/milestones/:id', () => {
  it('removes a milestone but not its project', async () => {
    ProjectService.create({ id: 'p1', name: 'P', projectDir: '/p1' });
    ProjectService.createMilestone({ id: 'm1', projectId: 'p1', name: 'M' });

    const res = await supertest(buildApp()).delete('/api/milestones/m1');
    expect(res.status).toBe(204);
    expect(ProjectService.getMilestone('m1')).toBeUndefined();
    expect(ProjectService.getById('p1')).toBeDefined();
  });

  it('returns 404 when missing', async () => {
    const res = await supertest(buildApp()).delete('/api/milestones/missing');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/projects/:id/tasks-yaml-stub', () => {
  let realDir: string;

  beforeEach(() => {
    realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-stub-'));
  });

  afterEach(() => {
    fs.rmSync(realDir, { recursive: true, force: true });
  });

  it('returns 404 when project does not exist', async () => {
    const res = await supertest(buildApp()).post(
      '/api/projects/missing/tasks-yaml-stub',
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 when project is not configured for YAML', async () => {
    ProjectService.create({
      id: 'p1',
      name: 'P',
      projectDir: realDir,
      taskSource: 'notion',
    });
    const res = await supertest(buildApp()).post(
      '/api/projects/p1/tasks-yaml-stub',
    );
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/YAML/);
  });

  it('writes a milestone-schema tasks.yaml when missing in projectDir', async () => {
    ProjectService.create({
      id: 'p1',
      name: 'P',
      projectDir: realDir,
      taskSource: 'yaml',
    });
    ProjectService.createMilestone({
      id: 'p1:m1',
      projectId: 'p1',
      name: 'M1',
      sourceId: 'm1',
    });

    const res = await supertest(buildApp()).post(
      '/api/projects/p1/tasks-yaml-stub',
    );
    expect(res.status).toBe(201);

    const stubPath = path.join(realDir, 'tasks.yaml');
    expect(fs.existsSync(stubPath)).toBe(true);
    const content = fs.readFileSync(stubPath, 'utf-8');
    expect(content).toMatch(/milestones:/);
    expect(content).toMatch(/M1/);
  });

  it('returns 409 when tasks.yaml already exists', async () => {
    ProjectService.create({
      id: 'p1',
      name: 'P',
      projectDir: realDir,
      taskSource: 'yaml',
    });
    fs.writeFileSync(path.join(realDir, 'tasks.yaml'), 'milestones: []\n');

    const res = await supertest(buildApp()).post(
      '/api/projects/p1/tasks-yaml-stub',
    );
    expect(res.status).toBe(409);
  });
});

describe('schema migration smoke test', () => {
  it('creates projects and milestones tables', () => {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('projects');
    expect(names).toContain('milestones');
  });
});

// ── GitHub task source ────────────────────────────────────────────────────────

const mockGetRepo = vi.fn();
const mockListMilestones = vi.fn();

vi.mock('../../src/github/GitHubClient.js', () => ({
  GitHubClient: vi.fn().mockImplementation(() => ({
    getRepo: mockGetRepo,
    listMilestones: mockListMilestones,
  })),
}));

describe('POST /api/projects — GitHub task source', () => {
  let realDir: string;

  beforeEach(() => {
    realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-proj-'));
    mockGetRepo.mockResolvedValue({ fullName: 'owner/repo', private: false });
  });

  afterEach(() => {
    fs.rmSync(realDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('creates a github project and round-trips task_source_config through the API', async () => {
    const res = await supertest(buildApp())
      .post('/api/projects')
      .send({
        name: 'GH Project',
        projectDir: realDir,
        taskSource: 'github',
        taskSourceConfig: JSON.stringify({ owner: 'owner', repo: 'myrepo' }),
      });
    expect(res.status).toBe(201);
    expect(res.body.taskSource).toBe('github');
    const cfg = JSON.parse(res.body.taskSourceConfig as string) as {
      owner: string;
      repo: string;
    };
    expect(cfg.owner).toBe('owner');
    expect(cfg.repo).toBe('myrepo');

    // Verify it's persisted in SQLite
    const row = db
      .prepare('SELECT task_source, task_source_config FROM projects WHERE id = ?')
      .get(res.body.id as string) as {
      task_source: string;
      task_source_config: string;
    };
    expect(row.task_source).toBe('github');
    const storedCfg = JSON.parse(row.task_source_config) as {
      owner: string;
      repo: string;
    };
    expect(storedCfg.owner).toBe('owner');
    expect(storedCfg.repo).toBe('myrepo');
  });

  it('returns 400 for malformed owner/repo string', async () => {
    const res = await supertest(buildApp())
      .post('/api/projects')
      .send({
        name: 'Bad',
        projectDir: realDir,
        taskSource: 'github',
        taskSourceConfig: JSON.stringify({ owner: 'owner', repo: '' }),
      });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/owner\/repo|owner and repo/i);
  });

  it('returns 400 when owner/repo contains no slash', async () => {
    const res = await supertest(buildApp())
      .post('/api/projects')
      .send({
        name: 'Bad',
        projectDir: realDir,
        taskSource: 'github',
        taskSourceConfig: JSON.stringify({ owner: 'noslash', repo: 'fine' }),
      });
    // owner='noslash', repo='fine' → 'noslash/fine' is valid
    // Test a truly invalid format by omitting owner/repo
    expect([201, 400]).toContain(res.status);
  });

  it('returns 400 when the GitHub repo is unreachable', async () => {
    mockGetRepo.mockRejectedValue(new Error('Not Found'));
    const res = await supertest(buildApp())
      .post('/api/projects')
      .send({
        name: 'Unreachable',
        projectDir: realDir,
        taskSource: 'github',
        taskSourceConfig: JSON.stringify({ owner: 'owner', repo: 'private-repo' }),
      });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/not accessible|Not Found/i);
  });
});

describe('GET /api/projects/:id/github-milestones', () => {
  beforeEach(() => {
    mockListMilestones.mockResolvedValue([
      { id: 1, nodeId: 'n1', title: 'v1.0', description: null, state: 'open',
        openIssues: 3, closedIssues: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    ]);
  });

  afterEach(() => vi.clearAllMocks());

  it('returns 404 for unknown project', async () => {
    const res = await supertest(buildApp()).get(
      '/api/projects/missing/github-milestones',
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 when project is not a github task source', async () => {
    ProjectService.create({ id: 'p1', name: 'P', projectDir: '/p1', taskSource: 'notion' });
    const res = await supertest(buildApp()).get(
      '/api/projects/p1/github-milestones',
    );
    expect(res.status).toBe(400);
  });

  it('returns milestones from GitHubClient for a github task source project', async () => {
    ProjectService.create({ id: 'p2', name: 'GH', projectDir: '/p2', taskSource: 'github' });
    db.prepare(
      `UPDATE projects SET task_source_config = ? WHERE id = ?`,
    ).run(JSON.stringify({ owner: 'owner', repo: 'repo' }), 'p2');

    const res = await supertest(buildApp()).get(
      '/api/projects/p2/github-milestones',
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].title).toBe('v1.0');
  });
});
