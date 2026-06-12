import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── In-memory SQLite (tables required by module-level db.prepare() in queries.ts) ──
vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../config.js', () => ({
  config: { notionApiKey: 'test-key', port: 3000 },
}));

vi.mock('../projects/ProjectService.js', () => ({
  ProjectService: {
    getMilestone: vi.fn(),
  },
}));

import os from 'os';
import fs from 'fs';
import path from 'path';
import { getTaskCache, upsertTaskCache } from '../db/queries.js';
import { NotionClient } from '../notion/NotionClient.js';
import { NotionTaskBackend } from '../tasks/NotionTaskBackend.js';
import { LocalTaskBackend } from '../tasks/LocalTaskBackend.js';
import { JiraTaskSourceProvider } from '../tasks/JiraTaskSourceProvider.js';
import type { JiraClient } from '../tasks/JiraClient.js';
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

// ─── NotionTaskBackend.fetchReadyTasks: board cache JSON has prefixed IDs ────────

describe('NotionTaskBackend.fetchReadyTasks — board cache JSON content', () => {
  it('board cache JSON contains prefixed notion:<uuid> IDs, not raw UUIDs', async () => {
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

    const boardRow = getTaskCache(`board:${BOARD_ID}`);
    expect(boardRow).toBeDefined();
    const tasks = JSON.parse(boardRow!.raw_json) as { id: string }[];
    expect(tasks).toHaveLength(3);
    expect(tasks.every((t) => t.id.startsWith('notion:'))).toBe(true);
    expect(tasks.map((t) => t.id)).toContain(`notion:${TASK_1}`);
    expect(tasks.map((t) => t.id)).toContain(`notion:${TASK_2}`);
    expect(tasks.map((t) => t.id)).toContain(`notion:${TASK_3}`);
  });
});

// ─── LocalTaskBackend.fetchReadyTasks: board cache JSON has prefixed IDs ─────────

describe('LocalTaskBackend.fetchReadyTasks — board cache JSON content', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-task-test-'));
    fs.writeFileSync(
      path.join(tmpDir, 'tasks.yaml'),
      [
        'milestones:',
        '  - id: m1',
        '    name: M1',
        '    tasks:',
        '      - id: task-alpha',
        '        name: Task Alpha',
        '        status: Ready',
        '      - id: task-beta',
        '        name: Task Beta',
        '        status: Ready',
      ].join('\n'),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('board cache JSON contains prefixed yaml:<id> IDs, not raw IDs', async () => {
    const backend = new LocalTaskBackend(tmpDir);
    await backend.fetchReadyTasks('m1');

    const boardRow = getTaskCache('board:m1');
    expect(boardRow).toBeDefined();
    const tasks = JSON.parse(boardRow!.raw_json) as { id: string }[];
    expect(tasks.every((t) => t.id.startsWith('yaml:'))).toBe(true);
    expect(tasks.map((t) => t.id)).toContain('yaml:task-alpha');
    expect(tasks.map((t) => t.id)).toContain('yaml:task-beta');
  });
});

// ─── JiraTaskSourceProvider.fetchReadyTasks: board cache JSON has prefixed IDs ───

describe('JiraTaskSourceProvider.fetchReadyTasks — board cache JSON content', () => {
  it('board cache JSON contains prefixed jira:<key> IDs, not raw keys', async () => {
    const mockClient = {
      searchIssues: vi.fn().mockResolvedValue([
        {
          key: 'PROJ-1',
          fields: {
            summary: 'Task 1',
            status: { name: 'To Do' },
            issuetype: { name: 'Task' },
            priority: null,
          },
        },
        {
          key: 'PROJ-2',
          fields: {
            summary: 'Task 2',
            status: { name: 'To Do' },
            issuetype: { name: 'Task' },
            priority: null,
          },
        },
      ]),
      buildReadyJql: vi
        .fn()
        .mockReturnValue('project = PROJ AND status in ("To Do")'),
    } as unknown as JiraClient;

    const provider = new JiraTaskSourceProvider(mockClient, {
      host: 'https://jira.example.com',
      project_key: 'PROJ',
    });
    await provider.fetchReadyTasks('m1');

    const boardRow = getTaskCache('board:m1');
    expect(boardRow).toBeDefined();
    const tasks = JSON.parse(boardRow!.raw_json) as { id: string }[];
    expect(tasks.every((t) => t.id.startsWith('jira:'))).toBe(true);
    expect(tasks.map((t) => t.id)).toContain('jira:PROJ-1');
    expect(tasks.map((t) => t.id)).toContain('jira:PROJ-2');
  });
});

// ─── NotionTaskBackend.fetchReadyTasks: no double-prefix on cache-hit (regression) ──

describe('NotionTaskBackend.fetchReadyTasks — no double-prefix on cache-hit', () => {
  it('second call (cache-hit) returns same single-prefixed IDs as first call (cache-miss)', async () => {
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

    // First call: cache miss — fetches from Notion API, writes board cache with prefixed IDs
    const firstResult = await backend.fetchReadyTasks('milestone-1');
    const firstIds = firstResult.map((r) => r.task.id).sort();

    // Second call: board cache is fresh (just written), NotionClient uses cache-hit path
    const secondResult = await backend.fetchReadyTasks('milestone-1');
    const secondIds = secondResult.map((r) => r.task.id).sort();

    // IDs must be identical and exactly single-prefixed (no notion:notion: amplification)
    expect(secondIds).toEqual(firstIds);
    expect(firstIds.every((id) => id.startsWith('notion:'))).toBe(true);
    expect(firstIds.every((id) => !id.startsWith('notion:notion:'))).toBe(true);
    expect(secondIds.every((id) => !id.startsWith('notion:notion:'))).toBe(
      true,
    );
  });
});

// ─── NotionClient.fetchTaskPage: cache key includes source prefix ─────────────

describe('NotionClient.fetchTaskPage — cache key shape', () => {
  it('writes a row keyed task:notion:<raw-uuid>, not task:<raw-uuid>', async () => {
    const taskId = `notion:${TASK_1}`;

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => makeNotionPageResponse(TASK_1),
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

    // Cache key uses raw UUID (source prefix stripped by taskPageCacheKey)
    const row = getTaskCache(`task:notion:${TASK_1}`);
    expect(row).toBeDefined();
    expect(row!.task_id).toBe(`task:notion:${TASK_1}`);

    // Old un-prefixed shape must not exist
    expect(getTaskCache(`task:${TASK_1}`)).toBeUndefined();
  });
});
