import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeEventRow } from '../../test/helpers/eventFixtures';

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
  insertEventOrIgnore,
  getActiveSessions,
  getStuckResultSessionRows,
  insertProject,
  insertStagedIntent,
  listAllActiveStagedIntents,
  archiveSession,
  getLastActivityMsForArchivedSessions,
} from '../db/queries.js';
import type Database from 'better-sqlite3';
import type { StagedIntentRow } from '../db/types.js';

const typedDb = db as Database.Database;

const EXPECTED_INDEXES = [
  'idx_session_events_session_id_id',
  'idx_session_events_session_id_event_type',
  'idx_session_events_timestamp',
  'idx_sessions_archived_started_at',
  'idx_sessions_notion_task_id_session_type',
  'idx_sessions_status',
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
  it('creates all covering indexes on a fresh DB', () => {
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

// ── getStuckResultSessionRows — index usage and correctness ──────────────────

describe('getStuckResultSessionRows — sessions(status) index', () => {
  beforeEach(() => {
    clearTables();
    runMigrations(typedDb);
  });

  it('uses idx_sessions_status instead of a bare scan of sessions', () => {
    const plan = typedDb
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT s.session_id, s.task_id, s.task_url, s.project_context_url,
                s.project_id, s.pr_url, s.worktree_path, s.session_type,
                e.timestamp AS last_ts
         FROM sessions s
         JOIN session_events e ON e.session_id = s.session_id
         WHERE s.status = 'running'
           AND e.id = (SELECT MAX(id) FROM session_events WHERE session_id = s.session_id)
           AND e.event_type = 'system'
           AND json_extract(e.payload, '$.type') = 'result'`,
      )
      .all() as { detail: string }[];

    const scanSessionsBare = plan.some((row) =>
      /^SCAN\s+(s|sessions)\s*$/.test(row.detail.trim()),
    );
    expect(scanSessionsBare).toBe(false);
    const usesStatusIndex = plan.some((row) =>
      row.detail.includes('idx_sessions_status'),
    );
    expect(usesStatusIndex).toBe(true);
  });

  it('returns only running sessions whose last event is a system/result event', () => {
    insertSession({
      ...SESSION_DEFAULTS,
      session_id: 'stuck-running',
      task_id: 'task-stuck',
      status: 'running',
      started_at: 1000,
    });
    insertEvent({
      session_id: 'stuck-running',
      ...makeEventRow('text').live,
      timestamp: 1,
    });
    insertEvent({
      session_id: 'stuck-running',
      ...makeEventRow('result').live,
      timestamp: 2,
    });

    insertSession({
      ...SESSION_DEFAULTS,
      session_id: 'not-running',
      task_id: 'task-not-running',
      status: 'completed',
      started_at: 1000,
    });
    insertEvent({
      session_id: 'not-running',
      ...makeEventRow('result').live,
      timestamp: 1,
    });

    const rows = getStuckResultSessionRows();
    expect(rows.map((r) => r.session_id)).toEqual(['stuck-running']);
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

// ── CTE task-id predicate pushdown ────────────────────────────────────────────

describe('getActiveTaskAggregates — CTE task-id predicate pushdown', () => {
  beforeEach(() => clearTables());

  function captureSql(fn: () => void): string {
    let capturedSql = '';
    const originalPrepare = typedDb.prepare.bind(typedDb);
    const prepareSpy = vi
      .spyOn(typedDb, 'prepare')
      .mockImplementation((sql: string, ...rest: unknown[]) => {
        capturedSql = sql;
         
        return (originalPrepare as any)(sql, ...rest);
      });
    fn();
    prepareSpy.mockRestore();
    return capturedSql;
  }

  it('produces no unrestricted SCAN sessions step for a single-task-id call', () => {
    upsertTaskCache(
      'plan-task',
      JSON.stringify({ id: 'plan-task', title: 'P', status: '🗂️ Ready' }),
    );

    const sql = captureSql(() => {
      getActiveTaskAggregates(['plan-task']);
    });

    const plan = typedDb
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all('plan-task', 'plan-task', 'plan-task', 'plan-task', 'plan-task') as {
      detail: string;
    }[];
    const details = plan.map((r) => r.detail).join('\n');
    const scansUnrestrictedSessions = plan.some(
      (row) =>
        /SCAN sessions\b/.test(row.detail) &&
        !row.detail.includes('USING INDEX'),
    );
    expect(scansUnrestrictedSessions, details).toBe(false);
  });

  it('preserves the latest-per-task selection when three code sessions exist', () => {
    const tid = 'latest-task';
    upsertTaskCache(
      tid,
      JSON.stringify({ id: tid, title: 'L', status: '🗂️ Ready' }),
    );
    insertSession({
      ...SESSION_DEFAULTS,
      session_id: 'latest-sess-1',
      task_id: tid,
      started_at: 1000,
    });
    insertSession({
      ...SESSION_DEFAULTS,
      session_id: 'latest-sess-2',
      task_id: tid,
      started_at: 3000,
    });
    insertSession({
      ...SESSION_DEFAULTS,
      session_id: 'latest-sess-3',
      task_id: tid,
      started_at: 2000,
    });

    const rows = getActiveTaskAggregates([tid]);
    expect(rows).toHaveLength(1);
    expect(rows[0].code_session_id).toBe('latest-sess-2');
  });

  it('returns the same row for a single-id call and a multi-id call containing that id', () => {
    const tid = 'shared-task';
    upsertTaskCache(
      tid,
      JSON.stringify({ id: tid, title: 'S', status: '🗂️ Ready' }),
    );
    insertSession({
      ...SESSION_DEFAULTS,
      session_id: 'shared-sess',
      task_id: tid,
      started_at: 1000,
    });
    upsertPullRequest({
      ...PR_DEFAULTS,
      pr_number: 500,
      pr_url: `https://github.com/o/r/pull/500`,
      task_id: tid,
      session_id: 'shared-sess',
    });

    const otherIds = ['other-task-1', 'other-task-2'];
    for (const oid of otherIds) {
      upsertTaskCache(
        oid,
        JSON.stringify({ id: oid, title: 'O', status: '🗂️ Ready' }),
      );
      insertSession({
        ...SESSION_DEFAULTS,
        session_id: `sess-${oid}`,
        task_id: oid,
        started_at: 1000,
      });
    }

    const soloRows = getActiveTaskAggregates([tid]);
    const multiRows = getActiveTaskAggregates([tid, ...otherIds]);
    const multiRow = multiRows.find((r) => r.task_id === tid);

    expect(soloRows).toHaveLength(1);
    expect(multiRow).toEqual(soloRows[0]);
  });

  it('short-circuits an empty taskIds array without preparing a statement', () => {
    const prepareSpy = vi.spyOn(typedDb, 'prepare');
    const rows = getActiveTaskAggregates([]);
    expect(rows).toEqual([]);
    expect(prepareSpy).not.toHaveBeenCalled();
    prepareSpy.mockRestore();
  });

  it('binds parameters correctly for a multi-id call spanning code, planning, review and PR rows', () => {
    const ids = ['multi-a', 'multi-b', 'multi-c'];
    for (const [i, tid] of ids.entries()) {
      upsertTaskCache(
        tid,
        JSON.stringify({ id: tid, title: `M${i}`, status: '🗂️ Ready' }),
      );
      insertSession({
        ...SESSION_DEFAULTS,
        session_id: `${tid}-code`,
        task_id: tid,
        session_type: 'standard',
        started_at: 1000 + i,
      });
      insertSession({
        ...SESSION_DEFAULTS,
        session_id: `${tid}-planning`,
        task_id: tid,
        session_type: 'groom',
        started_at: 1000 + i,
      });
      insertSession({
        ...SESSION_DEFAULTS,
        session_id: `${tid}-review`,
        task_id: tid,
        session_type: 'review',
        started_at: 1000 + i,
      });
      upsertPullRequest({
        ...PR_DEFAULTS,
        pr_number: 900 + i,
        pr_url: `https://github.com/o/r/pull/${900 + i}`,
        task_id: tid,
        session_id: `${tid}-code`,
      });
    }

    expect(() => getActiveTaskAggregates(ids)).not.toThrow();
    const rows = getActiveTaskAggregates(ids);
    expect(rows).toHaveLength(3);
    for (const [i, tid] of ids.entries()) {
      const row = rows.find((r) => r.task_id === tid);
      expect(row?.code_session_id).toBe(`${tid}-code`);
      expect(row?.planning_session_id).toBe(`${tid}-planning`);
      expect(row?.review_session_id).toBe(`${tid}-review`);
      expect(row?.pr_number).toBe(900 + i);
    }
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
      ...makeEventRow('other').live,
      timestamp: 1,
    });
    insertEvent({
      session_id: 'sess-payload',
      ...makeEventRow('text').live,
      timestamp: 2,
    });

    const rows = getActiveTaskAggregates([tid]);
    expect(rows).toHaveLength(1);
    expect(rows[0].code_session_last_event_payload).toBe(
      makeEventRow('text').live.payload,
    );
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
      ...makeEventRow('other').live,
      timestamp: 1,
    });
    insertEvent({
      session_id: 'sess-sys',
      ...makeEventRow('user_message').live,
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
        const evType = i % 20 === 0 ? 'system' : 'text';
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
           AND event_type IN ('text', 'tool_use', 'tool_result', 'error')
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

// ── listAllActiveStagedIntents — idx_staged_intent_state_created_at ─────────

describe('listAllActiveStagedIntents — state-only predicate index usage', () => {
  function stagedIntentRow(
    overrides: Partial<StagedIntentRow> & { id: string; project_id: string },
  ): StagedIntentRow {
    return {
      kind: 'task.setStatus',
      payload: '{}',
      payload_hash: 'hash',
      task_id: null,
      session_id: null,
      group_id: null,
      milestone: null,
      state: 'staged',
      supersedes: null,
      annotation: null,
      decision_proposal: null,
      investigation: null,
      groom_proposal: null,
      advisory: null,
      disposition_reason: null,
      answer: null,
      applied_task_id: null,
      created_at: 1000,
      updated_at: 1000,
      ...overrides,
    };
  }

  it('creates idx_staged_intent_state_created_at on a fresh database', () => {
    runMigrations(typedDb);
    expect(indexNames()).toContain('idx_staged_intent_state_created_at');
  });

  it('EXPLAIN QUERY PLAN contains no full scan of staged_intent and no temp b-tree sort', () => {
    // listAllActiveStagedIntents runs this as two single-value equality
    // searches (see its doc comment) rather than one `state IN (...)`
    // query — SQLite can't serve a multi-value IN's ORDER BY from the
    // index without a temp b-tree merge, but a single equality can.
    runMigrations(typedDb);
    for (const state of ['staged', 'approved']) {
      const plan = typedDb
        .prepare(
          `EXPLAIN QUERY PLAN SELECT * FROM staged_intent WHERE state = ? ORDER BY created_at ASC`,
        )
        .all(state) as { detail: string }[];
      const details = plan.map((r) => r.detail).join('\n');
      expect(details).not.toContain('SCAN staged_intent');
      expect(details).not.toContain('USE TEMP B-TREE FOR ORDER BY');
    }
  });

  it('returns the same rows in the same order, excluding non-visible states, across projects', () => {
    runMigrations(typedDb);
    typedDb.exec(`DELETE FROM staged_intent; DELETE FROM projects;`);
    insertProject({
      id: 'proj-a',
      name: 'Project A',
      project_dir: '/a',
      context_url: null,
      github_repo: 'o/a',
      task_source: 'notion',
    });
    insertProject({
      id: 'proj-b',
      name: 'Project B',
      project_dir: '/b',
      context_url: null,
      github_repo: 'o/b',
      task_source: 'notion',
    });

    const rows: StagedIntentRow[] = [
      stagedIntentRow({
        id: 'a-staged',
        project_id: 'proj-a',
        state: 'staged',
        created_at: 3000,
      }),
      stagedIntentRow({
        id: 'b-approved',
        project_id: 'proj-b',
        state: 'approved',
        created_at: 1000,
      }),
      stagedIntentRow({
        id: 'a-approved',
        project_id: 'proj-a',
        state: 'approved',
        created_at: 2000,
      }),
      stagedIntentRow({
        id: 'b-committed',
        project_id: 'proj-b',
        state: 'committed',
        created_at: 500,
      }),
      stagedIntentRow({
        id: 'a-rejected',
        project_id: 'proj-a',
        state: 'rejected',
        created_at: 4000,
      }),
      stagedIntentRow({
        id: 'b-withdrawn',
        project_id: 'proj-b',
        state: 'withdrawn',
        created_at: 4500,
      }),
    ];
    for (const row of rows) insertStagedIntent(row);

    const result = listAllActiveStagedIntents();
    expect(result.map((r) => r.id)).toEqual([
      'b-approved',
      'a-approved',
      'a-staged',
    ]);
  });
});

// ── sessions.last_event_at denormalisation ────────────────────────────────────

describe('runMigrations — sessions.last_event_at', () => {
  beforeEach(() => {
    clearTables();
  });

  it('adds the column to a fresh database and backfills pre-existing sessions', () => {
    runMigrations(typedDb);
    insertSession({
      ...SESSION_DEFAULTS,
      session_id: 'backfill-sess-1',
      task_id: null,
      started_at: 1000,
    });
    insertSession({
      ...SESSION_DEFAULTS,
      session_id: 'backfill-sess-2',
      task_id: null,
      started_at: 1000,
    });
    typedDb
      .prepare(
        `INSERT INTO session_events (session_id, event_type, payload, timestamp) VALUES (?, ?, ?, ?)`,
      )
      .run('backfill-sess-1', 'text', '{}', 500);
    typedDb
      .prepare(
        `INSERT INTO session_events (session_id, event_type, payload, timestamp) VALUES (?, ?, ?, ?)`,
      )
      .run('backfill-sess-1', 'text', '{}', 900);
    typedDb
      .prepare(
        `INSERT INTO session_events (session_id, event_type, payload, timestamp) VALUES (?, ?, ?, ?)`,
      )
      .run('backfill-sess-2', 'text', '{}', 700);

    // Simulate rows that predate the write-path maintenance (e.g. imported
    // by a prior deploy before this column was populated at insert time).
    typedDb.exec(`UPDATE sessions SET last_event_at = NULL`);

    runMigrations(typedDb);

    const rows = typedDb
      .prepare(
        `SELECT session_id, last_event_at FROM sessions ORDER BY session_id`,
      )
      .all() as { session_id: string; last_event_at: number | null }[];
    expect(rows).toEqual([
      { session_id: 'backfill-sess-1', last_event_at: 900 },
      { session_id: 'backfill-sess-2', last_event_at: 700 },
    ]);
  });

  it('running runMigrations twice does not throw and leaves the column present', () => {
    runMigrations(typedDb);
    expect(() => runMigrations(typedDb)).not.toThrow();
    const columns = typedDb.prepare(`PRAGMA table_info(sessions)`).all() as {
      name: string;
    }[];
    expect(columns.map((c) => c.name)).toContain('last_event_at');
  });
});

describe('last_event_at write-path maintenance', () => {
  beforeEach(() => {
    clearTables();
    runMigrations(typedDb);
    insertSession({
      ...SESSION_DEFAULTS,
      session_id: 'maint-sess',
      task_id: null,
      started_at: 1000,
    });
  });

  function lastEventAt(sessionId: string): number | null {
    const row = typedDb
      .prepare(`SELECT last_event_at FROM sessions WHERE session_id = ?`)
      .get(sessionId) as { last_event_at: number | null } | undefined;
    return row?.last_event_at ?? null;
  }

  it('insertEvent bumps the owning session last_event_at', () => {
    insertEvent({
      session_id: 'maint-sess',
      ...makeEventRow('text').live,
      timestamp: 500,
    });
    expect(lastEventAt('maint-sess')).toBe(500);
  });

  it('insertEvent does not move last_event_at backwards for an out-of-order event', () => {
    insertEvent({
      session_id: 'maint-sess',
      ...makeEventRow('text').live,
      timestamp: 900,
    });
    insertEvent({
      session_id: 'maint-sess',
      ...makeEventRow('text').live,
      timestamp: 300,
    });
    expect(lastEventAt('maint-sess')).toBe(900);
  });

  it('insertEventOrIgnore bumps the owning session last_event_at for a new event', () => {
    insertEventOrIgnore({
      session_id: 'maint-sess',
      ...makeEventRow('text').live,
      timestamp: 600,
    });
    expect(lastEventAt('maint-sess')).toBe(600);
  });

  it('insertEventOrIgnore does not move last_event_at backwards for an out-of-order event', () => {
    insertEventOrIgnore({
      session_id: 'maint-sess',
      ...makeEventRow('text').live,
      timestamp: 800,
    });
    insertEventOrIgnore({
      session_id: 'maint-sess',
      ...makeEventRow('text').live,
      timestamp: 100,
    });
    expect(lastEventAt('maint-sess')).toBe(800);
  });
});

describe('getLastActivityMsForArchivedSessions — denormalised read', () => {
  beforeEach(() => {
    clearTables();
    runMigrations(typedDb);
  });

  it('matches the pre-change aggregate for archived sessions with and without events', () => {
    insertSession({
      ...SESSION_DEFAULTS,
      session_id: 'arch-with-events',
      task_id: null,
      started_at: 1000,
    });
    insertSession({
      ...SESSION_DEFAULTS,
      session_id: 'arch-no-events',
      task_id: null,
      started_at: 1000,
    });
    insertSession({
      ...SESSION_DEFAULTS,
      session_id: 'live-sess',
      task_id: null,
      started_at: 1000,
    });
    insertEvent({
      session_id: 'arch-with-events',
      ...makeEventRow('text').live,
      timestamp: 111,
    });
    insertEvent({
      session_id: 'arch-with-events',
      ...makeEventRow('text').live,
      timestamp: 222,
    });
    insertEvent({
      session_id: 'live-sess',
      ...makeEventRow('text').live,
      timestamp: 999,
    });
    archiveSession('arch-with-events');
    archiveSession('arch-no-events');

    // Pre-change aggregate, reproduced directly against session_events, for
    // comparison against the denormalised read.
    const legacyRows = typedDb
      .prepare(
        `SELECT se.session_id AS session_id, MAX(se.timestamp) AS ts
         FROM session_events se
         JOIN sessions s ON s.session_id = se.session_id
         WHERE s.archived = 1
         GROUP BY se.session_id`,
      )
      .all() as { session_id: string; ts: number }[];
    const legacyMap = new Map(legacyRows.map((r) => [r.session_id, r.ts]));

    const result = getLastActivityMsForArchivedSessions();
    expect(result).toEqual(legacyMap);
  });

  it('plan contains no reference to session_events', () => {
    const plan = typedDb
      .prepare(
        `EXPLAIN QUERY PLAN SELECT session_id, last_event_at AS ts FROM sessions WHERE archived = 1`,
      )
      .all() as { detail: string }[];
    const details = plan.map((r) => r.detail).join('\n');
    expect(details).not.toContain('session_events');
  });
});
