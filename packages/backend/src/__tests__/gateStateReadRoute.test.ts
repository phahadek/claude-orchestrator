import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import { insertItem } from '../gate/gateStore.js';
import { appendGateItemEvent } from '../gate/gateService.js';
import { createGateStateRouter } from '../routes/gateState.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createGateStateRouter());
  return app;
}

function makeItem(overrides: Partial<Parameters<typeof insertItem>[0]> = {}) {
  return insertItem({
    project: 'polimarket-analyser',
    milestone: 'M12',
    text: 'Verify the deploy script writes the new env var',
    classification: 'Read-Only',
    sources: [{ sourceTaskId: 'notion:abc', sourceTaskTitle: 'Add env var' }],
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  });
}

beforeEach(() => {
  db.prepare('DELETE FROM gate_item_event').run();
  db.prepare('DELETE FROM gate_item_source').run();
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('GET /api/gate/items', () => {
  it('is a thin wrapper over listGateItems: paginates and filters', async () => {
    const a = makeItem({ classification: 'Read-Only' });
    makeItem({ project: 'other-project', classification: 'Prod-Mutating' });

    const res = await request(makeApp()).get(
      '/api/gate/items?project=polimarket-analyser&limit=1&page=1',
    );

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.page).toBe(1);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(a.id);
  });

  it('never returns an unbounded load when no limit is given', async () => {
    for (let i = 0; i < 3; i++) {
      makeItem({ text: `item ${i}` });
    }
    const res = await request(makeApp()).get('/api/gate/items');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.total).toBe(3);
  });
});

describe('GET /api/gate/items/:id/detail', () => {
  it('returns the item plus its sources and event history, by value', async () => {
    const item = makeItem();
    appendGateItemEvent(item.id, { disposition: 'fail' });

    const res = await request(makeApp()).get(`/api/gate/items/${item.id}/detail`);

    expect(res.status).toBe(200);
    expect(res.body.item.id).toBe(item.id);
    expect(res.body.sources).toHaveLength(1);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].disposition).toBe('fail');
  });

  it('returns 404 for an unknown item', async () => {
    const res = await request(makeApp()).get('/api/gate/items/unknown/detail');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/gate/milestones/readiness', () => {
  it('rolls up per-milestone readiness, optionally scoped to a project', async () => {
    const item = makeItem({ milestone: 'M12' });
    appendGateItemEvent(item.id, { disposition: 'pass' });
    makeItem({ milestone: 'M13' });
    makeItem({ project: 'other-project', milestone: 'M20' });

    const scoped = await request(makeApp()).get(
      '/api/gate/milestones/readiness?project=polimarket-analyser',
    );
    expect(scoped.status).toBe(200);
    expect(scoped.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ milestone: 'M12', status: 'green' }),
        expect.objectContaining({ milestone: 'M13', status: 'blocked' }),
      ]),
    );
    expect(
      scoped.body.every((r: { project: string }) => r.project === 'polimarket-analyser'),
    ).toBe(true);

    const all = await request(makeApp()).get('/api/gate/milestones/readiness');
    expect(all.status).toBe(200);
    expect(all.body.length).toBeGreaterThanOrEqual(3);
  });
});
