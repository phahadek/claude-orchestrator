import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

vi.mock('../projects/ProjectService.js', () => ({
  ProjectService: {
    getById: vi.fn((id: string) => {
      if (id === 'proj-1')
        return { id: 'proj-1', name: 'Test', autoMergeEnabled: false };
      return undefined;
    }),
    list: vi.fn(() => []),
    listMilestones: vi.fn(() => []),
  },
}));

vi.mock('../db/queries.js', () => ({
  getMergeReadyPRs: vi.fn(),
}));

import { projectsRouter, setAutoMerger } from '../routes/projects.js';
import * as queries from '../db/queries.js';
import type { AutoMerger } from '../github/AutoMerger.js';
import type { PullRequestRow } from '../db/types.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', projectsRouter);
  return app;
}

describe('POST /projects/:projectId/milestones/:milestoneId/merge-ready', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAutoMerger(null as unknown as AutoMerger);
  });

  it('returns 404 for unknown project', async () => {
    vi.mocked(queries.getMergeReadyPRs).mockReturnValue([]);
    const res = await supertest(makeApp()).post(
      '/api/projects/no-such-project/milestones/ms-1/merge-ready',
    );
    expect(res.status).toBe(404);
  });

  it('calls AutoMerger.attempt for each eligible PR and returns attempted list', async () => {
    const mockAttempt = vi.fn();
    setAutoMerger({ attempt: mockAttempt } as unknown as AutoMerger);
    vi.mocked(queries.getMergeReadyPRs).mockReturnValue([
      { pr_number: 10, repo: 'owner/repo' } as PullRequestRow,
      { pr_number: 11, repo: 'owner/repo' } as PullRequestRow,
    ]);

    const res = await supertest(makeApp()).post(
      '/api/projects/proj-1/milestones/ms-1/merge-ready',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ attempted: [10, 11] });
    expect(mockAttempt).toHaveBeenCalledTimes(2);
    expect(mockAttempt).toHaveBeenCalledWith(10, 'owner/repo', {
      bypassToggle: true,
    });
    expect(mockAttempt).toHaveBeenCalledWith(11, 'owner/repo', {
      bypassToggle: true,
    });
  });

  it('works regardless of autoMergeEnabled (independent of toggle)', async () => {
    const mockAttempt = vi.fn();
    setAutoMerger({ attempt: mockAttempt } as unknown as AutoMerger);
    vi.mocked(queries.getMergeReadyPRs).mockReturnValue([
      { pr_number: 42, repo: 'owner/repo' } as PullRequestRow,
    ]);

    const res = await supertest(makeApp()).post(
      '/api/projects/proj-1/milestones/ms-1/merge-ready',
    );

    expect(res.status).toBe(200);
    expect(mockAttempt).toHaveBeenCalledWith(42, 'owner/repo', {
      bypassToggle: true,
    });
  });

  it('passes bypassToggle=true to AutoMerger.attempt when autoMergeEnabled=false', async () => {
    const mockAttempt = vi.fn();
    setAutoMerger({ attempt: mockAttempt } as unknown as AutoMerger);
    vi.mocked(queries.getMergeReadyPRs).mockReturnValue([
      { pr_number: 55, repo: 'owner/repo' } as PullRequestRow,
    ]);

    const res = await supertest(makeApp()).post(
      '/api/projects/proj-1/milestones/ms-1/merge-ready',
    );

    expect(res.status).toBe(200);
    expect(mockAttempt).toHaveBeenCalledWith(55, 'owner/repo', {
      bypassToggle: true,
    });
  });

  it('returns empty attempted list when no eligible PRs', async () => {
    vi.mocked(queries.getMergeReadyPRs).mockReturnValue([]);

    const res = await supertest(makeApp()).post(
      '/api/projects/proj-1/milestones/ms-1/merge-ready',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ attempted: [] });
  });
});
