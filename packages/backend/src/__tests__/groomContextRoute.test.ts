import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockLoadGroomContext, mockGetProjectRowById } = vi.hoisted(() => ({
  mockLoadGroomContext: vi.fn(),
  mockGetProjectRowById: vi.fn(),
}));

vi.mock('../groom/groomLoad.js', () => ({
  loadGroomContext: mockLoadGroomContext,
}));

vi.mock('../db/queries.js', () => ({
  getProjectRowById: mockGetProjectRowById,
}));

import { createGroomContextRouter } from '../routes/groomContext.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createGroomContextRouter());
  return app;
}

beforeEach(() => {
  mockLoadGroomContext.mockReset();
  mockGetProjectRowById.mockReset();
});

describe('GET /api/groom-context', () => {
  it('returns 400 when milestone is missing', async () => {
    const res = await request(makeApp()).get('/api/groom-context');
    expect(res.status).toBe(400);
  });

  it('returns the full GroomLoadResult bundle for a milestone', async () => {
    mockLoadGroomContext.mockResolvedValue({
      contextPages: [{ id: 'ctx-1', title: 'Context', markdown: 'body' }],
      board: [],
      neighbourBoards: [],
      targetTasks: [],
      codeWorklist: new Map([['backend', ['a.ts', 'b.ts']]]),
      gitFreshness: {},
      dependencyCandidates: [],
    });

    const res = await request(makeApp()).get(
      '/api/groom-context?milestone=M12',
    );

    expect(res.status).toBe(200);
    expect(mockLoadGroomContext).toHaveBeenCalledWith('M12', undefined);
    expect(res.body.contextPages).toHaveLength(1);
    expect(res.body.codeWorklist).toEqual({ backend: ['a.ts', 'b.ts'] });
  });

  it('resolves repoRoot from the project row when project is given', async () => {
    mockGetProjectRowById.mockReturnValue({ project_dir: '/repo/root' });
    mockLoadGroomContext.mockResolvedValue({
      contextPages: [],
      board: [],
      neighbourBoards: [],
      targetTasks: [],
      codeWorklist: new Map(),
      gitFreshness: {},
      dependencyCandidates: [],
    });

    const res = await request(makeApp()).get(
      '/api/groom-context?milestone=M12&project=p1',
    );

    expect(res.status).toBe(200);
    expect(mockGetProjectRowById).toHaveBeenCalledWith('p1');
    expect(mockLoadGroomContext).toHaveBeenCalledWith('M12', {
      repoRoot: '/repo/root',
    });
  });

  it('returns 404 when the project is unknown', async () => {
    mockGetProjectRowById.mockReturnValue(undefined);
    const res = await request(makeApp()).get(
      '/api/groom-context?milestone=M12&project=missing',
    );
    expect(res.status).toBe(404);
  });

  it('returns 500 when the loader throws', async () => {
    mockLoadGroomContext.mockRejectedValue(new Error('boom'));
    const res = await request(makeApp()).get(
      '/api/groom-context?milestone=M12',
    );
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('boom');
  });
});
