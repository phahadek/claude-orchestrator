import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

vi.mock('../db/queries', () => ({
  getRecentPermissionDenials: vi.fn(),
  clearPermissionDenials: vi.fn(),
}));

import { permissionDenialsRouter } from '../routes/rules';
import * as queries from '../db/queries';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/permission-denials', permissionDenialsRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/permission-denials', () => {
  it('returns recent denials as a JSON array', async () => {
    const mockRows = [
      {
        id: 1,
        session_id: 's1',
        tool_name: 'Bash',
        tool_use_id: 'tu1',
        tool_input: '{}',
        timestamp: 1000,
      },
    ];
    vi.mocked(queries.getRecentPermissionDenials).mockReturnValue(
      mockRows as never,
    );
    const res = await supertest(buildApp()).get('/api/permission-denials');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockRows);
  });
});

describe('DELETE /api/permission-denials', () => {
  it('calls clearPermissionDenials and returns { cleared: true }', async () => {
    const res = await supertest(buildApp()).delete('/api/permission-denials');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cleared: true });
    expect(queries.clearPermissionDenials).toHaveBeenCalledOnce();
  });
});
