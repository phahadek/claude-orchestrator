import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── In-memory SQLite mock ─────────────────────────────────────────────────────
vi.mock('../db/db.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id          TEXT    PRIMARY KEY,
      task_id             TEXT,
      task_url            TEXT,
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
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      metadata            TEXT,
      review_result       TEXT
    );
    CREATE TABLE IF NOT EXISTS task_cache (
      task_id    TEXT    PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      raw_json   TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pull_requests (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number         INTEGER NOT NULL,
      pr_url            TEXT    NOT NULL UNIQUE,
      task_id           TEXT,
      session_id        TEXT,
      repo              TEXT    NOT NULL,
      title             TEXT,
      body              TEXT,
      head_branch       TEXT,
      base_branch       TEXT,
      state             TEXT    NOT NULL DEFAULT 'open',
      draft             INTEGER NOT NULL DEFAULT 0,
      review_result     TEXT,
      review_at         TEXT,
      created_at        TEXT    NOT NULL,
      updated_at        TEXT    NOT NULL,
      synced_at         TEXT    NOT NULL,
      review_session_id TEXT,
      review_iteration  INTEGER NOT NULL DEFAULT 0,
      head_sha          TEXT,
      last_reviewed_sha TEXT,
      node_id           TEXT,
      mergeable         INTEGER,
      merge_state       TEXT,
      merge_state_checked_at TEXT,
      pending_push      INTEGER NOT NULL DEFAULT 0,
      pause_reason      TEXT,
      failing_checks    TEXT
    );
    CREATE TABLE IF NOT EXISTS milestones (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL,
      name          TEXT NOT NULL,
      source_id     TEXT,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      project_dir  TEXT NOT NULL,
      context_url  TEXT,
      github_repo  TEXT,
      task_source  TEXT NOT NULL DEFAULT 'notion',
      auto_launch_enabled INTEGER NOT NULL DEFAULT 0,
      auto_launch_milestone_id TEXT,
      auto_merge_enabled INTEGER NOT NULL DEFAULT 0,
      git_mode     TEXT NOT NULL DEFAULT 'github',
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS permission_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL,
      proposed_action TEXT, decision TEXT NOT NULL, rule_matched TEXT, decided_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS permission_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_index INTEGER NOT NULL, pattern TEXT NOT NULL,
      match_type TEXT NOT NULL, decision TEXT NOT NULL, label TEXT, enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS permission_denials (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL,
      tool_use_id TEXT NOT NULL, tool_input TEXT NOT NULL, timestamp INTEGER NOT NULL
    );
  `);
  return { db };
});

import { parseTaskId, formatTaskId } from '../tasks/taskId.js';

// ── parseTaskId ───────────────────────────────────────────────────────────────

describe('parseTaskId', () => {
  it('parses notion: prefix', () => {
    expect(parseTaskId('notion:abc')).toEqual({
      source: 'notion',
      externalId: 'abc',
    });
  });

  it('parses yaml: prefix', () => {
    expect(parseTaskId('yaml:my-task')).toEqual({
      source: 'yaml',
      externalId: 'my-task',
    });
  });

  it('parses jira: prefix', () => {
    expect(parseTaskId('jira:PROJ-123')).toEqual({
      source: 'jira',
      externalId: 'PROJ-123',
    });
  });

  it('preserves colons inside the external ID', () => {
    const { source, externalId } = parseTaskId('notion:abc:extra');
    expect(source).toBe('notion');
    expect(externalId).toBe('abc:extra');
  });

  it('throws on input with no colon', () => {
    expect(() => parseTaskId('notaskid')).toThrow(/no colon/i);
  });

  it('throws on unknown source', () => {
    expect(() => parseTaskId('github:abc')).toThrow(/unknown task source/i);
  });

  it('throws on empty external ID', () => {
    expect(() => parseTaskId('notion:')).toThrow(/empty external ID/i);
  });
});

// ── formatTaskId ──────────────────────────────────────────────────────────────

describe('formatTaskId', () => {
  it('formats notion source', () => {
    expect(formatTaskId('notion', 'abc')).toBe('notion:abc');
  });

  it('formats yaml source', () => {
    expect(formatTaskId('yaml', 'my-task')).toBe('yaml:my-task');
  });

  it('formats jira source', () => {
    expect(formatTaskId('jira', 'PROJ-123')).toBe('jira:PROJ-123');
  });

  it('round-trips with parseTaskId', () => {
    const formatted = formatTaskId('notion', 'uuid-123');
    const parsed = parseTaskId(formatted);
    expect(parsed.source).toBe('notion');
    expect(parsed.externalId).toBe('uuid-123');
  });
});

// ── NotionTaskBackend prefix handling ─────────────────────────────────────────

vi.mock('../notion/NotionClient.js', () => ({
  NotionClient: vi.fn().mockImplementation(() => ({
    fetchReadyTasks: vi.fn().mockResolvedValue([]),
    attachPR: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    fetchTaskPage: vi.fn().mockResolvedValue({ rawMarkdown: 'page content' }),
  })),
}));

vi.mock('../projects/ProjectService.js', () => ({
  ProjectService: {
    getMilestone: vi.fn().mockReturnValue({
      id: 'ms-1',
      sourceId: 'notion-board-123',
      name: 'Test Milestone',
    }),
    getById: vi.fn(),
  },
}));

import { NotionTaskBackend } from '../tasks/NotionTaskBackend.js';
import { NotionClient } from '../notion/NotionClient.js';

describe('NotionTaskBackend prefix handling', () => {
  let client: InstanceType<typeof NotionClient>;
  let backend: NotionTaskBackend;

  beforeEach(() => {
    client = new NotionClient();
    backend = new NotionTaskBackend(client);
  });

  it('fetchReadyTasks returns ResolvedTask with source: notion and prefixed IDs', async () => {
    vi.mocked(client.fetchReadyTasks).mockResolvedValue([
      {
        task: {
          id: 'raw-id-abc',
          title: 'Test Task',
          status: '🗂️ Ready',
          type: '💻 Code',
          dependsOn: [],
          notionUrl: 'https://notion.so/raw-id-abc',
        },
        blocked: false,
        blockers: [],
        nonCode: false,
        wave: 1,
      },
    ]);

    const tasks = await backend.fetchReadyTasks('ms-1');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].source).toBe('notion');
    expect(tasks[0].task.id).toBe('notion:raw-id-abc');
  });

  it('attachPR strips notion: prefix before calling Notion API', async () => {
    await backend.attachPR(
      'notion:raw-id-abc',
      'https://github.com/owner/repo/pull/1',
    );
    expect(vi.mocked(client.attachPR)).toHaveBeenCalledWith(
      'raw-id-abc',
      'https://github.com/owner/repo/pull/1',
    );
  });

  it('updateStatus strips notion: prefix before calling Notion API', async () => {
    await backend.updateStatus('notion:raw-id-abc', '✅ Done');
    expect(vi.mocked(client.updateStatus)).toHaveBeenCalledWith(
      'raw-id-abc',
      '✅ Done',
    );
  });

  it('fetchNonMilestoneReadyTasks returns []', async () => {
    const tasks = await backend.fetchNonMilestoneReadyTasks();
    expect(tasks).toEqual([]);
  });
});

// ── LocalTaskBackend prefix handling ─────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import os from 'os';
import { LocalTaskBackend } from '../tasks/LocalTaskBackend.js';

describe('LocalTaskBackend prefix handling', () => {
  let tmpDir: string;
  let backend: LocalTaskBackend;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-task-backend-test-'));
    fs.writeFileSync(
      path.join(tmpDir, 'tasks.yaml'),
      [
        'milestones:',
        '  - id: ms-1',
        '    name: Test Milestone',
        '    tasks:',
        '      - id: task-foo',
        '        name: Foo Task',
        '        status: Ready',
        '      - id: task-bar',
        '        name: Bar Task',
        '        status: Done',
      ].join('\n'),
      'utf-8',
    );
    backend = new LocalTaskBackend(tmpDir);
  });

  it('fetchReadyTasks returns ResolvedTask with source: yaml and prefixed IDs', async () => {
    const tasks = await backend.fetchReadyTasks('ms-1');
    for (const t of tasks) {
      expect(t.source).toBe('yaml');
      expect(t.task.id.startsWith('yaml:')).toBe(true);
    }
  });

  it('attachPR strips yaml: prefix before writing to tasks.yaml', async () => {
    await backend.attachPR(
      'yaml:task-foo',
      'https://github.com/owner/repo/pull/5',
    );
    const content = fs.readFileSync(path.join(tmpDir, 'tasks.yaml'), 'utf-8');
    expect(content).toContain('pr_url:');
    expect(content).toContain('github.com/owner/repo/pull/5');
  });

  it('updateStatus strips yaml: prefix before writing to tasks.yaml', async () => {
    await backend.updateStatus('yaml:task-foo', '✅ Done');
    const content = fs.readFileSync(path.join(tmpDir, 'tasks.yaml'), 'utf-8');
    expect(content).toContain('status: Done');
  });

  it('fetchNonMilestoneReadyTasks returns []', async () => {
    const tasks = await backend.fetchNonMilestoneReadyTasks();
    expect(tasks).toEqual([]);
  });
});

// ── Schema migration idempotency ──────────────────────────────────────────────

import { db } from '../db/db.js';

describe('Schema migration — task_id column in sessions and task_cache', () => {
  it('sessions table has task_id column (not notion_task_id)', () => {
    const cols = (
      db.prepare("PRAGMA table_info('sessions')").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toContain('task_id');
    expect(cols).not.toContain('notion_task_id');
  });

  it('task_cache table has task_id column (not notion_task_id)', () => {
    const cols = (
      db.prepare("PRAGMA table_info('task_cache')").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toContain('task_id');
    expect(cols).not.toContain('notion_task_id');
  });

  it('backfill is idempotent — running twice does not double-prefix', () => {
    db.exec(`INSERT OR IGNORE INTO projects (id, name, project_dir, task_source, created_at, updated_at)
      VALUES ('p1', 'Test', '/tmp', 'notion', 1, 1)`);
    db.exec(`INSERT OR IGNORE INTO sessions (session_id, task_id, status, started_at, project_id)
      VALUES ('idem-sess-1', 'notion:already-prefixed', 'done', 1, 'p1')`);

    // Simulate backfill SQL running twice
    const backfillNotionSql = `
      UPDATE sessions SET task_id = 'notion:' || task_id
      WHERE task_id IS NOT NULL AND task_id NOT LIKE '%:%'
      AND (project_id IS NULL OR project_id IN (SELECT id FROM projects WHERE task_source = 'notion'))
    `;
    db.exec(backfillNotionSql);
    db.exec(backfillNotionSql);

    const row = db
      .prepare("SELECT task_id FROM sessions WHERE session_id = 'idem-sess-1'")
      .get() as { task_id: string };
    expect(row.task_id).toBe('notion:already-prefixed');
  });
});

// ── pull_requests migration acceptance criteria ───────────────────────────────

import {
  upsertPullRequest,
  getPRByNumber,
  getPRByTaskId,
  getPausedPrReasonForTask,
  setPauseReason,
} from '../db/queries.js';

describe('Schema migration — task_id column in pull_requests', () => {
  const TEST_PR_URL = 'https://github.com/owner/repo/pull/9001';
  const TEST_REPO = 'owner/repo';
  const TEST_PR_NUMBER = 9001;
  const TEST_TASK_ID = 'notion:test-task-abc';

  beforeEach(() => {
    upsertPullRequest({
      pr_number: TEST_PR_NUMBER,
      pr_url: TEST_PR_URL,
      task_id: TEST_TASK_ID,
      session_id: null,
      repo: TEST_REPO,
      title: 'Test PR',
      body: null,
      head_branch: 'feature/test',
      base_branch: 'dev',
      state: 'open',
      draft: 0,
      review_result: null,
      review_at: null,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      synced_at: '2024-01-01T00:00:00Z',
      head_sha: null,
    });
  });

  it('pull_requests table has task_id column (not notion_task_id)', () => {
    const cols = (
      db.prepare("PRAGMA table_info('pull_requests')").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toContain('task_id');
    expect(cols).not.toContain('notion_task_id');
  });

  it('upsertPullRequest round-trips task_id through getPRByNumber', () => {
    const row = getPRByNumber(TEST_PR_NUMBER, TEST_REPO);
    expect(row).not.toBeNull();
    expect(row?.task_id).toBe(TEST_TASK_ID);
  });

  it('getPRByTaskId returns the row written with task_id = "notion:test-task-abc"', () => {
    const row = getPRByTaskId(TEST_TASK_ID);
    expect(row).not.toBeNull();
    expect(row?.pr_number).toBe(TEST_PR_NUMBER);
    expect(row?.task_id).toBe(TEST_TASK_ID);
  });

  it('getPausedPrReasonForTask returns the pause reason of the matching PR', () => {
    setPauseReason(TEST_PR_NUMBER, TEST_REPO, 'max_reviews');
    const reason = getPausedPrReasonForTask(TEST_TASK_ID);
    expect(reason).toBe('max_reviews');
  });
});

// ── pull_requests backfill migration ─────────────────────────────────────────

const backfillDeleteSql = `
  DELETE FROM pull_requests
  WHERE task_id IS NOT NULL AND task_id NOT LIKE '%:%'
    AND EXISTS (
      SELECT 1 FROM pull_requests pr2
      WHERE pr2.task_id = 'notion:' || pull_requests.task_id
        AND pr2.pr_url != pull_requests.pr_url
    )
`;
const backfillUpdateSql = `
  UPDATE pull_requests SET task_id = 'notion:' || task_id
  WHERE task_id IS NOT NULL AND task_id NOT LIKE '%:%'
`;

describe('pull_requests backfill migration', () => {
  beforeEach(() => {
    // Clean up rows inserted by previous tests in this block
    db.exec(
      `DELETE FROM pull_requests WHERE pr_number >= 8000 AND pr_number < 9000`,
    );
  });

  it('backfill prefixes all unprefixed task_id rows with notion:', () => {
    db.exec(`
      INSERT INTO pull_requests (pr_number, pr_url, task_id, repo, state, created_at, updated_at, synced_at)
      VALUES
        (8001, 'https://github.com/o/r/pull/8001', 'raw-uuid-aaa', 'o/r', 'open', '2024-01-01', '2024-01-01', '2024-01-01'),
        (8002, 'https://github.com/o/r/pull/8002', 'raw-uuid-bbb', 'o/r', 'open', '2024-01-01', '2024-01-01', '2024-01-01'),
        (8003, 'https://github.com/o/r/pull/8003', NULL,           'o/r', 'open', '2024-01-01', '2024-01-01', '2024-01-01')
    `);
    db.exec(backfillDeleteSql);
    db.exec(backfillUpdateSql);

    const rows = db
      .prepare(
        `SELECT task_id FROM pull_requests WHERE pr_number IN (8001, 8002, 8003)`,
      )
      .all() as Array<{ task_id: string | null }>;

    for (const row of rows) {
      if (row.task_id !== null) {
        expect(row.task_id).toMatch(/^.+:.+/);
      }
    }
    const prefixed = rows.filter((r) => r.task_id !== null);
    expect(prefixed).toHaveLength(2);
    expect(prefixed.map((r) => r.task_id)).toContain('notion:raw-uuid-aaa');
    expect(prefixed.map((r) => r.task_id)).toContain('notion:raw-uuid-bbb');
  });

  it('backfill is idempotent — running twice does not double-prefix', () => {
    db.exec(`
      INSERT INTO pull_requests (pr_number, pr_url, task_id, repo, state, created_at, updated_at, synced_at)
      VALUES (8010, 'https://github.com/o/r/pull/8010', 'raw-idem-123', 'o/r', 'open', '2024-01-01', '2024-01-01', '2024-01-01')
    `);
    db.exec(backfillDeleteSql);
    db.exec(backfillUpdateSql);
    db.exec(backfillDeleteSql);
    db.exec(backfillUpdateSql);

    const row = db
      .prepare(`SELECT task_id FROM pull_requests WHERE pr_number = 8010`)
      .get() as { task_id: string };
    expect(row.task_id).toBe('notion:raw-idem-123');
  });

  it('collision-safe: raw row deleted when prefixed twin already exists', () => {
    db.exec(`
      INSERT INTO pull_requests (pr_number, pr_url, task_id, repo, state, created_at, updated_at, synced_at)
      VALUES
        (8020, 'https://github.com/o/r/pull/8020', 'collision-abc', 'o/r', 'open', '2024-01-01', '2024-01-01', '2024-01-01'),
        (8021, 'https://github.com/o/r/pull/8021', 'notion:collision-abc', 'o/r', 'open', '2024-01-01', '2024-01-01', '2024-01-01')
    `);
    // Should not throw a UNIQUE constraint violation
    expect(() => {
      db.exec(backfillDeleteSql);
      db.exec(backfillUpdateSql);
    }).not.toThrow();

    const rows = db
      .prepare(
        `SELECT pr_number, task_id FROM pull_requests WHERE pr_number IN (8020, 8021)`,
      )
      .all() as Array<{ pr_number: number; task_id: string }>;

    // Raw row 8020 should have been deleted, prefixed twin 8021 survives
    expect(rows.map((r) => r.pr_number)).not.toContain(8020);
    expect(rows.map((r) => r.pr_number)).toContain(8021);
    expect(rows.find((r) => r.pr_number === 8021)?.task_id).toBe(
      'notion:collision-abc',
    );
  });

  it('after backfill, every non-null pull_requests.task_id matches LIKE "%:%"', () => {
    db.exec(`
      INSERT INTO pull_requests (pr_number, pr_url, task_id, repo, state, created_at, updated_at, synced_at)
      VALUES
        (8030, 'https://github.com/o/r/pull/8030', 'no-prefix-here', 'o/r', 'open', '2024-01-01', '2024-01-01', '2024-01-01'),
        (8031, 'https://github.com/o/r/pull/8031', 'notion:already-fine', 'o/r', 'open', '2024-01-01', '2024-01-01', '2024-01-01'),
        (8032, 'https://github.com/o/r/pull/8032', NULL, 'o/r', 'open', '2024-01-01', '2024-01-01', '2024-01-01')
    `);
    db.exec(backfillDeleteSql);
    db.exec(backfillUpdateSql);

    const nonNullRows = db
      .prepare(`SELECT task_id FROM pull_requests WHERE task_id IS NOT NULL`)
      .all() as Array<{ task_id: string }>;

    for (const row of nonNullRows) {
      expect(row.task_id).toMatch(/^[^:]+:.+/);
    }
  });
});
