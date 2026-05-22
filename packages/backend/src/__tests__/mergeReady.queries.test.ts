import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── In-memory DB for query tests ────────────────────────────────────────────
vi.mock('../db/db.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id          TEXT    PRIMARY KEY,
      notion_task_id      TEXT,
      notion_task_url     TEXT,
      project_context_url TEXT,
      status              TEXT    NOT NULL,
      started_at          INTEGER NOT NULL,
      ended_at            INTEGER,
      pr_url              TEXT,
      worktree_path       TEXT,
      archived            INTEGER NOT NULL DEFAULT 0,
      project_id          TEXT,
      session_type        TEXT    NOT NULL DEFAULT 'standard',
      favorited           INTEGER NOT NULL DEFAULT 0,
      note                TEXT,
      tags                TEXT,
      task_name           TEXT,
      model               TEXT,
      total_input_tokens  INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS session_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT    NOT NULL,
      event_type   TEXT    NOT NULL,
      payload      TEXT    NOT NULL,
      timestamp    INTEGER NOT NULL,
      message_id   TEXT
    );
    CREATE TABLE IF NOT EXISTS permission_denials (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL,
      tool_use_id TEXT NOT NULL, tool_input TEXT NOT NULL, timestamp INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS permission_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL,
      proposed_action TEXT, decision TEXT NOT NULL, rule_matched TEXT, decided_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS permission_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_index INTEGER NOT NULL, pattern TEXT NOT NULL,
      match_type TEXT NOT NULL, decision TEXT NOT NULL, label TEXT, enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS task_cache (
      notion_task_id TEXT    PRIMARY KEY,
      fetched_at     INTEGER NOT NULL,
      raw_json       TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pull_requests (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number              INTEGER NOT NULL,
      pr_url                 TEXT    NOT NULL UNIQUE,
      notion_task_id         TEXT,
      session_id             TEXT,
      repo                   TEXT    NOT NULL,
      title                  TEXT,
      body                   TEXT,
      head_branch            TEXT,
      base_branch            TEXT,
      state                  TEXT    NOT NULL DEFAULT 'open',
      draft                  INTEGER NOT NULL DEFAULT 0,
      review_result          TEXT,
      review_at              TEXT,
      created_at             TEXT    NOT NULL,
      updated_at             TEXT    NOT NULL,
      synced_at              TEXT    NOT NULL,
      review_session_id      TEXT,
      review_iteration       INTEGER NOT NULL DEFAULT 0,
      head_sha               TEXT,
      last_reviewed_sha      TEXT,
      node_id                TEXT,
      mergeable              INTEGER,
      merge_state            TEXT,
      merge_state_checked_at TEXT,
      pending_push           INTEGER NOT NULL DEFAULT 0,
      pause_reason           TEXT,
      failing_checks         TEXT
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, project_dir TEXT NOT NULL,
      context_url TEXT, github_repo TEXT, task_source TEXT NOT NULL DEFAULT 'notion',
      auto_launch_enabled INTEGER NOT NULL DEFAULT 0, auto_launch_milestone_id TEXT,
      auto_merge_enabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS milestones (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
      source_id TEXT, display_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  return { db };
});

import { getMergeReadyPRs } from '../db/queries.js';
import { db } from '../db/db.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const now = '2024-01-01T00:00:00Z';
const projectId = 'proj-1';
const milestoneId = 'ms-1';
const sourceId = 'notion-board-abc';

function insertMilestone(id: string, pId: string, sId: string | null) {
  (db as import('better-sqlite3').Database)
    .prepare(
      `INSERT INTO milestones (id, project_id, name, source_id, display_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ${Date.now()}, ${Date.now()})`,
    )
    .run(id, pId, 'Test Milestone', sId);
}

function insertBoardCache(key: string, taskIds: string[]) {
  (db as import('better-sqlite3').Database)
    .prepare(
      `INSERT OR REPLACE INTO task_cache (notion_task_id, fetched_at, raw_json) VALUES (?, ?, ?)`,
    )
    .run(key, Date.now(), JSON.stringify(taskIds.map((id) => ({ id }))));
}

function insertPR(
  prNumber: number,
  notionTaskId: string | null,
  overrides: Partial<{
    state: string;
    pause_reason: string | null;
    mergeable: number | null;
    review_result: string | null;
    draft: number;
  }> = {},
) {
  const vals = {
    state: 'open',
    pause_reason: null,
    mergeable: 1,
    review_result: JSON.stringify({ verdict: 'approved', summary: 'ok' }),
    draft: 0,
    ...overrides,
  };
  (db as import('better-sqlite3').Database)
    .prepare(
      `INSERT INTO pull_requests
         (pr_number, pr_url, notion_task_id, repo, state, draft,
          review_result, mergeable, pause_reason, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, 'owner/repo', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      prNumber,
      `https://github.com/owner/repo/pull/${prNumber}`,
      notionTaskId,
      vals.state,
      vals.draft,
      vals.review_result,
      vals.mergeable,
      vals.pause_reason,
      now,
      now,
      now,
    );
}

function cleanDb() {
  (db as import('better-sqlite3').Database).exec(
    `DELETE FROM pull_requests; DELETE FROM task_cache; DELETE FROM milestones;`,
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('getMergeReadyPRs', () => {
  beforeEach(() => {
    cleanDb();
    (db as import('better-sqlite3').Database)
      .prepare(
        `INSERT OR IGNORE INTO projects (id, name, project_dir, task_source,
           auto_launch_enabled, auto_merge_enabled, created_at, updated_at)
         VALUES ('proj-1', 'Test', '/test', 'notion', 0, 0, ${Date.now()}, ${Date.now()})`,
      )
      .run();
    insertMilestone(milestoneId, projectId, sourceId);
    insertBoardCache(`board:${sourceId}`, ['task-aaa', 'task-bbb']);
  });

  it('returns eligible PRs satisfying all filters', () => {
    insertPR(10, 'task-aaa');
    const result = getMergeReadyPRs(projectId, milestoneId);
    expect(result).toHaveLength(1);
    expect(result[0].pr_number).toBe(10);
  });

  it('excludes PRs with pause_reason set', () => {
    insertPR(10, 'task-aaa', { pause_reason: 'stuck_timeout' });
    expect(getMergeReadyPRs(projectId, milestoneId)).toHaveLength(0);
  });

  it('excludes PRs with mergeable !== 1', () => {
    insertPR(10, 'task-aaa', { mergeable: 0 });
    insertPR(11, 'task-bbb', { mergeable: null });
    expect(getMergeReadyPRs(projectId, milestoneId)).toHaveLength(0);
  });

  it('excludes PRs with state !== open', () => {
    insertPR(10, 'task-aaa', { state: 'closed' });
    expect(getMergeReadyPRs(projectId, milestoneId)).toHaveLength(0);
  });

  it('excludes PRs with non-approved verdict', () => {
    insertPR(10, 'task-aaa', {
      review_result: JSON.stringify({
        verdict: 'changes_requested',
        summary: '',
      }),
    });
    expect(getMergeReadyPRs(projectId, milestoneId)).toHaveLength(0);
  });

  it('excludes PRs belonging to a different milestone', () => {
    insertPR(10, 'task-zzz');
    expect(getMergeReadyPRs(projectId, milestoneId)).toHaveLength(0);
  });

  it('includes draft PRs (no draft filter)', () => {
    insertPR(10, 'task-aaa', { draft: 1 });
    const result = getMergeReadyPRs(projectId, milestoneId);
    expect(result).toHaveLength(1);
    expect(result[0].draft).toBe(1);
  });

  it('returns empty when milestone does not exist', () => {
    expect(getMergeReadyPRs(projectId, 'non-existent-ms')).toHaveLength(0);
  });

  it('returns empty when board cache is missing', () => {
    cleanDb();
    insertMilestone(milestoneId, projectId, sourceId);
    // no board cache entry
    insertPR(10, 'task-aaa');
    expect(getMergeReadyPRs(projectId, milestoneId)).toHaveLength(0);
  });

  it('matches notion_task_id with or without hyphens', () => {
    cleanDb();
    insertMilestone(milestoneId, projectId, sourceId);
    insertBoardCache(`board:${sourceId}`, [
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    ]);
    insertPR(10, 'aaaaaaaabbbbccccddddeeeeeeeeeeee');
    expect(getMergeReadyPRs(projectId, milestoneId)).toHaveLength(1);
  });

  it('returns multiple eligible PRs', () => {
    insertPR(10, 'task-aaa');
    insertPR(11, 'task-bbb');
    expect(getMergeReadyPRs(projectId, milestoneId)).toHaveLength(2);
  });
});
