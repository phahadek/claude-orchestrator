import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── In-memory SQLite (tables required by module-level db.prepare() in queries.ts) ──
vi.mock('../db/db.js', async () => {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id          TEXT    PRIMARY KEY,
      task_id             TEXT,
      task_url            TEXT,
      project_context_url TEXT,
      status              TEXT    NOT NULL DEFAULT 'running',
      started_at          INTEGER NOT NULL DEFAULT 0,
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
      review_result       TEXT,
      metadata            TEXT
    );
    CREATE TABLE IF NOT EXISTS session_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT    NOT NULL,
      event_type   TEXT    NOT NULL,
      payload      TEXT    NOT NULL,
      timestamp    INTEGER NOT NULL,
      message_id   TEXT
    );
    CREATE TABLE IF NOT EXISTS permission_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT    NOT NULL,
      tool_name       TEXT    NOT NULL,
      proposed_action TEXT,
      decision        TEXT    NOT NULL,
      rule_matched    TEXT,
      decided_at      INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS permission_rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      order_index INTEGER NOT NULL,
      pattern     TEXT    NOT NULL,
      match_type  TEXT    NOT NULL,
      decision    TEXT    NOT NULL,
      label       TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS permission_denials (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT    NOT NULL,
      tool_name   TEXT    NOT NULL,
      tool_use_id TEXT    NOT NULL,
      tool_input  TEXT    NOT NULL,
      timestamp   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_cache (
      task_id    TEXT    PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      raw_json   TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id          TEXT    PRIMARY KEY,
      name        TEXT    NOT NULL,
      user_agent  TEXT,
      last_ip     TEXT,
      last_seen   INTEGER,
      enrolled_at INTEGER NOT NULL,
      token       TEXT    NOT NULL UNIQUE,
      revoked     INTEGER NOT NULL DEFAULT 0
    );
  `);
  return { db };
});

vi.mock('../config.js', () => ({
  config: { notionApiKey: 'test-key', port: 3000 },
}));

vi.mock('../projects/ProjectService.js', () => ({
  ProjectService: {
    getMilestone: vi.fn(),
  },
}));

import { getTaskCache, upsertTaskCache } from '../db/queries.js';
import { NotionClient } from '../notion/NotionClient.js';
import { NotionTaskBackend } from '../tasks/NotionTaskBackend.js';
import { ProjectService } from '../projects/ProjectService.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BOARD_ID = 'aabbccdd-1122-3344-5566-778899aabbcc';
const TASK_1 = '11111111-1111-1111-1111-111111111111';
const TASK_2 = '22222222-2222-2222-2222-222222222222';
const TASK_3 = '33333333-3333-3333-3333-333333333333';

function makeNotionQueryResponse(taskIds: string[]) {
  return {
    results: taskIds.map((id) => ({
      id,
      url: `https://notion.so/${id}`,
      properties: {
        'Task Name': {
          type: 'title',
          title: [{ text: { content: `Task ${id.slice(0, 4)}` } }],
        },
        Status: { type: 'select', select: { name: '🗂️ Ready' } },
        Type: { type: 'select', select: { name: '💻 Code' } },
        'Depends On': { type: 'rich_text', rich_text: [] },
        Notes: { type: 'rich_text', rich_text: [] },
      },
    })),
    has_more: false,
    next_cursor: null,
  };
}

function makeNotionPageResponse(id: string) {
  return {
    id,
    url: `https://notion.so/${id}`,
    properties: {
      'Task Name': {
        type: 'title',
        title: [{ text: { content: 'Test Task' } }],
      },
      Status: { type: 'select', select: { name: '🗂️ Ready' } },
      Type: { type: 'select', select: { name: '💻 Code' } },
      'Depends On': { type: 'rich_text', rich_text: [] },
      Notes: { type: 'rich_text', rich_text: [] },
      'Expected size': { type: 'number', number: null },
    },
  };
}

beforeEach(async () => {
  const { db } = await import('../db/db.js');
  db.prepare('DELETE FROM task_cache').run();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ─── getTaskCache: exact-match only, no dashless/dashed fallback ──────────────

describe('getTaskCache — no UUID format fallback', () => {
  it('returns the row for an exact prefixed key match', () => {
    upsertTaskCache('notion:abc', '{"id":"notion:abc"}');
    const row = getTaskCache('notion:abc');
    expect(row).toBeDefined();
    expect(row!.task_id).toBe('notion:abc');
  });

  it('returns undefined for a raw (unprefixed) key when only the prefixed row exists', () => {
    upsertTaskCache('notion:abc', '{"id":"notion:abc"}');
    expect(getTaskCache('abc')).toBeUndefined();
  });

  it('returns undefined for a dashed UUID when the dashless UUID is stored (no format normalization)', () => {
    const dashless = 'abcdef1234567890abcdef1234567890';
    upsertTaskCache(`notion:${dashless}`, '{}');
    const dashed = 'abcdef12-3456-7890-abcd-ef1234567890';
    expect(getTaskCache(dashed)).toBeUndefined();
  });
});

// ─── NotionTaskBackend.fetchReadyTasks: cache write shape ─────────────────────

describe('NotionTaskBackend.fetchReadyTasks — task_cache write shape', () => {
  it('writes exactly 4 rows: 3 notion:<id> + 1 board:<id>, no raw-UUID rows', async () => {
    vi.mocked(ProjectService.getMilestone).mockReturnValue({
      id: 'milestone-1',
      projectId: 'proj-1',
      name: 'M1',
      sourceId: BOARD_ID,
      displayOrder: 0,
      createdAt: 0,
      updatedAt: 0,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => makeNotionQueryResponse([TASK_1, TASK_2, TASK_3]),
      }),
    );

    const backend = new NotionTaskBackend(new NotionClient());
    await backend.fetchReadyTasks('milestone-1');

    const { db } = await import('../db/db.js');
    const rows = db
      .prepare('SELECT task_id FROM task_cache ORDER BY task_id')
      .all() as { task_id: string }[];

    expect(rows).toHaveLength(4);

    const keys = rows.map((r) => r.task_id);
    expect(keys).toContain(`board:${BOARD_ID}`);
    expect(keys).toContain(`notion:${TASK_1}`);
    expect(keys).toContain(`notion:${TASK_2}`);
    expect(keys).toContain(`notion:${TASK_3}`);

    // No raw UUID keys (dashed or dashless)
    const rawDashedRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const rawDashlessRe = /^[0-9a-f]{32}$/i;
    expect(keys.filter((k) => rawDashedRe.test(k))).toHaveLength(0);
    expect(keys.filter((k) => rawDashlessRe.test(k))).toHaveLength(0);
  });
});

// ─── NotionClient.fetchTaskPage: cache key includes source prefix ─────────────

describe('NotionClient.fetchTaskPage — cache key shape', () => {
  it('writes a row keyed task:notion:<taskId>, not task:<taskId>', async () => {
    const taskId = TASK_1;

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => makeNotionPageResponse(taskId),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [],
            has_more: false,
            next_cursor: null,
          }),
        }),
    );

    const client = new NotionClient();
    await client.fetchTaskPage(taskId);

    const row = getTaskCache(`task:notion:${taskId}`);
    expect(row).toBeDefined();
    expect(row!.task_id).toBe(`task:notion:${taskId}`);

    // Old shape must not exist
    expect(getTaskCache(`task:${taskId}`)).toBeUndefined();
  });
});
