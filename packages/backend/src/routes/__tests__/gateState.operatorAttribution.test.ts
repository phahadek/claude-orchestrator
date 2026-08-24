/**
 * Tests for operator attribution across the five gate-disposition routes
 * (packages/backend/src/routes/gateState.ts): events, approve, reject,
 * reopen, classification.
 *
 * AC: with no body operator, a device-authed request attributes the
 * disposition to the authenticated device's name, and a session-route-
 * credential-authed request attributes it to a session-derived label
 * (`session:<id>`); an explicit body operator always wins over either
 * identity. Approving a Prod-Mutating item without a body operator, from
 * either auth path, reaches state 'pass' with a non-null operator and an
 * audit_log row no longer attributed to (actor_type: system, actor_id: null).
 */

import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { createGateStateRouter } from '../gateState.js';
import { insertItem } from '../../gate/gateStore.js';
import { appendGateItemEvent } from '../../gate/gateService.js';
import type { DeviceRow } from '../../db/types.js';

beforeEach(() => {
  db.prepare('DELETE FROM gate_item_event').run();
  db.prepare('DELETE FROM gate_item_source').run();
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM audit_log').run();
});

const testDevice: DeviceRow = {
  id: 'device-1',
  name: 'pedros-macbook',
  user_agent: null,
  last_ip: null,
  last_seen: null,
  enrolled_at: 0,
  token: 'test-token',
  revoked: 0,
};

function deviceAuth(device: DeviceRow) {
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { device: DeviceRow }).device = device;
    next();
  };
}

function sessionAuth(sessionId: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { routeSession: { sessionId: string } }).routeSession = {
      sessionId,
    };
    next();
  };
}

function makeApp(authMiddleware: express.RequestHandler) {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use('/api', createGateStateRouter());
  return app;
}

function makeItem(overrides: Partial<Parameters<typeof insertItem>[0]> = {}) {
  return insertItem({
    project: 'polimarket-analyser',
    milestone: 'M12',
    text: 'Verify the operator attribution fix',
    classification: 'Read-Only',
    sources: [{ sourceTaskId: 'notion:abc', sourceTaskTitle: 'Fix' }],
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  });
}

function latestEventOperator(gateItemId: string): string | null {
  const row = db
    .prepare(
      `SELECT operator FROM gate_item_event WHERE gate_item_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(gateItemId) as { operator: string | null } | undefined;
  return row?.operator ?? null;
}

function latestAuditRow(eventType: string): {
  actor_type: string;
  actor_id: string | null;
} {
  const row = db
    .prepare(
      `SELECT actor_type, actor_id FROM audit_log WHERE event_type = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(eventType) as { actor_type: string; actor_id: string | null };
  return row;
}

describe('operator attribution — POST /api/gate/items/:id/events', () => {
  it('device auth with no body operator attributes to the device name', async () => {
    const item = makeItem();
    const res = await request(makeApp(deviceAuth(testDevice)))
      .post(`/api/gate/items/${item.id}/events`)
      .send({ evidence: 'looked fine' });
    expect(res.status).toBe(200);
    expect(latestEventOperator(item.id)).toBe('pedros-macbook');
  });

  it('session route credential with no body operator attributes to a session label', async () => {
    const item = makeItem();
    const res = await request(makeApp(sessionAuth('sess-abc')))
      .post(`/api/gate/items/${item.id}/events`)
      .send({ evidence: 'looked fine' });
    expect(res.status).toBe(200);
    const operator = latestEventOperator(item.id);
    expect(operator).not.toBeNull();
    expect(operator).not.toBe('undefined');
    expect(operator).toContain('sess-abc');
  });

  it('an explicit body operator wins over the device identity', async () => {
    const item = makeItem();
    await request(makeApp(deviceAuth(testDevice)))
      .post(`/api/gate/items/${item.id}/events`)
      .send({ evidence: 'looked fine', operator: 'named-human' });
    expect(latestEventOperator(item.id)).toBe('named-human');
  });

  it('an explicit body operator wins over the session identity', async () => {
    const item = makeItem();
    await request(makeApp(sessionAuth('sess-abc')))
      .post(`/api/gate/items/${item.id}/events`)
      .send({ evidence: 'looked fine', operator: 'named-human' });
    expect(latestEventOperator(item.id)).toBe('named-human');
  });
});

describe('operator attribution — POST /api/gate/items/:id/approve', () => {
  function makePendingApproval() {
    const item = makeItem({ classification: 'Prod-Mutating' });
    appendGateItemEvent(item.id, { disposition: 'pass' });
    return item;
  }

  it('device auth with no body operator: approves with device-name operator and a non-system audit_log row', async () => {
    const item = makePendingApproval();
    const res = await request(makeApp(deviceAuth(testDevice)))
      .post(`/api/gate/items/${item.id}/approve`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('pass');
    expect(latestEventOperator(item.id)).toBe('pedros-macbook');
    const audit = latestAuditRow('gate_item_event_appended');
    expect(audit.actor_id).not.toBeNull();
    expect(
      audit.actor_type === 'system' && audit.actor_id === null,
    ).toBe(false);
  });

  it('session route credential with no body operator: approves with a session-label operator and a non-system audit_log row', async () => {
    const item = makePendingApproval();
    const res = await request(makeApp(sessionAuth('sess-xyz')))
      .post(`/api/gate/items/${item.id}/approve`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('pass');
    const operator = latestEventOperator(item.id);
    expect(operator).not.toBeNull();
    expect(operator).toContain('sess-xyz');
    const audit = latestAuditRow('gate_item_event_appended');
    expect(audit.actor_id).not.toBeNull();
    expect(
      audit.actor_type === 'system' && audit.actor_id === null,
    ).toBe(false);
  });

  it('an explicit body operator wins over either auth identity', async () => {
    const item = makePendingApproval();
    await request(makeApp(deviceAuth(testDevice)))
      .post(`/api/gate/items/${item.id}/approve`)
      .send({ operator: 'named-human' });
    expect(latestEventOperator(item.id)).toBe('named-human');
  });
});

describe('operator attribution — POST /api/gate/items/:id/reject', () => {
  function makePendingApproval() {
    const item = makeItem({ classification: 'Prod-Mutating' });
    appendGateItemEvent(item.id, { disposition: 'pass' });
    return item;
  }

  it('device auth with no body operator attributes to the device name', async () => {
    const item = makePendingApproval();
    const res = await request(makeApp(deviceAuth(testDevice)))
      .post(`/api/gate/items/${item.id}/reject`)
      .send({ reason: 'not comfortable yet' });
    expect(res.status).toBe(200);
    expect(latestEventOperator(item.id)).toBe('pedros-macbook');
  });

  it('session route credential with no body operator attributes to a session label', async () => {
    const item = makePendingApproval();
    const res = await request(makeApp(sessionAuth('sess-abc')))
      .post(`/api/gate/items/${item.id}/reject`)
      .send({ reason: 'not comfortable yet' });
    expect(res.status).toBe(200);
    expect(latestEventOperator(item.id)).toContain('sess-abc');
  });

  it('an explicit body operator wins over either auth identity', async () => {
    const item = makePendingApproval();
    await request(makeApp(sessionAuth('sess-abc')))
      .post(`/api/gate/items/${item.id}/reject`)
      .send({ reason: 'no', operator: 'named-human' });
    expect(latestEventOperator(item.id)).toBe('named-human');
  });
});

describe('operator attribution — POST /api/gate/items/:id/reopen', () => {
  function makeResolved() {
    const item = makeItem({ classification: 'Read-Only' });
    appendGateItemEvent(item.id, { disposition: 'pass' });
    return item;
  }

  it('device auth with no body operator attributes to the device name', async () => {
    const item = makeResolved();
    const res = await request(makeApp(deviceAuth(testDevice)))
      .post(`/api/gate/items/${item.id}/reopen`)
      .send({});
    expect(res.status).toBe(200);
    expect(latestEventOperator(item.id)).toBe('pedros-macbook');
  });

  it('session route credential with no body operator attributes to a session label', async () => {
    const item = makeResolved();
    const res = await request(makeApp(sessionAuth('sess-abc')))
      .post(`/api/gate/items/${item.id}/reopen`)
      .send({});
    expect(res.status).toBe(200);
    expect(latestEventOperator(item.id)).toContain('sess-abc');
  });

  it('an explicit body operator wins over either auth identity', async () => {
    const item = makeResolved();
    await request(makeApp(deviceAuth(testDevice)))
      .post(`/api/gate/items/${item.id}/reopen`)
      .send({ operator: 'named-human' });
    expect(latestEventOperator(item.id)).toBe('named-human');
  });
});

describe('operator attribution — POST /api/gate/items/:id/classification', () => {
  it('device auth with no body operator attributes to the device name', async () => {
    const item = makeItem({ classification: 'Read-Only' });
    const res = await request(makeApp(deviceAuth(testDevice)))
      .post(`/api/gate/items/${item.id}/classification`)
      .send({ classification: 'Human-Observation' });
    expect(res.status).toBe(200);
    expect(latestEventOperator(item.id)).toBe('pedros-macbook');
  });

  it('session route credential with no body operator attributes to a session label', async () => {
    const item = makeItem({ classification: 'Read-Only' });
    const res = await request(makeApp(sessionAuth('sess-abc')))
      .post(`/api/gate/items/${item.id}/classification`)
      .send({ classification: 'Human-Observation' });
    expect(res.status).toBe(200);
    expect(latestEventOperator(item.id)).toContain('sess-abc');
  });

  it('an explicit body operator wins over either auth identity', async () => {
    const item = makeItem({ classification: 'Read-Only' });
    await request(makeApp(sessionAuth('sess-abc')))
      .post(`/api/gate/items/${item.id}/classification`)
      .send({ classification: 'Human-Observation', operator: 'named-human' });
    expect(latestEventOperator(item.id)).toBe('named-human');
  });
});
