import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

// Mock db/queries before importing the router
vi.mock('../db/queries', () => ({
  getAllRules: vi.fn(),
  getRuleById: vi.fn(),
  insertRuleReturning: vi.fn(),
  updateRule: vi.fn(),
  deleteRule: vi.fn(),
}));

import { rulesRouter } from '../routes/rules';
import * as queries from '../db/queries';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/rules', rulesRouter);
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

describe('GET /api/rules', () => {
  it('returns all rules from SQLite as a JSON array', async () => {
    vi.mocked(queries.getAllRules).mockReturnValue([mockRule] as never);
    const res = await supertest(buildApp()).get('/api/rules');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([mockRule]);
  });

  it('returns an empty array when there are no rules', async () => {
    vi.mocked(queries.getAllRules).mockReturnValue([] as never);
    const res = await supertest(buildApp()).get('/api/rules');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('POST /api/rules', () => {
  it('inserts a new rule and returns the created row', async () => {
    vi.mocked(queries.insertRuleReturning).mockReturnValue(mockRule as never);
    const res = await supertest(buildApp())
      .post('/api/rules')
      .send({ pattern: 'Bash *rm*', match_type: 'glob', decision: 'deny', label: 'Block rm' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(mockRule);
    expect(queries.insertRuleReturning).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: 'Bash *rm*', match_type: 'glob', decision: 'deny' }),
    );
  });

  it('returns 400 when pattern is missing', async () => {
    const res = await supertest(buildApp())
      .post('/api/rules')
      .send({ match_type: 'glob', decision: 'deny' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when match_type is invalid', async () => {
    const res = await supertest(buildApp())
      .post('/api/rules')
      .send({ pattern: 'x', match_type: 'invalid', decision: 'deny' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when decision is invalid', async () => {
    const res = await supertest(buildApp())
      .post('/api/rules')
      .send({ pattern: 'x', match_type: 'glob', decision: 'escalate' });
    expect(res.status).toBe(400);
  });

  it('sets order_index server-side — client-supplied order_index is ignored', async () => {
    vi.mocked(queries.insertRuleReturning).mockReturnValue(mockRule as never);
    await supertest(buildApp())
      .post('/api/rules')
      .send({ pattern: 'Bash *rm*', match_type: 'glob', decision: 'deny', order_index: 999 });
    // insertRuleReturning must be called without order_index so the server sets it
    expect(queries.insertRuleReturning).toHaveBeenCalledWith(
      expect.not.objectContaining({ order_index: expect.anything() }),
    );
  });
});

describe('PUT /api/rules/:id', () => {
  it('updates the specified rule and returns the updated row', async () => {
    const updated = { ...mockRule, enabled: 0 };
    vi.mocked(queries.getRuleById)
      .mockReturnValueOnce(mockRule as never)  // existence check
      .mockReturnValueOnce(updated as never);  // fetch after update
    const res = await supertest(buildApp())
      .put('/api/rules/1')
      .send({ enabled: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(updated);
    expect(queries.updateRule).toHaveBeenCalledWith(1, expect.objectContaining({ enabled: 0 }));
  });

  it('merges partial body with existing record so all SQL named parameters are present', async () => {
    const updated = { ...mockRule, enabled: 0 };
    vi.mocked(queries.getRuleById)
      .mockReturnValueOnce(mockRule as never)
      .mockReturnValueOnce(updated as never);
    await supertest(buildApp()).put('/api/rules/1').send({ enabled: 0 });
    expect(queries.updateRule).toHaveBeenCalledWith(1, {
      order_index: mockRule.order_index,
      pattern:     mockRule.pattern,
      match_type:  mockRule.match_type,
      decision:    mockRule.decision,
      label:       mockRule.label,
      enabled:     0,
    });
  });

  it('returns 404 when rule does not exist', async () => {
    vi.mocked(queries.getRuleById).mockReturnValue(undefined as never);
    const res = await supertest(buildApp()).put('/api/rules/999').send({ enabled: 0 });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/rules/:id', () => {
  it('removes the rule and returns 204', async () => {
    vi.mocked(queries.getRuleById).mockReturnValue(mockRule as never);
    const res = await supertest(buildApp()).delete('/api/rules/1');
    expect(res.status).toBe(204);
    expect(queries.deleteRule).toHaveBeenCalledWith(1);
  });

  it('returns 404 when rule does not exist', async () => {
    vi.mocked(queries.getRuleById).mockReturnValue(undefined as never);
    const res = await supertest(buildApp()).delete('/api/rules/999');
    expect(res.status).toBe(404);
  });
});

describe('hard-coded deny/allow lists are not in SQLite', () => {
  it('getAllRules returns only user-defined pattern rules — no hard-coded entries', async () => {
    // Hard-coded rules live in PermissionEngine constants, not in the permission_rules table.
    // The REST API only exposes what's in SQLite, so hard-coded entries can never appear here.
    vi.mocked(queries.getAllRules).mockReturnValue([mockRule] as never);
    const res = await supertest(buildApp()).get('/api/rules');
    // The response contains exactly what getAllRules returns — no implicit extra rows
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toEqual(mockRule);
  });
});
