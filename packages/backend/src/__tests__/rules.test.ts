import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

vi.mock('../db/queries', () => ({
  getRecentPermissionEvents: vi.fn(() => []),
  clearPermissionEvents: vi.fn(),
  getRecentPermissionDenials: vi.fn(() => []),
  clearPermissionDenials: vi.fn(),
  getAllRules: vi.fn(),
}));

import { permissionRulesRouter } from '../routes/rules';
import * as queries from '../db/queries';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/permission-rules', permissionRulesRouter);
  return app;
}

const mockRule = {
  id: 1,
  order_index: 1,
  pattern: 'Bash *rm*',
  match_type: 'glob',
  decision: 'deny',
  label: 'Block rm',
  enabled: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/permission-rules', () => {
  it('returns all rules from SQLite as a JSON array', async () => {
    vi.mocked(queries.getAllRules).mockReturnValue([mockRule] as never);
    const res = await supertest(buildApp()).get('/api/permission-rules');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([mockRule]);
  });

  it('returns an empty array when there are no rules', async () => {
    vi.mocked(queries.getAllRules).mockReturnValue([] as never);
    const res = await supertest(buildApp()).get('/api/permission-rules');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('hard-coded deny/allow lists are not in SQLite', () => {
  it('getAllRules returns only user-defined pattern rules — no hard-coded entries', async () => {
    // Hard-coded rules live in PermissionEngine constants, not in the permission_rules table.
    // The REST API only exposes what's in SQLite, so hard-coded entries can never appear here.
    vi.mocked(queries.getAllRules).mockReturnValue([mockRule] as never);
    const res = await supertest(buildApp()).get('/api/permission-rules');
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toEqual(mockRule);
  });
});
