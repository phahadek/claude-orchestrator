/**
 * Tests for the staged_intent(session_id, state) index. Every session-scoped
 * staged_intent read (listStagedIntentsBySession, hasBlockedStagedIntentForSession,
 * hasActiveStagedIntentForSession — the latter two backing isSessionComplete)
 * previously fell back to a bare SCAN staged_intent, since none of the
 * table's five prior indexes contained session_id. Measured live at 7,804
 * rows / ~10.5 ms per scan; the decision surface's GET /api/staged-intents
 * runs two of these per row (isSessionComplete), and the approve/commit path
 * runs them per group member.
 *
 * These assert the access path via EXPLAIN QUERY PLAN, not timing, so a
 * regression shows up as a plan change rather than a flaky benchmark.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  insertStagedIntent,
  insertSession,
  hashIntentPayload,
  listStagedIntentsBySession,
  isSessionComplete,
} from '../queries.js';
import type { StagedIntentRow } from '../types.js';

/** Plan text for a statement, joined so it can be asserted as a whole. */
function planFor(sql: string, params: Record<string, unknown>): string {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as {
      detail: string;
    }[]
  )
    .map((r) => r.detail)
    .join(' | ');
}

// The three statements exactly as queries.ts issues them.
const LIST_BY_SESSION_SQL = `SELECT * FROM staged_intent WHERE session_id = @session_id ORDER BY created_at ASC`;
const HAS_BLOCKED_SQL = `SELECT 1 FROM staged_intent
     WHERE session_id = @session_id AND state IN ('needs_revision', 'pending_verification')
     LIMIT 1`;
const HAS_ACTIVE_SQL = `SELECT 1 FROM staged_intent
     WHERE session_id = @session_id AND state IN ('staged', 'approved')
     LIMIT 1`;

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM sessions').run();
});

function seedSession(sessionId: string): void {
  insertSession({
    session_id: sessionId,
    task_id: `task:${sessionId}`,
    task_url: null,
    project_context_url: null,
    status: 'idle',
    started_at: 0,
    session_type: 'standard',
    task_name: null,
    metadata: null,
    review_result: null,
    pause_reason: null,
    last_error_detail: null,
    events_pruned_at: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    compaction_count: 0,
    context_occupancy_tokens: 0,
  } as never);
}

function makeRow(overrides: Partial<StagedIntentRow> = {}): StagedIntentRow {
  const payload = overrides.payload ?? JSON.stringify({ note: overrides.id });
  return {
    id: 'intent-1',
    kind: 'session.requestCapability',
    payload,
    payload_hash: hashIntentPayload(JSON.parse(payload)),
    task_id: null,
    project_id: 'proj-1',
    session_id: null,
    group_id: null,
    milestone: null,
    state: 'staged',
    supersedes: null,
    annotation: null,
    decision_proposal: null,
    groom_proposal: null,
    advisory: null,
    disposition_reason: null,
    answer: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  } as StagedIntentRow;
}

describe('staged_intent(session_id, state) index', () => {
  it('is created by the schema', () => {
    const idx = db.prepare(`PRAGMA index_list(staged_intent)`).all() as {
      name: string;
    }[];
    expect(idx.map((i) => i.name)).toContain('idx_staged_intent_session_id');
  });

  it('resolves listStagedIntentsBySession by session_id without scanning the table', () => {
    const plan = planFor(LIST_BY_SESSION_SQL, { session_id: 'sess-1' });
    expect(plan).toContain('idx_staged_intent_session_id');
    // A bare "SCAN staged_intent" (no USING) is the regression this guards.
    expect(plan).not.toMatch(/SCAN staged_intent(?! USING)/);
  });

  it('resolves hasBlockedStagedIntentForSession by session_id without scanning the table', () => {
    const plan = planFor(HAS_BLOCKED_SQL, { session_id: 'sess-1' });
    expect(plan).toContain('idx_staged_intent_session_id');
    expect(plan).not.toMatch(/SCAN staged_intent(?! USING)/);
  });

  it('resolves hasActiveStagedIntentForSession by session_id without scanning the table', () => {
    const plan = planFor(HAS_ACTIVE_SQL, { session_id: 'sess-1' });
    expect(plan).toContain('idx_staged_intent_session_id');
    expect(plan).not.toMatch(/SCAN staged_intent(?! USING)/);
  });

  it('still requires a temp b-tree to serve ORDER BY created_at, since the index leads with state, not created_at', () => {
    // The index is (session_id, state) so the two state-filtered LIMIT-1
    // probes above are answered entirely from the index. listStagedIntentsBySession
    // has no state predicate, so after the session_id search SQLite still
    // needs to sort by created_at itself — documented here rather than
    // silently regressing to a bare scan.
    const plan = planFor(LIST_BY_SESSION_SQL, { session_id: 'sess-1' });
    expect(plan).toContain('USE TEMP B-TREE FOR ORDER BY');
  });

  it('returns byte-identical results for listStagedIntentsBySession, including a session with no rows', () => {
    seedSession('sess-1');
    seedSession('sess-2');
    insertStagedIntent(
      makeRow({ id: 'intent-a', session_id: 'sess-1', created_at: 100 }),
    );
    insertStagedIntent(
      makeRow({ id: 'intent-b', session_id: 'sess-1', created_at: 50 }),
    );
    insertStagedIntent(
      makeRow({ id: 'intent-c', session_id: 'sess-2', created_at: 10 }),
    );

    expect(listStagedIntentsBySession('sess-1').map((r) => r.id)).toEqual([
      'intent-b',
      'intent-a',
    ]);
    expect(listStagedIntentsBySession('sess-none')).toEqual([]);
  });

  it('returns byte-identical results for isSessionComplete (hasBlocked + hasActive), including a session with no rows', () => {
    seedSession('sess-active');
    seedSession('sess-blocked');
    seedSession('sess-empty');
    insertStagedIntent(
      makeRow({
        id: 'intent-active',
        session_id: 'sess-active',
        state: 'staged',
      }),
    );
    insertStagedIntent(
      makeRow({
        id: 'intent-blocked',
        session_id: 'sess-blocked',
        state: 'needs_revision',
      }),
    );

    expect(isSessionComplete('sess-active', false)).toBe(true);
    expect(isSessionComplete('sess-blocked', false)).toBe(false);
    expect(isSessionComplete('sess-empty', false)).toBe(false);
    expect(isSessionComplete('sess-none', false)).toBe(false);
  });
});
