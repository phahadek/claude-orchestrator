import { describe, it, expect, vi } from 'vitest';

// ── DB-level: incrementCompactionCount query ────────────────────────────────
// Uses an in-memory SQLite database so persistence is verified without touching
// the real dashboard.db.

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import {
  insertSession,
  getSession,
  incrementCompactionCount,
} from '../db/queries.js';

const baseSession = {
  session_id: 'compaction-db-test',
  task_id: null,
  task_url: null,
  project_context_url: null,
  project_id: null,
  status: 'running' as const,
  started_at: Date.now(),
};

describe('incrementCompactionCount — SQLite integration', () => {
  it('initializes compaction_count to 0', () => {
    insertSession(baseSession);
    const row = getSession('compaction-db-test');
    expect(row?.compaction_count).toBe(0);
  });

  it('increments compaction_count by 1 each call (persists across "restarts")', () => {
    incrementCompactionCount('compaction-db-test');
    const row = getSession('compaction-db-test');
    expect(row?.compaction_count).toBe(1);
  });

  it('accumulates across multiple calls', () => {
    incrementCompactionCount('compaction-db-test');
    incrementCompactionCount('compaction-db-test');
    const row = getSession('compaction-db-test');
    expect(row?.compaction_count).toBe(3);
  });
});
