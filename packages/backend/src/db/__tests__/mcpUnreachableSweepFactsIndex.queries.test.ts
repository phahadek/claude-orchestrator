/**
 * Tests for idx_audit_log_actor_event_ts and getMcpUnreachableSweepFacts —
 * the composite index and the batched query it backs, replacing the
 * per-live-session hasMcpUnreachableExhaustedEvent /
 * getLatestMcpUnreachableRespawnTimestamp point queries
 * reconcileMcpUnreachableSessions used to issue (SessionManager.ts).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import { getMcpUnreachableSweepFacts } from '../queries.js';

function planFor(sql: string, params: unknown[]): string {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as {
      detail: string;
    }[]
  )
    .map((r) => r.detail)
    .join(' | ');
}

function insertAuditEvent(
  actorId: string,
  eventType: string,
  ts: number,
): void {
  db.prepare(
    `INSERT INTO audit_log (ts, event_type, actor_type, actor_id, payload)
     VALUES (?, ?, 'system', ?, '{}')`,
  ).run(ts, eventType, actorId);
}

describe('idx_audit_log_actor_event_ts', () => {
  it('is created by runMigrations', () => {
    const idx = db.prepare(`PRAGMA index_list(audit_log)`).all() as {
      name: string;
    }[];
    expect(idx.map((i) => i.name)).toContain('idx_audit_log_actor_event_ts');
  });

  it('keeps idx_audit_log_actor_id (other readers filter on actor_id alone)', () => {
    const idx = db.prepare(`PRAGMA index_list(audit_log)`).all() as {
      name: string;
    }[];
    expect(idx.map((i) => i.name)).toContain('idx_audit_log_actor_id');
  });

  it('resolves an actor_id + event_type point lookup with ORDER BY ts DESC LIMIT 1 via the composite index, with no temp b-tree', () => {
    const plan = planFor(
      `SELECT * FROM audit_log WHERE event_type = ? AND actor_id = ? ORDER BY ts DESC LIMIT 1`,
      ['session_mcp_unreachable_respawned', 'sess-1'],
    );
    expect(plan).toMatch(/USING INDEX idx_audit_log_actor_event_ts/);
    expect(plan).not.toMatch(/TEMP B-TREE/i);
  });
});

describe('getMcpUnreachableSweepFacts', () => {
  it('returns an empty map for an empty session id list without querying', () => {
    expect(getMcpUnreachableSweepFacts([])).toEqual(new Map());
  });

  it('reports exhausted only for sessions with a respawn_exhausted row, and lastRespawnTs as the newest respawned ts, for a mixed 5-session fixture', () => {
    const now = Date.now();

    // sess-exhausted: has an exhausted event, and prior respawns.
    insertAuditEvent('sess-exhausted', 'session_mcp_unreachable_respawned', now - 3000);
    insertAuditEvent('sess-exhausted', 'session_mcp_unreachable_respawned', now - 2000);
    insertAuditEvent(
      'sess-exhausted',
      'session_mcp_unreachable_respawn_exhausted',
      now - 1000,
    );

    // sess-respawned-once: one respawn, never exhausted.
    insertAuditEvent(
      'sess-respawned-once',
      'session_mcp_unreachable_respawned',
      now - 500,
    );

    // sess-respawned-twice: two respawns — lastRespawnTs is the newer one.
    insertAuditEvent(
      'sess-respawned-twice',
      'session_mcp_unreachable_respawned',
      now - 9000,
    );
    insertAuditEvent(
      'sess-respawned-twice',
      'session_mcp_unreachable_respawned',
      now - 4000,
    );

    // sess-clean: no mcp-unreachable events at all.

    // sess-other-event: unrelated audit rows only — must not be mistaken
    // for a respawn/exhaustion signal.
    insertAuditEvent('sess-other-event', 'session_status_changed', now - 100);

    const facts = getMcpUnreachableSweepFacts([
      'sess-exhausted',
      'sess-respawned-once',
      'sess-respawned-twice',
      'sess-clean',
      'sess-other-event',
    ]);

    expect(facts.get('sess-exhausted')).toEqual({
      exhausted: true,
      lastRespawnTs: now - 2000,
    });
    expect(facts.get('sess-respawned-once')).toEqual({
      exhausted: false,
      lastRespawnTs: now - 500,
    });
    expect(facts.get('sess-respawned-twice')).toEqual({
      exhausted: false,
      lastRespawnTs: now - 4000,
    });
    expect(facts.get('sess-clean')).toBeUndefined();
    expect(facts.get('sess-other-event')).toBeUndefined();
  });

  it('only reflects the requested session ids, ignoring events for other actors', () => {
    insertAuditEvent(
      'sess-not-requested',
      'session_mcp_unreachable_respawn_exhausted',
      Date.now(),
    );

    const facts = getMcpUnreachableSweepFacts(['sess-requested']);

    expect(facts.size).toBe(0);
  });
});
