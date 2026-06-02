/**
 * Integration test: WS router fetch_tasks → backend resolution boundary.
 *
 * Pins the invariant that the router passes msg.milestoneId (a dashboard UUID)
 * directly to the backend without translating it to source_id first. Each backend
 * is responsible for its own resolution:
 *   - NotionTaskBackend: UUID → row.sourceId → NotionClient.fetchReadyTasks(sourceId)
 *   - GithubTaskSourceProvider: UUID → row.sourceId → parseInt → listIssues(milestone: N)
 *
 * Regression guard for commit e57e1e8 which introduced double-resolution.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── DB mock (must hoist before any transitive db import) ──────────────────────

vi.mock('../db/db.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_cache (
      task_id TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, raw_json TEXT NOT NULL
    );
  `);
  return { db };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () => ({
  upsertTaskCache: vi.fn(),
  getTasksByStatusFromCache: vi.fn().mockReturnValue([]),
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

import { handleMessage } from '../ws/router.js';
import { NotionTaskBackend } from '../tasks/NotionTaskBackend.js';
import { GithubTaskSourceProvider } from '../tasks/GithubTaskSourceProvider.js';
import { ProjectService } from '../projects/ProjectService.js';
import { getProjectById } from '../config.js';
import { getTaskBackend } from '../tasks/TaskBackend.js';
import type { GitHubClient } from '../github/GitHubClient.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-test';
const MILESTONE_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const NOTION_SOURCE_ID = 'notion-db-deadbeef';
const GITHUB_SOURCE_ID = '7'; // GitHub milestone number as string

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

// ── Notion path ───────────────────────────────────────────────────────────────

describe('WS fetch_tasks → NotionTaskBackend: router passes UUID, backend calls NotionClient with source_id', () => {
  let notionFetchReadyTasks: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(getProjectById).mockReturnValue(makeProject() as never);
    vi.mocked(ProjectService.getMilestone).mockReturnValue(
      makeMilestoneRow(NOTION_SOURCE_ID) as never,
    );

    notionFetchReadyTasks = vi.fn().mockResolvedValue([]);
    const mockNotionClient = {
      fetchReadyTasks: notionFetchReadyTasks,
    } as never;

    const backend = new NotionTaskBackend(mockNotionClient);
    vi.mocked(getTaskBackend).mockReturnValue(backend as never);
  });

  it('NotionClient.fetchReadyTasks is called with milestone source_id, not the UUID', async () => {
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

    await vi.waitFor(() => expect(notionFetchReadyTasks).toHaveBeenCalled());

    // Backend receives the UUID and resolves it itself
    expect(ProjectService.getMilestone).toHaveBeenCalledWith(MILESTONE_UUID);
    expect(ProjectService.getMilestone).not.toHaveBeenCalledWith(
      NOTION_SOURCE_ID,
    );

    // NotionClient ends up with source_id (correct resolution path)
    expect(notionFetchReadyTasks).toHaveBeenCalledWith(
      NOTION_SOURCE_ID,
      undefined,
    );
  });
});

// ── GitHub path ───────────────────────────────────────────────────────────────

describe('WS fetch_tasks → GithubTaskSourceProvider: router passes UUID, backend calls listIssues with integer', () => {
  let listIssues: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(getProjectById).mockReturnValue(makeProject() as never);
    vi.mocked(ProjectService.getMilestone).mockReturnValue(
      makeMilestoneRow(GITHUB_SOURCE_ID) as never,
    );

    listIssues = vi.fn().mockResolvedValue([]);
    const mockGitHubClient = { listIssues } as unknown as GitHubClient;

    const backend = new GithubTaskSourceProvider(mockGitHubClient, {
      owner: 'owner',
      repo: 'repo',
    });
    vi.mocked(getTaskBackend).mockReturnValue(backend as never);
  });

  it('listIssues is called with the parsed integer milestone number', async () => {
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

    await vi.waitFor(() => expect(listIssues).toHaveBeenCalled());

    expect(ProjectService.getMilestone).toHaveBeenCalledWith(MILESTONE_UUID);
    expect(listIssues).toHaveBeenCalledWith('owner/repo', {
      labels: ['status:ready'],
      milestone: 7,
      state: 'open',
    });
  });

  it('throws for unknown UUID (not found) without attempting parseInt on the ID itself', async () => {
    vi.mocked(ProjectService.getMilestone).mockReturnValue(undefined as never);

    const mockGitHubClient = { listIssues: vi.fn() } as unknown as GitHubClient;
    const backend = new GithubTaskSourceProvider(mockGitHubClient, {
      owner: 'owner',
      repo: 'repo',
    });

    await expect(backend.fetchReadyTasks(MILESTONE_UUID)).rejects.toThrow(
      `milestone not found: ${MILESTONE_UUID}`,
    );
    expect(mockGitHubClient.listIssues).not.toHaveBeenCalled();
  });
});
