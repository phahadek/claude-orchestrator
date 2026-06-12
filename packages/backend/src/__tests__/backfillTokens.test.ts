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
  incrementTokens,
} from '../db/queries.js';
import { JsonlReader } from '../session/JsonlReader.js';
import { db } from '../db/db.js';

const reader = new JsonlReader('/nonexistent');

function makeSession(id: string) {
  insertSession({
    session_id: id,
    task_id: null,
    task_url: null,
    project_context_url: null,
    project_id: null,
    status: 'done' as const,
    started_at: Date.now(),
  });
}

function addEvent(sessionId: string, payload: Record<string, unknown>) {
  insertEventOrIgnore({
    session_id: sessionId,
    ...makeEventRow('result').live,
    payload: JSON.stringify(payload),
    timestamp: Date.now(),
  });
}

describe('backfillTokens', () => {
  it('populates token columns from result events in session_events', () => {
    makeSession('bf-result-1');
    addEvent('bf-result-1', {
      type: 'result',
      usage: { input_tokens: 150, output_tokens: 75 },
    });

    reader.backfillTokens();

    const row = getSession('bf-result-1');
    expect(row?.total_input_tokens).toBe(150);
    expect(row?.total_output_tokens).toBe(75);
  });

  it('falls back to summing usage from all events when no result event exists', () => {
    makeSession('bf-msg-1');
    addEvent('bf-msg-1', { usage: { input_tokens: 100, output_tokens: 50 } });
    addEvent('bf-msg-1', { usage: { input_tokens: 200, output_tokens: 80 } });

    reader.backfillTokens();

    const row = getSession('bf-msg-1');
    expect(row?.total_input_tokens).toBe(300);
    expect(row?.total_output_tokens).toBe(130);
  });

  it('skips sessions with no usage data (genuinely zero-token)', () => {
    makeSession('bf-zero-1');
    addEvent('bf-zero-1', { type: 'system', message: 'init' });

    reader.backfillTokens();

    const row = getSession('bf-zero-1');
    expect(row?.total_input_tokens).toBe(0);
    expect(row?.total_output_tokens).toBe(0);
  });

  it('skips sessions that already have token counts populated', () => {
    makeSession('bf-skip-1');
    incrementTokens('bf-skip-1', 500, 200);
    addEvent('bf-skip-1', {
      type: 'result',
      usage: { input_tokens: 999, output_tokens: 999 },
    });

    reader.backfillTokens();

    const row = getSession('bf-skip-1');
    expect(row?.total_input_tokens).toBe(500);
    expect(row?.total_output_tokens).toBe(200);
  });

  it('caps at 100 sessions per run', () => {
    for (let i = 0; i < 105; i++) {
      const id = `bf-cap-${String(i).padStart(3, '0')}`;
      makeSession(id);
      addEvent(id, {
        type: 'result',
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    }

    reader.backfillTokens();

    const backfilled = (
      db
        .prepare(
          `SELECT COUNT(*) as cnt FROM sessions WHERE session_id LIKE 'bf-cap-%' AND total_input_tokens > 0`,
        )
        .get() as { cnt: number }
    ).cnt;
    expect(backfilled).toBe(100);
  });
});
