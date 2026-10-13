import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';

function plan(sql: string): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as {
    detail: string;
  }[];
  return rows.map((r) => r.detail).join('\n');
}

describe('listAwaitingDispositionRuns query plan', () => {
  it('seeks idx_test_request_runs_state_awaiting_disposition with no temp sort', () => {
    const detail = plan(
      `SELECT test_request_runs.id
       FROM test_request_runs
       JOIN sessions s ON s.session_id = test_request_runs.session_id
       WHERE test_request_runs.state = 'failed'
         AND test_request_runs.awaiting_disposition_at IS NOT NULL
         AND s.status NOT IN ('done', 'error', 'killed')
       ORDER BY test_request_runs.awaiting_disposition_at ASC LIMIT 500`,
    );
    expect(detail).toMatch(
      /SEARCH test_request_runs USING (COVERING )?INDEX idx_test_request_runs_state_awaiting_disposition/,
    );
    expect(detail).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
  });
});
