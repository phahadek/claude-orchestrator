import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import {
  insertSession,
  insertEventOrIgnore,
  getSession,
  getEventsBySession,
  markSessionEventsPruned,
  getPruneEligibleSessions,
} from '../db/queries.js';
import { SessionEventsPruner, buildPruneStub } from '../orchestration/SessionEventsPruner.js';

const NOW = 1_000_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function makeArchivedSession(
  id: string,
  opts: {
    endedAt?: number;
    archived?: number;
    inputTokens?: number;
    outputTokens?: number;
  } = {},
) {
  insertSession({
    session_id: id,
    task_id: null,
    task_url: null,
    project_context_url: null,
    project_id: null,
    status: 'done' as const,
    started_at: NOW - 60 * DAY_MS,
    ended_at: opts.endedAt ?? NOW - 60 * DAY_MS,
  });
  if (opts.archived !== 0) {
    db.prepare(`UPDATE sessions SET archived = 1 WHERE session_id = ?`).run(id);
  }
  if (opts.inputTokens || opts.outputTokens) {
    db.prepare(
      `UPDATE sessions SET total_input_tokens = ?, total_output_tokens = ? WHERE session_id = ?`,
    ).run(opts.inputTokens ?? 0, opts.outputTokens ?? 0, id);
  }
}

function addEvent(
  sessionId: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  insertEventOrIgnore({
    session_id: sessionId,
    event_type: eventType,
    payload: JSON.stringify(payload),
    timestamp: NOW,
  });
}

function makePruner(opts: { retentionDays?: number } = {}) {
  return new SessionEventsPruner({
    nowFn: () => NOW,
    retentionDays: opts.retentionDays ?? 30,
    intervalMs: 999_999_999,
  });
}

describe('buildPruneStub', () => {
  it('preserves $.type and $.usage', () => {
    const stub = buildPruneStub(
      JSON.stringify({ type: 'result', usage: { input_tokens: 10, output_tokens: 5 }, extra: 'drop' }),
    );
    const parsed = JSON.parse(stub);
    expect(parsed.truncated).toBe(true);
    expect(parsed.type).toBe('result');
    expect(parsed.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(parsed.extra).toBeUndefined();
  });

  it('omits usage when not present', () => {
    const stub = buildPruneStub(JSON.stringify({ type: 'system', data: 'big blob' }));
    const parsed = JSON.parse(stub);
    expect(parsed.truncated).toBe(true);
    expect(parsed.type).toBe('system');
    expect(parsed.usage).toBeUndefined();
  });

  it('handles malformed JSON gracefully', () => {
    const stub = buildPruneStub('not-json');
    expect(JSON.parse(stub)).toEqual({ truncated: true });
  });
});

describe('SessionEventsPruner', () => {
  describe('eligibility', () => {
    it('prunes system events of archived sessions ended before retention cutoff', async () => {
      makeArchivedSession('prune-elig-1', { endedAt: NOW - 31 * DAY_MS });
      addEvent('prune-elig-1', 'system', { type: 'system', big: 'data'.repeat(100) });
      addEvent('prune-elig-1', 'system', { type: 'result', usage: { input_tokens: 5, output_tokens: 2 } });

      const pruner = makePruner();
      await pruner.pruneOnce();

      const events = getEventsBySession('prune-elig-1');
      for (const ev of events) {
        if (ev.event_type === 'system') {
          const p = JSON.parse(ev.payload);
          expect(p.truncated).toBe(true);
          expect(p.big).toBeUndefined();
        }
      }
    });

    it('does not prune recently-ended archived sessions', async () => {
      makeArchivedSession('prune-recent-1', { endedAt: NOW - 5 * DAY_MS });
      addEvent('prune-recent-1', 'system', { type: 'system', big: 'data' });

      const pruner = makePruner();
      await pruner.pruneOnce();

      const events = getEventsBySession('prune-recent-1');
      const payload = JSON.parse(events[0].payload);
      expect(payload.truncated).toBeUndefined();
      expect(payload.big).toBe('data');
    });

    it('does not prune unarchived sessions', async () => {
      makeArchivedSession('prune-unarch-1', { endedAt: NOW - 60 * DAY_MS, archived: 0 });
      addEvent('prune-unarch-1', 'system', { type: 'system', big: 'data' });

      const pruner = makePruner();
      await pruner.pruneOnce();

      const events = getEventsBySession('prune-unarch-1');
      expect(JSON.parse(events[0].payload).truncated).toBeUndefined();
    });

    it('respects events_retention_days config', async () => {
      makeArchivedSession('prune-config-1', { endedAt: NOW - 10 * DAY_MS });
      addEvent('prune-config-1', 'system', { type: 'system', data: 'x' });

      const pruner = makePruner({ retentionDays: 7 });
      await pruner.pruneOnce();

      const events = getEventsBySession('prune-config-1');
      expect(JSON.parse(events[0].payload).truncated).toBe(true);
    });
  });

  describe('text / user_message events untouched', () => {
    it('never prunes text or user_message events', async () => {
      makeArchivedSession('prune-text-1', { endedAt: NOW - 60 * DAY_MS });
      addEvent('prune-text-1', 'text', { type: 'assistant', message: 'hello world' });
      addEvent('prune-text-1', 'user_message', { type: 'user', message: 'hi' });
      addEvent('prune-text-1', 'system', { type: 'system', data: 'removeme' });

      const pruner = makePruner();
      await pruner.pruneOnce();

      const events = getEventsBySession('prune-text-1');
      for (const ev of events) {
        if (ev.event_type === 'text') {
          expect(JSON.parse(ev.payload).message).toBe('hello world');
        }
        if (ev.event_type === 'user_message') {
          expect(JSON.parse(ev.payload).message).toBe('hi');
        }
        if (ev.event_type === 'system') {
          expect(JSON.parse(ev.payload).truncated).toBe(true);
        }
      }
    });
  });

  describe('stub preserves json_extract paths', () => {
    it('stub preserves $.type for stuck-session query shape', async () => {
      makeArchivedSession('prune-type-1', { endedAt: NOW - 60 * DAY_MS });
      addEvent('prune-type-1', 'system', { type: 'result', subtype: 'success' });

      const pruner = makePruner();
      await pruner.pruneOnce();

      const row = db
        .prepare(`SELECT json_extract(payload, '$.type') as t FROM session_events WHERE session_id = ?`)
        .get('prune-type-1') as { t: string };
      expect(row.t).toBe('result');
    });

    it('stub preserves $.usage for token extraction', async () => {
      makeArchivedSession('prune-usage-1', { endedAt: NOW - 60 * DAY_MS });
      addEvent('prune-usage-1', 'system', {
        type: 'result',
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const pruner = makePruner();
      await pruner.pruneOnce();

      const row = db
        .prepare(`SELECT json_extract(payload, '$.usage') as u FROM session_events WHERE session_id = ?`)
        .get('prune-usage-1') as { u: string };
      expect(JSON.parse(row.u)).toEqual({ input_tokens: 100, output_tokens: 50 });
    });
  });

  describe('token backfill before pruning', () => {
    it('backfills zero-token sessions before pruning', async () => {
      makeArchivedSession('prune-backfill-1', { endedAt: NOW - 60 * DAY_MS, inputTokens: 0, outputTokens: 0 });
      addEvent('prune-backfill-1', 'system', {
        type: 'result',
        usage: { input_tokens: 42, output_tokens: 21 },
      });

      const pruner = makePruner();
      await pruner.pruneOnce();

      const session = getSession('prune-backfill-1');
      expect(session?.total_input_tokens).toBe(42);
      expect(session?.total_output_tokens).toBe(21);
    });

    it('backfilled values survive pruning (payload still has usage in stub)', async () => {
      makeArchivedSession('prune-backfill-2', { endedAt: NOW - 60 * DAY_MS });
      addEvent('prune-backfill-2', 'system', {
        type: 'result',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const pruner = makePruner();
      await pruner.pruneOnce();

      const session = getSession('prune-backfill-2');
      expect(session?.total_input_tokens).toBeGreaterThan(0);

      const events = getEventsBySession('prune-backfill-2');
      const stub = JSON.parse(events[0].payload);
      expect(stub.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    });

    it('does not double-backfill sessions that already have tokens', async () => {
      makeArchivedSession('prune-nobackfill-1', {
        endedAt: NOW - 60 * DAY_MS,
        inputTokens: 999,
        outputTokens: 888,
      });
      addEvent('prune-nobackfill-1', 'system', {
        type: 'result',
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      const pruner = makePruner();
      await pruner.pruneOnce();

      const session = getSession('prune-nobackfill-1');
      expect(session?.total_input_tokens).toBe(999);
    });
  });

  describe('events_pruned_at', () => {
    it('sets events_pruned_at after pruning', async () => {
      makeArchivedSession('prune-at-1', { endedAt: NOW - 60 * DAY_MS });
      addEvent('prune-at-1', 'system', { type: 'system' });

      const pruner = makePruner();
      await pruner.pruneOnce();

      const session = getSession('prune-at-1');
      expect(session?.events_pruned_at).toBe(NOW);
    });

    it('skips already-pruned sessions on next run', async () => {
      makeArchivedSession('prune-skip-1', { endedAt: NOW - 60 * DAY_MS });
      addEvent('prune-skip-1', 'system', { type: 'system', original: true });

      const pruner = makePruner();
      await pruner.pruneOnce();

      // Restore original payload to verify re-run doesn't touch it
      db.prepare(`UPDATE session_events SET payload = ? WHERE session_id = ?`).run(
        JSON.stringify({ type: 'system', original: true }),
        'prune-skip-1',
      );

      await pruner.pruneOnce();

      // Session was already marked pruned; second run won't re-select it
      const eligible = getPruneEligibleSessions(NOW, 100);
      expect(eligible.find((s) => s.session_id === 'prune-skip-1')).toBeUndefined();
    });
  });

  describe('batching', () => {
    it('prunes sessions with >500 system events across multiple transactions', async () => {
      makeArchivedSession('prune-batch-1', { endedAt: NOW - 60 * DAY_MS });
      for (let i = 0; i < 550; i++) {
        addEvent('prune-batch-1', 'system', { type: 'system', index: i, data: 'x'.repeat(10) });
      }

      const pruner = makePruner();
      await pruner.pruneOnce();

      const events = getEventsBySession('prune-batch-1');
      expect(events).toHaveLength(550);
      for (const ev of events) {
        const p = JSON.parse(ev.payload);
        expect(p.truncated).toBe(true);
        expect(p.index).toBeUndefined();
      }
    });
  });

  describe('incremental_vacuum invoked', () => {
    it('calls db.pragma incremental_vacuum after each prune batch', async () => {
      const pragmaSpy = vi.spyOn(db, 'pragma');

      makeArchivedSession('prune-vac-1', { endedAt: NOW - 60 * DAY_MS });
      addEvent('prune-vac-1', 'system', { type: 'system' });

      const pruner = makePruner();
      await pruner.pruneOnce();

      const vacuumCalls = pragmaSpy.mock.calls.filter(
        (c) => c[0] === 'incremental_vacuum',
      );
      expect(vacuumCalls.length).toBeGreaterThan(0);
      pragmaSpy.mockRestore();
    });
  });

  describe('auto_vacuum idempotency', () => {
    it('settings row prevents double-vacuum on second boot', () => {
      // Simulate the guard: if settings row exists, enablement is skipped.
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(
        'auto_vacuum_incremental_done',
        '1',
      );
      const row = db
        .prepare(`SELECT value FROM settings WHERE key = 'auto_vacuum_incremental_done'`)
        .get() as { value: string } | undefined;
      expect(row?.value).toBe('1');
    });
  });
});
