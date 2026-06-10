import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import {
  insertEvent,
  insertEventOrIgnore,
  upsertSessionEvent,
  MAX_EVENT_PAYLOAD_BYTES,
} from '../db/queries.js';

const SESSION_ID = 'test-session-payload-cap';

function insertTestSession(): void {
  db.prepare(
    `INSERT INTO sessions (session_id, status, started_at) VALUES (?, 'running', 0)`,
  ).run(SESSION_ID);
}

function makeLargePayload(type = 'result'): string {
  // Pad enough to exceed 256 KB after JSON serialization
  const padding = 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES + 4096);
  return JSON.stringify({
    type,
    usage: { input_tokens: 42, output_tokens: 99 },
    data: padding,
  });
}

function makeSmallPayload(type = 'system'): string {
  return JSON.stringify({ type, usage: { input_tokens: 1, output_tokens: 2 }, data: 'small' });
}

function getLastEvent(): { payload: string } {
  return db
    .prepare(
      `SELECT payload FROM session_events WHERE session_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(SESSION_ID) as { payload: string };
}

beforeEach(() => {
  db.prepare('DELETE FROM session_events').run();
  db.prepare('DELETE FROM sessions').run();
  insertTestSession();
});

describe('MAX_EVENT_PAYLOAD_BYTES', () => {
  it('is exported and equals 262144', () => {
    expect(MAX_EVENT_PAYLOAD_BYTES).toBe(262144);
  });
});

describe('insertEvent — payload cap', () => {
  it('stores large payload truncated with required fields', () => {
    const original = makeLargePayload('result');
    expect(Buffer.byteLength(original, 'utf8')).toBeGreaterThan(MAX_EVENT_PAYLOAD_BYTES);

    insertEvent({ session_id: SESSION_ID, event_type: 'system', payload: original, timestamp: 1 });

    const stored = JSON.parse(getLastEvent().payload);
    expect(stored.truncated).toBe(true);
    expect(stored.type).toBe('result');
    expect(stored.usage).toEqual({ input_tokens: 42, output_tokens: 99 });
    expect(typeof stored.head).toBe('string');
    expect(stored.head).toBe(original.slice(0, 8192));
  });

  it('stored truncated payload is valid JSON with extractable $.type and $.usage', () => {
    const original = makeLargePayload('result');
    insertEvent({ session_id: SESSION_ID, event_type: 'system', payload: original, timestamp: 1 });

    const row = db
      .prepare(
        `SELECT json_extract(payload,'$.type') AS type, json_extract(payload,'$.usage.input_tokens') AS input FROM session_events WHERE session_id = ?`,
      )
      .get(SESSION_ID) as { type: string; input: number };
    expect(row.type).toBe('result');
    expect(row.input).toBe(42);
  });

  it('stores small payload byte-identical', () => {
    const original = makeSmallPayload('system');
    expect(Buffer.byteLength(original, 'utf8')).toBeLessThanOrEqual(MAX_EVENT_PAYLOAD_BYTES);

    insertEvent({ session_id: SESSION_ID, event_type: 'system', payload: original, timestamp: 1 });

    expect(getLastEvent().payload).toBe(original);
  });

  it('truncated payload omits usage when original has no $.usage', () => {
    const noUsage = JSON.stringify({ type: 'ping', data: 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES + 1) });
    insertEvent({ session_id: SESSION_ID, event_type: 'system', payload: noUsage, timestamp: 1 });

    const stored = JSON.parse(getLastEvent().payload);
    expect(stored.truncated).toBe(true);
    expect(stored.type).toBe('ping');
    expect('usage' in stored).toBe(false);
  });
});

describe('insertEventOrIgnore — payload cap', () => {
  it('stores large payload truncated', () => {
    const original = makeLargePayload('system');
    insertEventOrIgnore({ session_id: SESSION_ID, event_type: 'system', payload: original, timestamp: 2 });

    const stored = JSON.parse(getLastEvent().payload);
    expect(stored.truncated).toBe(true);
    expect(stored.type).toBe('system');
  });

  it('stores small payload byte-identical', () => {
    const original = makeSmallPayload('system');
    insertEventOrIgnore({ session_id: SESSION_ID, event_type: 'system', payload: original, timestamp: 2 });
    expect(getLastEvent().payload).toBe(original);
  });
});

describe('upsertSessionEvent — payload cap', () => {
  it('caps large payload on insert path', () => {
    const original = makeLargePayload('assistant');
    upsertSessionEvent({ session_id: SESSION_ID, event_type: 'system', payload: original, timestamp: 3 });

    const stored = JSON.parse(getLastEvent().payload);
    expect(stored.truncated).toBe(true);
    expect(stored.type).toBe('assistant');
  });

  it('caps large payload on update path (existingId provided)', () => {
    const small = makeSmallPayload('system');
    const id = upsertSessionEvent({ session_id: SESSION_ID, event_type: 'system', payload: small, timestamp: 3 });

    const original = makeLargePayload('assistant');
    upsertSessionEvent({ session_id: SESSION_ID, event_type: 'system', payload: original, timestamp: 4 }, id);

    const stored = JSON.parse(getLastEvent().payload);
    expect(stored.truncated).toBe(true);
    expect(stored.type).toBe('assistant');
  });

  it('stores small payload byte-identical on insert path', () => {
    const original = makeSmallPayload('system');
    upsertSessionEvent({ session_id: SESSION_ID, event_type: 'system', payload: original, timestamp: 3 });
    expect(getLastEvent().payload).toBe(original);
  });

  it('stores small payload byte-identical on update path', () => {
    const small = makeSmallPayload('system');
    const id = upsertSessionEvent({ session_id: SESSION_ID, event_type: 'system', payload: small, timestamp: 3 });

    const updated = makeSmallPayload('assistant');
    upsertSessionEvent({ session_id: SESSION_ID, event_type: 'system', payload: updated, timestamp: 4 }, id);
    expect(getLastEvent().payload).toBe(updated);
  });
});
