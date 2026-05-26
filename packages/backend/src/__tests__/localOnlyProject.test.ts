/**
 * Tests for local-only project mode (gitMode: 'local-only' | 'github').
 *
 * AC coverage:
 * - Project config schema accepts gitMode: local-only | github (default github); invalid values rejected.
 * - gitMode and taskSource are independent; all four valid combinations parse and validate.
 * - Coding session lifecycle: local-only projects skip git fetch origin dev.
 * - Review session lifecycle: review verdict → mark-merged → Notion task Done.
 * - Settings → Projects UI shows gitMode field (frontend test is in Settings/__tests__).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import fs from 'fs';
import path from 'path';

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockProject = {
  id: 'proj-local',
  name: 'Local Proj',
  projectDir: '/repos/local-proj',
  contextUrl: 'https://notion.so/ctx',
  boardId: 'board-1',
  taskSource: 'notion' as const,
  gitMode: 'local-only' as const,
  autoLaunchEnabled: false,
  autoLaunchMilestoneId: null,
  autoMergeEnabled: false,
};

vi.mock('../db/queries.js', () => ({
  getSession: vi.fn(),
  getActiveSessions: vi.fn().mockReturnValue([]),
  getArchivedSessions: vi.fn().mockReturnValue([]),
  getSessionsByStatus: vi.fn().mockReturnValue([]),
  getSessionsByProject: vi.fn().mockReturnValue([]),
  deleteSession: vi.fn(),
  archiveSession: vi.fn(),
  unarchiveSession: vi.fn(),
  archiveFinishedSessions: vi.fn().mockReturnValue(0),
  setSessionNote: vi.fn(),
  setSessionTags: vi.fn(),
  favoriteSession: vi.fn(),
  unfavoriteSession: vi.fn(),
  deleteDenialsBySession: vi.fn(),
  getEventsBySession: vi.fn().mockReturnValue([]),
  insertProject: vi.fn((p: Record<string, unknown>) => ({
    ...p,
    created_at: 1000,
    updated_at: 1000,
    git_mode: p.git_mode ?? 'github',
  })),
  getProjectRowById: vi.fn(),
  listProjectRows: vi.fn().mockReturnValue([]),
  updateProject: vi.fn(),
  deleteProject: vi.fn().mockReturnValue(true),
  countProjects: vi.fn().mockReturnValue(0),
  insertMilestone: vi.fn(),
  getMilestoneById: vi.fn(),
  listMilestonesByProject: vi.fn().mockReturnValue([]),
  updateMilestone: vi.fn(),
  deleteMilestone: vi.fn(),
  getMergeReadyPRs: vi.fn().mockReturnValue([]),
}));

vi.mock('../config.js', () => ({
  getProjectById: vi.fn((id: string) =>
    id === 'proj-local' ? mockProject : undefined,
  ),
  normalizePath: (p: string) => p,
  runtimeSettings: {},
}));

vi.mock('../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi.fn(() => ({
    updateStatus: vi.fn().mockResolvedValue(undefined),
    type: 'notion',
  })),
}));

vi.mock('../projects/ProjectService.js', () => ({
  ProjectService: {
    list: vi.fn().mockReturnValue([]),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn().mockReturnValue(true),
    listMilestones: vi.fn().mockReturnValue([]),
    getMilestone: vi.fn(),
    createMilestone: vi.fn(),
    updateMilestone: vi.fn(),
    deleteMilestone: vi.fn(),
    count: vi.fn().mockReturnValue(0),
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof fs>('fs');
  return {
    ...actual,
    statSync: vi.fn().mockReturnValue({ isDirectory: () => true }),
    existsSync: vi.fn().mockReturnValue(true),
  };
});

// ── Imports after mocks ───────────────────────────────────────────────────────

import { projectsRouter } from '../routes/projects.js';
import { sessionsRouter, setBroadcast } from '../routes/sessions.js';
import * as queries from '../db/queries.js';
import * as TaskBackend from '../tasks/TaskBackend.js';
import { ProjectService } from '../projects/ProjectService.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildProjectApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', projectsRouter);
  return app;
}

function buildSessionApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  setBroadcast(() => {});
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  setBroadcast(() => {});
});

// ── Schema validation tests ───────────────────────────────────────────────────

describe('Project config schema — gitMode field', () => {
  it('accepts gitMode: github', async () => {
    vi.mocked(ProjectService.getById).mockReturnValue(undefined);
    vi.mocked(ProjectService.create).mockReturnValue({
      id: 'new-proj',
      name: 'Test',
      projectDir: '/tmp/test',
      contextUrl: null,
      githubRepo: null,
      taskSource: 'notion',
      gitMode: 'github',
      autoLaunchEnabled: false,
      autoLaunchMilestoneId: null,
      autoMergeEnabled: false,
      createdAt: 1000,
      updatedAt: 1000,
      milestones: [],
    });
    const res = await supertest(buildProjectApp())
      .post('/api/projects')
      .send({ name: 'Test', projectDir: '/tmp/test', gitMode: 'github' });
    expect(res.status).toBe(201);
    expect(res.body.gitMode).toBe('github');
  });

  it('accepts gitMode: local-only', async () => {
    vi.mocked(ProjectService.getById).mockReturnValue(undefined);
    vi.mocked(ProjectService.create).mockReturnValue({
      id: 'new-proj',
      name: 'Test',
      projectDir: '/tmp/test',
      contextUrl: null,
      githubRepo: null,
      taskSource: 'notion',
      gitMode: 'local-only',
      autoLaunchEnabled: false,
      autoLaunchMilestoneId: null,
      autoMergeEnabled: false,
      createdAt: 1000,
      updatedAt: 1000,
      milestones: [],
    });
    const res = await supertest(buildProjectApp())
      .post('/api/projects')
      .send({ name: 'Test', projectDir: '/tmp/test', gitMode: 'local-only' });
    expect(res.status).toBe(201);
    expect(res.body.gitMode).toBe('local-only');
  });

  it('rejects invalid gitMode value', async () => {
    const res = await supertest(buildProjectApp())
      .post('/api/projects')
      .send({ name: 'Test', projectDir: '/tmp/test', gitMode: 'remote-only' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/gitMode/);
  });

  it('defaults gitMode to github when omitted', async () => {
    vi.mocked(ProjectService.getById).mockReturnValue(undefined);
    vi.mocked(ProjectService.create).mockReturnValue({
      id: 'new-proj',
      name: 'Test',
      projectDir: '/tmp/test',
      contextUrl: null,
      githubRepo: null,
      taskSource: 'notion',
      gitMode: 'github',
      autoLaunchEnabled: false,
      autoLaunchMilestoneId: null,
      autoMergeEnabled: false,
      createdAt: 1000,
      updatedAt: 1000,
      milestones: [],
    });
    const res = await supertest(buildProjectApp())
      .post('/api/projects')
      .send({ name: 'Test', projectDir: '/tmp/test' });
    expect(res.status).toBe(201);
    expect(ProjectService.create).toHaveBeenCalledWith(
      expect.objectContaining({ gitMode: 'github' }),
    );
  });
});

// ── gitMode + taskSource independence tests ───────────────────────────────────

describe('gitMode and taskSource independence', () => {
  const combos: Array<{ gitMode: string; taskSource: string }> = [
    { gitMode: 'github', taskSource: 'notion' },
    { gitMode: 'github', taskSource: 'yaml' },
    { gitMode: 'local-only', taskSource: 'notion' },
    { gitMode: 'local-only', taskSource: 'yaml' },
  ];

  for (const { gitMode, taskSource } of combos) {
    it(`accepts gitMode=${gitMode} + taskSource=${taskSource}`, async () => {
      vi.mocked(ProjectService.getById).mockReturnValue(undefined);
      vi.mocked(ProjectService.create).mockReturnValue({
        id: 'new-proj',
        name: 'Test',
        projectDir: '/tmp/test',
        contextUrl: null,
        githubRepo: null,
        taskSource: taskSource as 'notion' | 'yaml',
        gitMode: gitMode as 'github' | 'local-only',
        autoLaunchEnabled: false,
        autoLaunchMilestoneId: null,
        autoMergeEnabled: false,
        createdAt: 1000,
        updatedAt: 1000,
        milestones: [],
      });
      const res = await supertest(buildProjectApp())
        .post('/api/projects')
        .send({ name: 'Test', projectDir: '/tmp/test', gitMode, taskSource });
      expect(res.status).toBe(201);
      expect(res.body.gitMode).toBe(gitMode);
      expect(res.body.taskSource).toBe(taskSource);
    });
  }
});

// ── PATCH /api/projects/:id gitMode update ────────────────────────────────────

describe('PATCH /api/projects/:id — gitMode', () => {
  it('updates gitMode to local-only', async () => {
    vi.mocked(ProjectService.update).mockReturnValue({
      id: 'proj-1',
      name: 'Test',
      projectDir: '/tmp/test',
      contextUrl: null,
      githubRepo: null,
      taskSource: 'notion',
      gitMode: 'local-only',
      autoLaunchEnabled: false,
      autoLaunchMilestoneId: null,
      autoMergeEnabled: false,
      createdAt: 1000,
      updatedAt: 2000,
      milestones: [],
    });
    const res = await supertest(buildProjectApp())
      .patch('/api/projects/proj-1')
      .send({ gitMode: 'local-only' });
    expect(res.status).toBe(200);
    expect(res.body.gitMode).toBe('local-only');
  });

  it('rejects invalid gitMode on PATCH', async () => {
    const res = await supertest(buildProjectApp())
      .patch('/api/projects/proj-1')
      .send({ gitMode: 'cloud-only' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/gitMode/);
  });
});

// ── Mark-merged endpoint ──────────────────────────────────────────────────────

describe('POST /api/sessions/:id/mark-merged', () => {
  it('marks a local-only task as Done', async () => {
    const mockUpdateStatus = vi.fn().mockResolvedValue(undefined);
    vi.mocked(TaskBackend.getTaskBackend).mockReturnValue({
      updateStatus: mockUpdateStatus,
      type: 'notion',
    } as ReturnType<typeof TaskBackend.getTaskBackend>);
    vi.mocked(queries.getSession).mockReturnValue({
      session_id: 'sess-1',
      task_id: 'task-abc',
      task_url: 'https://notion.so/task-abc',
      project_context_url: null,
      project_id: 'proj-local',
      status: 'done',
      started_at: 1000,
      ended_at: 2000,
      pr_url: null,
      worktree_path: null,
      archived: 0,
      favorited: 0,
      session_type: 'standard',
      note: null,
      tags: null,
      total_input_tokens: 0,
      total_output_tokens: 0,
      model: null,
      task_name: 'Test task',
      review_result: null,
    });
    const res = await supertest(buildSessionApp()).post(
      '/api/sessions/sess-1/mark-merged',
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockUpdateStatus).toHaveBeenCalledWith('task-abc', '✅ Done');
  });

  it('rejects mark-merged for github project', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      session_id: 'sess-2',
      task_id: 'task-xyz',
      task_url: 'https://notion.so/task-xyz',
      project_context_url: null,
      project_id: 'proj-github',
      status: 'done',
      started_at: 1000,
      ended_at: 2000,
      pr_url: null,
      worktree_path: null,
      archived: 0,
      favorited: 0,
      session_type: 'standard',
      note: null,
      tags: null,
      total_input_tokens: 0,
      total_output_tokens: 0,
      model: null,
      task_name: 'Test',
      review_result: null,
    });
    const { getProjectById } = await import('../config.js');
    vi.mocked(getProjectById).mockReturnValueOnce({
      id: 'proj-github',
      name: 'GitHub Proj',
      projectDir: '/repos/github',
      contextUrl: '',
      boardId: 'board-1',
      taskSource: 'notion',
      gitMode: 'github',
      autoLaunchEnabled: false,
      autoLaunchMilestoneId: null,
      autoMergeEnabled: false,
    });
    const res = await supertest(buildSessionApp()).post(
      '/api/sessions/sess-2/mark-merged',
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/local-only/);
  });

  it('returns 404 for unknown session', async () => {
    vi.mocked(queries.getSession).mockReturnValue(undefined);
    const res = await supertest(buildSessionApp()).post(
      '/api/sessions/unknown/mark-merged',
    );
    expect(res.status).toBe(404);
  });
});

// ── SessionManager git isolation tests ───────────────────────────────────────

describe('SessionManager source — local-only skips git fetch', () => {
  it('uses local dev branch for local-only worktree creation', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );
    // Must check gitMode and branch on it
    expect(source).toContain('isLocalOnly');
    expect(source).toContain("gitMode === 'local-only'");
    // Must use local dev branch when local-only (isLocalOnly causes worktreeBase = startingPoint, not origin/dev)
    expect(source).toContain('isLocalOnly || startingPoint !== ');
    // Must skip fetch for local-only
    expect(source).toContain('if (!isLocalOnly)');
  });
});

// ── orchestrator-claudemd.ts source tests ────────────────────────────────────

describe('orchestrator-claudemd source — gitMode param', () => {
  it('accepts gitMode param in OrchestratorClaudeMdParams', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'orchestrator-claudemd.ts'),
      'utf-8',
    );
    expect(source).toContain("gitMode?: 'github' | 'local-only'");
    expect(source).toContain("gitMode === 'local-only'");
    expect(source).toContain('No GitHub PR is required');
  });
});

// ── DB schema migration tests ─────────────────────────────────────────────────

describe('schema.ts migrations', () => {
  it('adds git_mode column to projects table', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'schema.ts'),
      'utf-8',
    );
    expect(source).toContain("git_mode TEXT NOT NULL DEFAULT 'github'");
  });

  it('adds review_result column to sessions table', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'schema.ts'),
      'utf-8',
    );
    expect(source).toContain(
      'ALTER TABLE sessions ADD COLUMN review_result TEXT',
    );
  });
});

// ── db/types.ts GitMode type tests ───────────────────────────────────────────

describe('db/types.ts GitMode type', () => {
  it('exports GitMode union type', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'types.ts'),
      'utf-8',
    );
    expect(source).toContain("export type GitMode = 'github' | 'local-only'");
  });

  it('ProjectRow includes git_mode field', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'types.ts'),
      'utf-8',
    );
    expect(source).toContain('git_mode: GitMode');
  });
});
