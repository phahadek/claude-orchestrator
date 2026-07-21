import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import { getVerifySessionsForGateItems } from '../db/queries.js';

function insertSession(opts: {
  session_id: string;
  task_id?: string | null;
  status?: string;
  started_at?: number;
  ended_at?: number | null;
}): void {
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, status, started_at, ended_at)
     VALUES (@session_id, @task_id, @status, @started_at, @ended_at)`,
  ).run({
    session_id: opts.session_id,
    task_id: opts.task_id ?? null,
    status: opts.status ?? 'running',
    started_at: opts.started_at ?? 0,
    ended_at: opts.ended_at ?? null,
  });
}

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
});

describe('getVerifySessionsForGateItems() — gate item ↔ verify session linkage', () => {
  it('resolves a gate item to its verify session', () => {
    insertSession({
      session_id: 'sess-1',
      task_id: 'gate-item:item-abc',
      status: 'running',
      started_at: 100,
    });

    const rows = getVerifySessionsForGateItems(['item-abc']);

    expect(rows).toEqual([
      {
        itemId: 'item-abc',
        sessionId: 'sess-1',
        sessionStatus: 'running',
        startedAt: 100,
        endedAt: null,
      },
    ]);
  });

  it('returns an empty array for a gate item with no verify session', () => {
    expect(getVerifySessionsForGateItems(['item-none'])).toEqual([]);
  });

  it('returns an empty array when given no item ids, without querying', () => {
    expect(getVerifySessionsForGateItems([])).toEqual([]);
  });

  it('ignores sessions for unrelated tasks and other gate items', () => {
    insertSession({
      session_id: 'sess-other-task',
      task_id: 'notion:task-1',
      started_at: 50,
    });
    insertSession({
      session_id: 'sess-other-item',
      task_id: 'gate-item:item-xyz',
      started_at: 60,
    });

    expect(getVerifySessionsForGateItems(['item-abc'])).toEqual([]);
  });

  it('orders multiple verify sessions for the same item most-recent-first', () => {
    insertSession({
      session_id: 'sess-old',
      task_id: 'gate-item:item-abc',
      status: 'done',
      started_at: 100,
    });
    insertSession({
      session_id: 'sess-new',
      task_id: 'gate-item:item-abc',
      status: 'running',
      started_at: 200,
    });

    const rows = getVerifySessionsForGateItems(['item-abc']);

    expect(rows.map((r) => r.sessionId)).toEqual(['sess-new', 'sess-old']);
  });

  it('resolves sessions across multiple gate items in one call', () => {
    insertSession({
      session_id: 'sess-a',
      task_id: 'gate-item:item-a',
      started_at: 10,
    });
    insertSession({
      session_id: 'sess-b',
      task_id: 'gate-item:item-b',
      started_at: 20,
    });

    const rows = getVerifySessionsForGateItems(['item-a', 'item-b']);

    expect(rows.map((r) => r.itemId).sort()).toEqual(['item-a', 'item-b']);
  });
});
