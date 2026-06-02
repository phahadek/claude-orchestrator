import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── In-memory SQLite — schema must be applied inside the factory ───────────────
// queries.ts creates prepared statements at module load, so the tables must
// exist before the module is imported.

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  const db = setupTestDb();
  db.prepare(
    `INSERT INTO projects (id, name, project_dir, github_repo, task_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('proj-1', 'Test Project', '/test', 'o/r', 'notion', 1000, 1000);
  return { db };
});

import { db } from '../db/db.js';
import { runMigrations } from '../db/schema.js';
import {
  getActiveTaskAggregates,
  upsertTaskCache,
  insertSession,
  upsertPullRequest,
  insertEvent,
  getActiveSessions,
} from '../db/queries.js';
import type Database from 'better-sqlite3';

const typedDb = db as Database.Database;

const EXPECTED_INDEXES = [
  'idx_session_events_session_id_id',
  'idx_session_events_session_id_event_type',
  'idx_session_events_timestamp',
  'idx_sessions_archived_started_at',
  'idx_sessions_notion_task_id_session_type',
  'idx_pull_requests_task_id_pr_number',
];

function indexNames(): string[] {
  return (
    typedDb
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function clearTables(): void {
  typedDb.exec(`
    DELETE FROM session_events;
    DELETE FROM sessions;
    DELETE FROM task_cache;
    DELETE FROM pull_requests;
  `);
}

const PR_DEFAULTS = {
  repo: 'o/r',
  title: 'PR',
  body: null,
  head_branch: 'feature/x',
  base_branch: 'dev',
  state: 'open' as const,
  draft: 0,
  review_result: null,
  review_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  synced_at: '2024-01-01T00:00:00Z',
  review_iteration: 0,
  review_session_id: null,
  head_sha: null,
  last_reviewed_sha: null,
  node_id: null,
};

const SESSION_DEFAULTS = {
  task_url: null,
  project_context_url: null,
  project_id: null,
  status: 'running',
  ended_at: null,
  pr_url: null,
  worktree_path: null,
  session_type: 'standard',
  task_name: null,
};

// ── Migration idempotency ─────────────────────────────────────────────────────

describe('runMigrations — index idempotency', () => {
  it('creates all six covering indexes on a fresh DB', () => {
    runMigrations(typedDb);
    const names = indexNames();
    for (const idx of EXPECTED_INDEXES) {
      expect(names, `missing index ${idx}`).toContain(idx);
    }
  });

  it('is safe to run twice on the same DB (idempotent)', () => {
    runMigrations(typedDb);
    expect(() => runMigrations(typedDb)).not.toThrow();
    const names = indexNames();
    for (const idx of EXPECTED_INDEXES) {
      expect(names).toContain(idx);
    }
  });
});

// ── Single prepared-statement execution ───────────────────────────────────────

describe('getActiveTaskAggregates — single statement execution', () => {
  beforeEach(() => clearTables());

  it('calls db.prepare exactly once regardless of task count', () => {
    const taskIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const tid = `task-${i.toString().padStart(3, '0')}`;
      taskIds.push(tid);
      upsertTaskCache(
        tid,
        JSON.stringify({ id: tid, title: `Task ${i}`, status: '🗂️ Ready' }),
      );
    }

    const prepareSpy = vi.spyOn(typedDb, 'prepare');
    getActiveTaskAggregates(taskIds);
    expect(prepareSpy).toHaveBeenCalledTimes(1);
    prepareSpy.mockRestore();
  });

  it('calls db.prepare exactly once with 1 task', () => {
    upsertTaskCache(
      't1',
      JSON.stringify({ id: 't1', title: 'T1', status: '🗂️ Ready' }),
    );
    const prepareSpy = vi.spyOn(typedDb, 'prepare');
    getActiveTaskAggregates(['t1']);
    expect(prepareSpy).toHaveBeenCalledTimes(1);
    prepareSpy.mockRestore();
  });
});

// ── Output shape regression guard ─────────────────────────────────────────────

describe('getActiveTaskAggregates — output shape regression guard', () => {
  beforeEach(() => clearTables());

  it('returns all expected fields for 20 tasks', () => {
    const taskIds: string[] = [];

    for (let i = 0; i < 20; i++) {
      const tid = `shape-task-${i}`;
      taskIds.push(tid);
      upsertTaskCache(
        tid,
        JSON.stringify({ id: tid, title: `Task ${i}`, status: '🗂️ Ready' }),
      );

      insertSession({
        ...SESSION_DEFAULTS,
        session_id: `shape-sess-${i}`,
        task_id: tid,
        started_at: 1000 + i,
      });

      upsertPullRequest({
        ...PR_DEFAULTS,
        pr_number: 100 + i,
        pr_url: `https://github.com/o/r/pull/${100 + i}`,
        task_id: tid,
        session_id: `shape-sess-${i}`,
      });
    }

    const rows = getActiveTaskAggregates(taskIds);
    expect(rows).toHaveLength(20);

    const expectedKeys: string[] = [
      'task_id',
      'raw_json',
      'code_session_id',
      'code_session_status',
      'code_session_started_at',
      'code_session_ended_at',
      'code_session_input_tokens',
      'code_session_output_tokens',
      'code_session_last_event_payload',
      'review_session_id',
      'review_session_status',
      'review_session_input_tokens',
      'review_session_output_tokens',
      'review_session_result',
      'pr_number',
      'pr_url',
      'pr_title',
      'pr_head_branch',
      'pr_base_branch',
      'pr_state',
      'pr_draft',
      'pr_review_result',
      'pr_review_iteration',
      'pr_merge_state',
      'pr_pause_reason',
    ];

    for (const row of rows) {
      for (const key of expectedKeys) {
        expect(Object.keys(row), `row missing key ${key}`).toContain(key);
      }
    }
  });

  it('returns code_session_last_event_payload from session_events', () => {
    const tid = 'payload-task';
    upsertTaskCache(
      tid,
      JSON.stringify({ id: tid, title: 'P', status: '🔄 In Progress' }),
    );
    insertSession({
      ...SESSION_DEFAULTS,
      session_id: 'sess-payload',
      task_id: tid,
      started_at: 1000,
    });
    insertEvent({
      session_id: 'sess-payload',
      event_type: 'system',
      payload: '{"sys":true}',
      timestamp: 1,
    });
    insertEvent({
      session_id: 'sess-payload',
      event_type: 'assistant',
      payload: '{"text":"hello"}',
      timestamp: 2,
    });

    const rows = getActiveTaskAggregates([tid]);
    expect(rows).toHaveLength(1);
    expect(rows[0].code_session_last_event_payload).toBe('{"text":"hello"}');
  });

  it('returns null code_session_last_event_payload when session has only system/user events', () => {
    const tid = 'sys-only-task';
    upsertTaskCache(
      tid,
      JSON.stringify({ id: tid, title: 'S', status: '🔄 In Progress' }),
    );
    insertSession({
      ...SESSION_DEFAULTS,
      session_id: 'sess-sys',
      task_id: tid,
      started_at: 1000,
    });
    insertEvent({
      session_id: 'sess-sys',
      event_type: 'system',
      payload: '{}',
      timestamp: 1,
    });
    insertEvent({
      session_id: 'sess-sys',
      event_type: 'user_message',
      payload: '{}',
      timestamp: 2,
    });

    const rows = getActiveTaskAggregates([tid]);
    expect(rows[0].code_session_last_event_payload).toBeNull();
  });
});

// ── Bench: getActiveTaskAggregates ────────────────────────────────────────────

describe('bench: getActiveTaskAggregates', () => {
  it('completes in <100 ms on 100k events + 50 sessions + 30 tasks', () => {
    clearTables();
    runMigrations(typedDb); // ensure indexes are present for the bench

    const TASK_COUNT = 30;
    const SESSION_COUNT = 50;
    const EVENT_COUNT = 100_000;

    const taskIds: string[] = [];
    for (let i = 0; i < TASK_COUNT; i++) {
      const tid = `bench-task-${i}`;
      taskIds.push(tid);
      upsertTaskCache(
        tid,
        JSON.stringify({ id: tid, title: `BT${i}`, status: '🔄 In Progress' }),
      );
    }

    const sessionIds: string[] = [];
    for (let i = 0; i < SESSION_COUNT; i++) {
      const sid = `bench-sess-${i}`;
      const tid = taskIds[i % TASK_COUNT];
      sessionIds.push(sid);
      insertSession({
        ...SESSION_DEFAULTS,
        session_id: sid,
        task_id: tid,
        project_id: 'proj-bench',
        started_at: 1000 + i * 10,
      });
      upsertPullRequest({
        ...PR_DEFAULTS,
        pr_number: 200 + i,
        pr_url: `https://github.com/o/r/pull/${200 + i}`,
        task_id: tid,
        session_id: sid,
      });
    }

    const insertStmt = typedDb.prepare(
      `INSERT INTO session_events (session_id, event_type, payload, timestamp) VALUES (?, ?, ?, ?)`,
    );
    const bulkInsert = typedDb.transaction(() => {
      for (let i = 0; i < EVENT_COUNT; i++) {
        const sid = sessionIds[i % SESSION_COUNT];
        const evType = i % 20 === 0 ? 'system' : 'assistant';
        insertStmt.run(sid, evType, `{"i":${i}}`, i);
      }
    });
    bulkInsert();

    const start = performance.now();
    const rows = getActiveTaskAggregates(taskIds);
    const elapsed = performance.now() - start;

    expect(rows).toHaveLength(TASK_COUNT);
    expect(
      elapsed,
      `getActiveTaskAggregates took ${elapsed.toFixed(1)}ms, expected <100ms`,
    ).toBeLessThan(100);
  });
});

// ── Query-plan regression: getActiveTaskAggregates uses expected indexes ───────

describe('query-plan regression: getActiveTaskAggregates', () => {
  it('planner uses idx_sessions_notion_task_id_session_type and idx_pull_requests_task_id_pr_number', () => {
    runMigrations(typedDb);
    // Direct SQL matching the body of getActiveTaskAggregates with one placeholder.
    // If SUBSTR/INSTR wrappers are re-introduced, these indexes become unusable and
    // the planner falls back to full-table scans — causing this assertion to fail.
    const sql = `
      WITH
        ranked_code AS (
          SELECT *,
            ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY started_at DESC) AS rn
          FROM sessions
          WHERE session_type = 'standard' OR session_type IS NULL
        ),
        ranked_review AS (
          SELECT *,
            ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY started_at DESC) AS rn
          FROM sessions
          WHERE session_type = 'review'
        ),
        ranked_pr AS (
          SELECT *,
            ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY pr_number DESC) AS rn
          FROM pull_requests
        )
      SELECT
        tc.task_id, tc.raw_json,
        cs.session_id AS code_session_id, cs.status AS code_session_status,
        cs.started_at AS code_session_started_at, cs.ended_at AS code_session_ended_at,
        cs.total_input_tokens AS code_session_input_tokens,
        cs.total_output_tokens AS code_session_output_tokens,
        (SELECT payload FROM session_events
         WHERE session_id = cs.session_id
           AND event_type NOT IN ('system', 'user_message')
         ORDER BY id DESC LIMIT 1) AS code_session_last_event_payload,
        rs.session_id AS review_session_id, rs.status AS review_session_status,
        rs.total_input_tokens AS review_session_input_tokens,
        rs.total_output_tokens AS review_session_output_tokens,
        rs.review_result AS review_session_result,
        pr.pr_number, pr.pr_url, pr.title AS pr_title,
        pr.head_branch AS pr_head_branch, pr.base_branch AS pr_base_branch,
        pr.state AS pr_state, pr.draft AS pr_draft,
        pr.review_result AS pr_review_result, pr.review_iteration AS pr_review_iteration,
        pr.merge_state AS pr_merge_state, pr.pause_reason AS pr_pause_reason
      FROM task_cache tc
      LEFT JOIN ranked_code cs ON cs.task_id = tc.task_id AND cs.rn = 1
      LEFT JOIN ranked_review rs ON rs.task_id = tc.task_id AND rs.rn = 1
      LEFT JOIN ranked_pr pr ON pr.task_id = tc.task_id AND pr.rn = 1
      WHERE tc.task_id IN (?)
      ORDER BY tc.fetched_at DESC
    `;
    const plan = typedDb
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all('notion:test-1') as {
      id: number;
      parent: number;
      notused: number;
      detail: string;
    }[];
    const details = plan.map((r) => r.detail).join('\n');
    expect(details).toContain('idx_sessions_notion_task_id_session_type');
    expect(details).toContain('idx_pull_requests_task_id_pr_number');
  });
});

// ── Bench: getActiveSessions ──────────────────────────────────────────────────

describe('bench: getActiveSessions (sessions route query)', () => {
  it('completes in <300 ms on the load fixture', () => {
    // Data from the previous bench describe is present in the shared in-memory DB.
    const start = performance.now();
    const sessions = getActiveSessions();
    const elapsed = performance.now() - start;

    expect(sessions.length).toBeGreaterThan(0);
    expect(
      elapsed,
      `getActiveSessions took ${elapsed.toFixed(1)}ms, expected <300ms`,
    ).toBeLessThan(300);
  });
});
