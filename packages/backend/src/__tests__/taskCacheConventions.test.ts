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
    listMilestones: vi.fn(() => []),
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
// The DB milestone UUID — the board cache is keyed on this, not on BOARD_ID
// (the Notion source database id), so it stays project-scoped by construction.
const MILESTONE_ID = 'milestone-1';
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
  it('writes exactly 5 rows: 3 notion:<id> + 1 board:<milestoneId> (app cache) + 1 board:<sourceId> (NotionClient read-through cache), no raw-UUID rows', async () => {
    vi.mocked(ProjectService.getMilestone).mockReturnValue({
      id: MILESTONE_ID,
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
    await backend.fetchReadyTasks(MILESTONE_ID);

    const { db } = await import('../db/db.js');
    const rows = db
      .prepare('SELECT task_id FROM task_cache ORDER BY task_id')
      .all() as { task_id: string }[];

    // NotionClient keeps its own short-TTL read-through cache keyed on the
    // Notion database id (sourceId) — needed by callers like the groom
    // loader that call NotionClient directly with no milestone concept.
    // That row is separate from the app-level board cache, which is keyed
    // on the DB milestone UUID (see NotionTaskBackend.fetchReadyTasks).
    expect(rows).toHaveLength(5);

    const keys = rows.map((r) => r.task_id);
    expect(keys).toContain(`board:${MILESTONE_ID}`);
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
      id: MILESTONE_ID,
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
    await backend.fetchReadyTasks(MILESTONE_ID);

    const boardRow = getTaskCache(`board:${MILESTONE_ID}`);
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
    vi.mocked(ProjectService.listMilestones).mockReturnValue([
      {
        id: 'db-milestone-m1',
        projectId: 'proj-local',
        name: 'M1',
        sourceId: 'm1',
        displayOrder: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    ]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('board cache JSON contains prefixed yaml:<id> IDs, not raw IDs', async () => {
    const backend = new LocalTaskBackend(tmpDir, 'proj-local');
    await backend.fetchReadyTasks('m1');

    const boardRow = getTaskCache('board:db-milestone-m1');
    expect(boardRow).toBeDefined();
    const tasks = JSON.parse(boardRow!.raw_json) as { id: string }[];
    expect(tasks.every((t) => t.id.startsWith('yaml:'))).toBe(true);
    expect(tasks.map((t) => t.id)).toContain('yaml:task-alpha');
    expect(tasks.map((t) => t.id)).toContain('yaml:task-beta');
  });
});

// ─── LocalTaskBackend: cache key is scoped by project (same-named-milestone fix) ─

describe('LocalTaskBackend.fetchReadyTasks — board cache is scoped per project', () => {
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'local-task-projA-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'local-task-projB-'));
    for (const [dir, taskName] of [
      [dirA, 'Task From Project A'],
      [dirB, 'Task From Project B'],
    ] as const) {
      fs.writeFileSync(
        path.join(dir, 'tasks.yaml'),
        [
          'milestones:',
          '  - id: m1', // same yaml milestone id in both projects, on purpose
          '    name: Same Name',
          '    tasks:',
          '      - id: only-task',
          `        name: ${taskName}`,
          '        status: Ready',
        ].join('\n'),
      );
    }
  });

  afterEach(() => {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  it('two projects with the same yaml milestone id each retain a distinct board cache', async () => {
    vi.mocked(ProjectService.listMilestones).mockImplementation(
      (projectId: string) => {
        if (projectId === 'projA') {
          return [
            {
              id: 'db-milestone-A',
              projectId: 'projA',
              name: 'Same Name',
              sourceId: 'm1',
              displayOrder: 0,
              createdAt: 0,
              updatedAt: 0,
            },
          ];
        }
        return [
          {
            id: 'db-milestone-B',
            projectId: 'projB',
            name: 'Same Name',
            sourceId: 'm1',
            displayOrder: 0,
            createdAt: 0,
            updatedAt: 0,
          },
        ];
      },
    );

    const backendA = new LocalTaskBackend(dirA, 'projA');
    const backendB = new LocalTaskBackend(dirB, 'projB');

    await backendA.fetchReadyTasks('m1');
    await backendB.fetchReadyTasks('m1');

    const boardA = getTaskCache('board:db-milestone-A');
    const boardB = getTaskCache('board:db-milestone-B');
    expect(boardA).toBeDefined();
    expect(boardB).toBeDefined();

    const tasksA = JSON.parse(boardA!.raw_json) as { title: string }[];
    const tasksB = JSON.parse(boardB!.raw_json) as { title: string }[];

    // Neither project's board was overwritten/masked by the other's write.
    expect(tasksA).toHaveLength(1);
    expect(tasksA[0].title).toBe('Task From Project A');
    expect(tasksB).toHaveLength(1);
    expect(tasksB[0].title).toBe('Task From Project B');
  });

  it('write key and read key round-trip to the same value', async () => {
    vi.mocked(ProjectService.listMilestones).mockReturnValue([
      {
        id: 'db-milestone-roundtrip',
        projectId: 'projA',
        name: 'Same Name',
        sourceId: 'm1',
        displayOrder: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    ]);
    vi.mocked(ProjectService.getMilestone).mockReturnValue({
      id: 'db-milestone-roundtrip',
      projectId: 'projA',
      name: 'Same Name',
      sourceId: 'm1',
      displayOrder: 0,
      createdAt: 0,
      updatedAt: 0,
    });

    const backend = new LocalTaskBackend(dirA, 'projA');
    await backend.fetchReadyTasks('m1');

    // Write side (LocalTaskBackend) keys the board cache on the DB milestone
    // UUID. The read side (ws/router, /api/tasks/active) looks the milestone
    // up by that same UUID and reads `board:${milestone.id}` — reproduce that
    // read-side lookup here and confirm it hits the row LocalTaskBackend wrote.
    const milestone = ProjectService.getMilestone('db-milestone-roundtrip');
    const readKey = `board:${milestone!.id}`;
    expect(getTaskCache(readKey)).toBeDefined();
    expect(readKey).toBe('board:db-milestone-roundtrip');
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
      buildEpicParentJql: vi.fn().mockReturnValue('parent = "m1"'),
      buildSubtaskJql: vi.fn().mockReturnValue('parent in (PROJ-1, PROJ-2)'),
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
      id: MILESTONE_ID,
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
    const firstResult = await backend.fetchReadyTasks(MILESTONE_ID);
    const firstIds = firstResult.map((r) => r.task.id).sort();

    // Second call: board cache is fresh (just written), NotionClient uses cache-hit path
    const secondResult = await backend.fetchReadyTasks(MILESTONE_ID);
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
