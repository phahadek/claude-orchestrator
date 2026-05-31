import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockUpdate, mockGetById, mockSetDataResidency } = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  mockGetById: vi.fn(),
  mockSetDataResidency: vi.fn(),
}));

vi.mock('../projects/ProjectService.js', () => ({
  ProjectService: {
    getById: mockGetById,
    update: mockUpdate,
    setDataResidencyConfirmed: mockSetDataResidency,
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
import type { ProjectPatch } from '../db/queries.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', projectsRouter);
  return app;
}

function makeProject(extra = {}) {
  return {
    id: 'p1',
    name: 'Test',
    projectDir: '/test',
    taskSource: 'notion',
    gitMode: 'github',
    autoLaunchEnabled: false,
    autoLaunchMilestoneId: null,
    autoMergeEnabled: false,
    milestoneBranching: null,
    nonMilestoneSourceConfig: null,
    taskSourceConfig: null,
    dataResidencyConfirmed: false,
    milestones: [],
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('PATCH /api/projects/:id — nonMilestoneSourceConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockReturnValue(makeProject());
    mockUpdate.mockImplementation((_id: string, patch: ProjectPatch) =>
      makeProject({
        nonMilestoneSourceConfig: patch.non_milestone_source_config
          ? (JSON.parse(patch.non_milestone_source_config) as unknown)
          : null,
      }),
    );
  });

  it('accepts a valid config object and stores it as JSON', async () => {
    const res = await supertest(buildApp())
      .patch('/api/projects/p1')
      .send({ nonMilestoneSourceConfig: { notionDatabaseId: 'db-123' } });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        non_milestone_source_config: '{"notionDatabaseId":"db-123"}',
      }),
    );
  });

  it('accepts a valid JSON string', async () => {
    const res = await supertest(buildApp())
      .patch('/api/projects/p1')
      .send({ nonMilestoneSourceConfig: '{"milestoneId":"backlog"}' });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ non_milestone_source_config: '{"milestoneId":"backlog"}' }),
    );
  });

  it('accepts null and clears the config', async () => {
    const res = await supertest(buildApp())
      .patch('/api/projects/p1')
      .send({ nonMilestoneSourceConfig: null });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ non_milestone_source_config: null }),
    );
  });

  it('accepts an empty object {} as a valid config', async () => {
    const res = await supertest(buildApp())
      .patch('/api/projects/p1')
      .send({ nonMilestoneSourceConfig: {} });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ non_milestone_source_config: '{}' }),
    );
  });

  it('rejects malformed JSON string with 400', async () => {
    const res = await supertest(buildApp())
      .patch('/api/projects/p1')
      .send({ nonMilestoneSourceConfig: '{not-json}' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('JSON') });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects a JSON array string with 400', async () => {
    const res = await supertest(buildApp())
      .patch('/api/projects/p1')
      .send({ nonMilestoneSourceConfig: '[1,2]' });
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects wrong shape (notionDatabaseId is a number) as object with 400', async () => {
    const res = await supertest(buildApp())
      .patch('/api/projects/p1')
      .send({ nonMilestoneSourceConfig: { notionDatabaseId: 42 } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('shape') });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects wrong shape (milestoneId is boolean) as JSON string with 400', async () => {
    const res = await supertest(buildApp())
      .patch('/api/projects/p1')
      .send({ nonMilestoneSourceConfig: '{"milestoneId":true}' });
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('does not touch non_milestone_source_config when field absent from body', async () => {
    const res = await supertest(buildApp())
      .patch('/api/projects/p1')
      .send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    const patch = mockUpdate.mock.calls[0][1] as Record<string, unknown>;
    expect('non_milestone_source_config' in patch).toBe(false);
  });

  it('returns 404 when project not found', async () => {
    mockGetById.mockReturnValue(undefined);
    mockUpdate.mockReturnValue(undefined);
    const res = await supertest(buildApp())
      .patch('/api/projects/missing')
      .send({ nonMilestoneSourceConfig: null });
    expect(res.status).toBe(404);
  });
});
