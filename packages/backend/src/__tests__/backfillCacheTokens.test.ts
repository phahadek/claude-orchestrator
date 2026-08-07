import { describe, it, expect, vi } from 'vitest';
import { makeEventRow } from '../../test/helpers/eventFixtures';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import {
  insertSession,
  insertEventOrIgnore,
  getSession,
  getEventsBySession,
  getAllSessionIds,
} from '../db/queries.js';
import { db } from '../db/db.js';
import {
  reconstructCacheTokenTotals,
  backfillCacheTokens,
} from '../../scripts/backfill-cache-tokens';

function makeSession(id: string, prunedAt: number | null = null) {
  insertSession({
    session_id: id,
    task_id: null,
    task_url: null,
    project_context_url: null,
    project_id: null,
    status: 'done' as const,
    started_at: Date.now(),
  });
  if (prunedAt != null) {
    db.prepare(
      `UPDATE sessions SET events_pruned_at = ? WHERE session_id = ?`,
    ).run(prunedAt, id);
  }
}

function addResultEvent(
  sessionId: string,
  cacheRead: number,
  cacheCreation: number,
) {
  insertEventOrIgnore({
    session_id: sessionId,
    ...makeEventRow('result').live,
    payload: JSON.stringify({
      type: 'result',
      subtype: 'success',
      usage: {
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
      },
    }),
    timestamp: Date.now(),
  });
}

describe('reconstructCacheTokenTotals', () => {
  it('sums cache_read/cache_creation across every result event in a fixture session', () => {
    makeSession('bf-cache-fixture');
    addResultEvent('bf-cache-fixture', 1000, 100);
    addResultEvent('bf-cache-fixture', 2000, 50);
    addResultEvent('bf-cache-fixture', 3000, 25);

    const events = getEventsBySession('bf-cache-fixture');
    const totals = reconstructCacheTokenTotals(events);

    expect(totals.cacheReadTokens).toBe(6000);
    expect(totals.cacheCreationTokens).toBe(175);
  });

  it('ignores non-result events and events with no usage field', () => {
    makeSession('bf-cache-mixed');
    insertEventOrIgnore({
      session_id: 'bf-cache-mixed',
      ...makeEventRow('text').live,
      timestamp: Date.now(),
    });
    addResultEvent('bf-cache-mixed', 500, 10);

    const events = getEventsBySession('bf-cache-mixed');
    const totals = reconstructCacheTokenTotals(events);

    expect(totals.cacheReadTokens).toBe(500);
    expect(totals.cacheCreationTokens).toBe(10);
  });
});

describe('backfillCacheTokens', () => {
  it('writes the reconstructed cumulative totals for an unpruned session', () => {
    makeSession('bf-cache-write-1');
    addResultEvent('bf-cache-write-1', 1000, 200);
    addResultEvent('bf-cache-write-1', 500, 100);

    const totalBefore = getAllSessionIds().length;
    const summary = backfillCacheTokens(totalBefore);

    const row = getSession('bf-cache-write-1');
    expect(row?.cache_read_tokens).toBe(1500);
    expect(row?.cache_creation_tokens).toBe(300);
    expect(summary.backfilled).toBeGreaterThanOrEqual(1);
    expect(summary.skippedPruned).toBe(0);
  });

  it('skips (and counts) sessions with events_pruned_at set, leaving their columns untouched', () => {
    makeSession('bf-cache-pruned-1', Date.now());
    addResultEvent('bf-cache-pruned-1', 999, 999);

    const totalBefore = getAllSessionIds().length;
    const summary = backfillCacheTokens(totalBefore);

    const row = getSession('bf-cache-pruned-1');
    expect(row?.cache_read_tokens).toBe(0);
    expect(row?.cache_creation_tokens).toBe(0);
    expect(summary.skippedPruned).toBeGreaterThanOrEqual(1);
  });

  it('counts sessions with no cache-token usage as skippedNoData, without writing', () => {
    makeSession('bf-cache-nodata-1');
    addResultEvent('bf-cache-nodata-1', 0, 0);

    const totalBefore = getAllSessionIds().length;
    const summary = backfillCacheTokens(totalBefore);

    const row = getSession('bf-cache-nodata-1');
    expect(row?.cache_read_tokens).toBe(0);
    expect(row?.cache_creation_tokens).toBe(0);
    expect(summary.skippedNoData).toBeGreaterThanOrEqual(1);
  });
});
