/**
 * Integration test: WS router fetch_tasks cache-only behaviour.
 *
 * After the background-cache-refresh task the WS fetch_tasks handler no longer
 * calls any backend directly. It serves from the DB task_cache table:
 *   - cold cache (null row) → tasks_ready { tasks: [] }
 *   - warm cache → tasks_ready with resolved ResolvedTask[]
 *
 * This is the regression guard that the handler NEVER calls backend.fetchReadyTasks.
 *
 * skipCache behaviour (added after the Sync-button no-op fix):
 *   - skipCache: true  → immediate cached reply + fire-and-forget background refresh
 *   - skipCache: false / absent → cache-only, no refresh (#590 invariant)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── DB mock ───────────────────────────────────────────────────────────────────

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () => ({
  upsertTaskCache: vi.fn(),
  getTasksByStatusFromCache: vi.fn().mockReturnValue([]),
  getTaskCache: vi.fn(),
}));

vi.mock('../projects/ProjectService.js', () => ({
  ProjectService: {
    getMilestone: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({
  getProjectById: vi.fn(),
  config: { dbPath: ':memory:', dataDir: '/tmp/test' },
  runtimeSettings: {},
  JIRA_HOST: '',
  JIRA_TOKEN: '',
  JIRA_EMAIL: '',
  normalizePath: (p: string) => p,
}));

vi.mock('../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi.fn(),
}));

vi.mock('../auth/Enrollment.js', () => ({
  approveEnrollment: vi.fn(),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { handleMessage, setWsRouterRefreshFn } from '../ws/router.js';
import { ProjectService } from '../projects/ProjectService.js';
import { getProjectById } from '../config.js';
import { getTaskBackend } from '../tasks/TaskBackend.js';
import { getTaskCache } from '../db/queries.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-test';
const MILESTONE_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const NOTION_SOURCE_ID = 'notion-db-deadbeef';

function makeProject() {
  return { id: PROJECT_ID, name: 'Test Project', taskSource: 'notion' };
}

function makeMilestoneRow(sourceId: string | null) {
  return {
    id: MILESTONE_UUID,
    projectId: PROJECT_ID,
    name: 'M7',
    sourceId,
    displayOrder: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeFakeWs() {
  return { send: vi.fn() } as unknown as import('ws').WebSocket;
}

function makeFakeSessions() {
  return {} as never;
}

function parseSent(ws: ReturnType<typeof makeFakeWs>): unknown {
  const calls = vi.mocked(ws.send).mock.calls;
  if (calls.length === 0) return null;
  return JSON.parse(calls[0][0] as string);
}

function makeWarmCache() {
  const cachedTasks = [
    {
      id: 'notion:task-1',
      title: 'Task 1',
      status: '🗂️ Ready',
      dependsOn: [],
      type: '💻 Code',
      notionUrl: '',
    },
  ];
  return {
    task_id: `board:${NOTION_SOURCE_ID}`,
    fetched_at: Date.now(),
    raw_json: JSON.stringify(cachedTasks),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WS fetch_tasks — cache-only path (never calls backend)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProjectById).mockReturnValue(makeProject() as never);
    vi.mocked(ProjectService.getMilestone).mockReturnValue(
      makeMilestoneRow(NOTION_SOURCE_ID) as never,
    );
    vi.mocked(getTaskCache).mockReturnValue(null); // cold by default
    // Reset refresh fn so tests are isolated
    setWsRouterRefreshFn(() => Promise.resolve());
  });

  it('returns tasks_ready with [] when cache is cold — never calls backend', () => {
    vi.mocked(getTaskCache).mockReturnValue(null);

    const ws = makeFakeWs();
    handleMessage(
      ws,
      JSON.stringify({
        type: 'fetch_tasks',
        projectId: PROJECT_ID,
        milestoneId: MILESTONE_UUID,
      }),
      makeFakeSessions(),
    );

    const sent = parseSent(ws) as { type: string; tasks: unknown[] };
    expect(sent.type).toBe('tasks_ready');
    expect(sent.tasks).toEqual([]);
    expect(getTaskBackend).not.toHaveBeenCalled();
  });

  it('returns tasks_ready with resolved tasks when cache is warm — never calls backend', () => {
    vi.mocked(getTaskCache).mockReturnValue(makeWarmCache() as never);

    const ws = makeFakeWs();
    handleMessage(
      ws,
      JSON.stringify({
        type: 'fetch_tasks',
        projectId: PROJECT_ID,
        milestoneId: MILESTONE_UUID,
      }),
      makeFakeSessions(),
    );

    const sent = parseSent(ws) as { type: string; tasks: unknown[] };
    expect(sent.type).toBe('tasks_ready');
    expect(sent.tasks).toHaveLength(1);
    expect(getTaskBackend).not.toHaveBeenCalled();
  });

  it('reads cache with board:<sourceId> key', () => {
    const ws = makeFakeWs();
    handleMessage(
      ws,
      JSON.stringify({
        type: 'fetch_tasks',
        projectId: PROJECT_ID,
        milestoneId: MILESTONE_UUID,
      }),
      makeFakeSessions(),
    );

    expect(vi.mocked(getTaskCache)).toHaveBeenCalledWith(
      `board:${NOTION_SOURCE_ID}`,
    );
  });

  it('returns tasks_ready with [] when milestone has no sourceId', () => {
    vi.mocked(ProjectService.getMilestone).mockReturnValue(
      makeMilestoneRow(null) as never,
    );

    const ws = makeFakeWs();
    handleMessage(
      ws,
      JSON.stringify({
        type: 'fetch_tasks',
        projectId: PROJECT_ID,
        milestoneId: MILESTONE_UUID,
      }),
      makeFakeSessions(),
    );

    const sent = parseSent(ws) as { type: string; tasks: unknown[] };
    expect(sent.type).toBe('tasks_ready');
    expect(sent.tasks).toEqual([]);
  });

  it('returns tasks_ready with [] when milestone is not found', () => {
    vi.mocked(ProjectService.getMilestone).mockReturnValue(undefined as never);

    const ws = makeFakeWs();
    handleMessage(
      ws,
      JSON.stringify({
        type: 'fetch_tasks',
        projectId: PROJECT_ID,
        milestoneId: MILESTONE_UUID,
      }),
      makeFakeSessions(),
    );

    const sent = parseSent(ws) as { type: string; tasks: unknown[] };
    expect(sent.type).toBe('tasks_ready');
    expect(sent.tasks).toEqual([]);
  });
});

describe('WS fetch_tasks — skipCache behaviour', () => {
  let refreshFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProjectById).mockReturnValue(makeProject() as never);
    vi.mocked(ProjectService.getMilestone).mockReturnValue(
      makeMilestoneRow(NOTION_SOURCE_ID) as never,
    );
    refreshFn = vi.fn().mockResolvedValue(undefined);
    setWsRouterRefreshFn(refreshFn);
  });

  it('skipCache: true with warm cache → immediate tasks_ready + background refresh', async () => {
    vi.mocked(getTaskCache).mockReturnValue(makeWarmCache() as never);

    const ws = makeFakeWs();
    await handleMessage(
      ws,
      JSON.stringify({
        type: 'fetch_tasks',
        projectId: PROJECT_ID,
        milestoneId: MILESTONE_UUID,
        skipCache: true,
      }),
      makeFakeSessions(),
    );

    // Immediate cached reply — handler does not block on Notion round-trip
    const sent = parseSent(ws) as { type: string; tasks: unknown[] };
    expect(sent.type).toBe('tasks_ready');
    expect(sent.tasks).toHaveLength(1);

    // Background refresh triggered with skipCache:true so Notion is hit directly
    expect(refreshFn).toHaveBeenCalledWith(PROJECT_ID, true);
  });

  it('skipCache: true with cold cache → tasks_ready [] + background refresh', async () => {
    vi.mocked(getTaskCache).mockReturnValue(null);

    const ws = makeFakeWs();
    await handleMessage(
      ws,
      JSON.stringify({
        type: 'fetch_tasks',
        projectId: PROJECT_ID,
        milestoneId: MILESTONE_UUID,
        skipCache: true,
      }),
      makeFakeSessions(),
    );

    const sent = parseSent(ws) as { type: string; tasks: unknown[] };
    expect(sent.type).toBe('tasks_ready');
    expect(sent.tasks).toEqual([]);
    expect(refreshFn).toHaveBeenCalledWith(PROJECT_ID, true);
  });

  it('skipCache absent → no background refresh (#590 invariant)', async () => {
    vi.mocked(getTaskCache).mockReturnValue(makeWarmCache() as never);

    const ws = makeFakeWs();
    await handleMessage(
      ws,
      JSON.stringify({
        type: 'fetch_tasks',
        projectId: PROJECT_ID,
        milestoneId: MILESTONE_UUID,
      }),
      makeFakeSessions(),
    );

    expect(refreshFn).not.toHaveBeenCalled();
  });

  it('skipCache: false → no background refresh (#590 invariant)', async () => {
    vi.mocked(getTaskCache).mockReturnValue(makeWarmCache() as never);

    const ws = makeFakeWs();
    await handleMessage(
      ws,
      JSON.stringify({
        type: 'fetch_tasks',
        projectId: PROJECT_ID,
        milestoneId: MILESTONE_UUID,
        skipCache: false,
      }),
      makeFakeSessions(),
    );

    expect(refreshFn).not.toHaveBeenCalled();
  });

  it('handler returns before refresh completes — never blocks on Notion round-trip', async () => {
    vi.mocked(getTaskCache).mockReturnValue(makeWarmCache() as never);
    let resolveRefresh!: () => void;
    refreshFn.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRefresh = resolve;
      }),
    );

    const ws = makeFakeWs();
    const handlerPromise = handleMessage(
      ws,
      JSON.stringify({
        type: 'fetch_tasks',
        projectId: PROJECT_ID,
        milestoneId: MILESTONE_UUID,
        skipCache: true,
      }),
      makeFakeSessions(),
    );

    // Handler completes immediately — response already sent before refresh finishes
    await handlerPromise;
    expect(ws.send).toHaveBeenCalledTimes(1);

    // Resolve the refresh after the handler has already returned
    resolveRefresh();
  });
});

describe('WS fetch_tasks — yaml/local project (no sourceId on milestone)', () => {
  const YAML_PROJECT_ID = 'proj-yaml';
  const YAML_MILESTONE_ID = 'yaml-milestone-1';

  function makeYamlProject() {
    return { id: YAML_PROJECT_ID, name: 'YAML Project', taskSource: 'yaml' };
  }

  function makeYamlMilestone() {
    return {
      id: YAML_MILESTONE_ID,
      projectId: YAML_PROJECT_ID,
      name: 'Sprint 1',
      sourceId: null,
      displayOrder: 0,
      createdAt: 0,
      updatedAt: 0,
    };
  }

  function makeYamlWarmCache() {
    const cachedTasks = [
      {
        id: 'yaml:task-1',
        title: 'YAML Task 1',
        status: '🗂️ Ready',
        dependsOn: [],
        type: '💻 Code',
      },
    ];
    return {
      task_id: `board:${YAML_MILESTONE_ID}`,
      fetched_at: Date.now(),
      raw_json: JSON.stringify(cachedTasks),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProjectById).mockReturnValue(makeYamlProject() as never);
    vi.mocked(ProjectService.getMilestone).mockReturnValue(
      makeYamlMilestone() as never,
    );
    setWsRouterRefreshFn(() => Promise.resolve());
  });

  it('returns tasks_ready with [] when cache is cold (yaml, no sourceId)', () => {
    vi.mocked(getTaskCache).mockReturnValue(null);

    const ws = makeFakeWs();
    handleMessage(
      ws,
      JSON.stringify({
        type: 'fetch_tasks',
        projectId: YAML_PROJECT_ID,
        milestoneId: YAML_MILESTONE_ID,
      }),
      makeFakeSessions(),
    );

    const sent = parseSent(ws) as { type: string; tasks: unknown[] };
    expect(sent.type).toBe('tasks_ready');
    expect(sent.tasks).toEqual([]);
  });

  it('reads cache with board:<milestoneId> key for yaml project', () => {
    vi.mocked(getTaskCache).mockReturnValue(null);

    const ws = makeFakeWs();
    handleMessage(
      ws,
      JSON.stringify({
        type: 'fetch_tasks',
        projectId: YAML_PROJECT_ID,
        milestoneId: YAML_MILESTONE_ID,
      }),
      makeFakeSessions(),
    );

    expect(vi.mocked(getTaskCache)).toHaveBeenCalledWith(
      `board:${YAML_MILESTONE_ID}`,
    );
  });

  it('returns tasks_ready with resolved tasks when cache is warm (yaml)', () => {
    vi.mocked(getTaskCache).mockReturnValue(makeYamlWarmCache() as never);

    const ws = makeFakeWs();
    handleMessage(
      ws,
      JSON.stringify({
        type: 'fetch_tasks',
        projectId: YAML_PROJECT_ID,
        milestoneId: YAML_MILESTONE_ID,
      }),
      makeFakeSessions(),
    );

    const sent = parseSent(ws) as { type: string; tasks: unknown[] };
    expect(sent.type).toBe('tasks_ready');
    expect(sent.tasks).toHaveLength(1);
  });

  it('notion project with null sourceId still returns [] (no regression)', () => {
    vi.mocked(getProjectById).mockReturnValue(makeProject() as never);
    vi.mocked(ProjectService.getMilestone).mockReturnValue(
      makeMilestoneRow(null) as never,
    );
    vi.mocked(getTaskCache).mockReturnValue(null);

    const ws = makeFakeWs();
    handleMessage(
      ws,
      JSON.stringify({
        type: 'fetch_tasks',
        projectId: PROJECT_ID,
        milestoneId: MILESTONE_UUID,
      }),
      makeFakeSessions(),
    );

    const sent = parseSent(ws) as { type: string; tasks: unknown[] };
    expect(sent.type).toBe('tasks_ready');
    expect(sent.tasks).toEqual([]);
    // Should NOT have tried to look up the cache since milestone has no sourceId
    expect(vi.mocked(getTaskCache)).not.toHaveBeenCalled();
  });
});
