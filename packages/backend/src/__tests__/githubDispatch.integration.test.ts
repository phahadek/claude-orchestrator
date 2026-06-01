/**
 * E2E integration test: GitHub dispatch → review → merge pipeline.
 *
 * Parallel to the Notion-backed audit-events lifecycle test, this verifies that
 * a GitHub-backed project flows through the entire pipeline — dispatch, review,
 * status update — using GithubTaskSourceProvider with no Notion-specific dead ends.
 *
 * Assertions:
 * 1. AutoLauncher with GithubTaskSourceProvider dispatches tasks as 'github:N' IDs.
 * 2. PRReviewService starts a review session carrying the 'github:N' task ID.
 * 3. GithubTaskSourceProvider.updateStatus('github:42', '✅ Done') reaches
 *    client.updateIssue with status:done label and state:closed — the correct
 *    GitHub-native status path, not Notion.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── DB mock (must hoist before any transitive db import) ──────────────────────

vi.mock('../db/db.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY, task_id TEXT, task_url TEXT,
      project_context_url TEXT, status TEXT NOT NULL, started_at INTEGER NOT NULL,
      ended_at INTEGER, pr_url TEXT, worktree_path TEXT,
      archived INTEGER NOT NULL DEFAULT 0, project_id TEXT,
      session_type TEXT NOT NULL DEFAULT 'standard',
      favorited INTEGER NOT NULL DEFAULT 0, note TEXT, tags TEXT,
      task_name TEXT, model TEXT,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      metadata TEXT, review_result TEXT
    );
    CREATE TABLE IF NOT EXISTS task_cache (
      task_id TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pull_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pr_number INTEGER NOT NULL,
      pr_url TEXT NOT NULL UNIQUE, task_id TEXT, session_id TEXT,
      repo TEXT NOT NULL, title TEXT, body TEXT, head_branch TEXT, base_branch TEXT,
      state TEXT NOT NULL DEFAULT 'open', draft INTEGER NOT NULL DEFAULT 0,
      review_result TEXT, review_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, synced_at TEXT NOT NULL,
      review_session_id TEXT, review_iteration INTEGER NOT NULL DEFAULT 0,
      head_sha TEXT, last_reviewed_sha TEXT, node_id TEXT,
      mergeable INTEGER, merge_state TEXT, merge_state_checked_at TEXT,
      pending_push INTEGER NOT NULL DEFAULT 0, pause_reason TEXT, failing_checks TEXT
    );
    CREATE TABLE IF NOT EXISTS milestones (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
      source_id TEXT, display_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, project_dir TEXT NOT NULL,
      context_url TEXT, github_repo TEXT,
      task_source TEXT NOT NULL DEFAULT 'notion',
      auto_launch_enabled INTEGER NOT NULL DEFAULT 0,
      auto_launch_milestone_id TEXT, auto_merge_enabled INTEGER NOT NULL DEFAULT 0,
      git_mode TEXT NOT NULL DEFAULT 'github',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS permission_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL, proposed_action TEXT, decision TEXT NOT NULL,
      rule_matched TEXT, decided_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS permission_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_index INTEGER NOT NULL,
      pattern TEXT NOT NULL, match_type TEXT NOT NULL, decision TEXT NOT NULL,
      label TEXT, enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS permission_denials (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL, tool_use_id TEXT NOT NULL,
      tool_input TEXT NOT NULL, timestamp INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      event_type TEXT NOT NULL, payload TEXT NOT NULL,
      timestamp INTEGER NOT NULL, message_id TEXT
    );
    CREATE TABLE IF NOT EXISTS local_branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, branch_name TEXT NOT NULL,
      base_branch TEXT NOT NULL, project_id TEXT NOT NULL, session_id TEXT,
      task_id TEXT, state TEXT NOT NULL DEFAULT 'open',
      review_result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL,
      actor_type TEXT NOT NULL, actor_id TEXT, project_id TEXT,
      task_id TEXT, payload TEXT, timestamp INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, name TEXT, user_agent TEXT, last_ip TEXT,
      last_seen INTEGER, enrolled_at INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE, revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pr_review_comments_routed (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number INTEGER NOT NULL, repo TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      UNIQUE(pr_number, repo, comment_id)
    );
    CREATE TABLE IF NOT EXISTS noopAttempts (
      task_id TEXT PRIMARY KEY, retry_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS pending_review_syncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pr_number INTEGER NOT NULL,
      repo TEXT NOT NULL, sha TEXT NOT NULL,
      UNIQUE(pr_number, repo)
    );
  `);
  return { db };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () => ({
  getPRByNumber: vi.fn(),
  getEventsBySession: vi.fn().mockReturnValue([]),
  setReviewSessionId: vi.fn(),
  setLastReviewedSha: vi.fn(),
  setPRReviewResult: vi.fn(),
  updatePRDraftStatus: vi.fn(),
  incrementReviewIteration: vi.fn(),
  hasActiveSessionForTask: vi.fn().mockReturnValue(false),
  getPausedPrReasonForTask: vi.fn().mockReturnValue(null),
  getLocalBranchById: vi.fn(),
  setLocalBranchReviewResult: vi.fn(),
  getAllPendingReviewSyncs: vi.fn().mockReturnValue([]),
  insertPendingReviewSync: vi.fn(),
  deletePendingReviewSync: vi.fn(),
  getSetting: vi.fn().mockReturnValue(null),
  getSession: vi.fn(),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../config.js', () => ({
  runtimeSettings: {
    auto_launch_concurrency: 2,
    auto_launch_poll_interval_ms: 60_000,
  },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { GithubTaskSourceProvider } from '../tasks/GithubTaskSourceProvider.js';
import { AutoLauncher } from '../orchestration/AutoLauncher.js';
import { PRReviewService } from '../github/PRReviewService.js';
import type { GitHubClient } from '../github/GitHubClient.js';
import type { Issue } from '../github/types.js';
import type { DiffSource } from '../github/DiffSource.js';
import type { PullRequestRow } from '../db/types.js';
import { getPRByNumber, getEventsBySession } from '../db/queries.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const REPO = 'owner/repo';
const ISSUE_NUMBER = 42;
const TASK_ID = 'github:42';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: ISSUE_NUMBER,
    number: ISSUE_NUMBER,
    title: 'Implement feature X',
    body: '## Summary\nImplement X',
    labels: ['status:ready', 'type:code'],
    state: 'open',
    url: `https://github.com/${REPO}/issues/${ISSUE_NUMBER}`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    milestone: null,
    ...overrides,
  };
}

function makePRRow(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: 42,
    pr_url: `https://github.com/${REPO}/pull/42`,
    task_id: TASK_ID,
    session_id: 'code-session-id',
    repo: REPO,
    title: 'feat: implement X',
    body: null,
    head_branch: 'feature/implement-x',
    base_branch: 'dev',
    state: 'open',
    draft: 1,
    review_result: null,
    review_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T01:00:00Z',
    synced_at: '2026-01-01T01:00:00Z',
    review_session_id: null,
    review_iteration: 0,
    head_sha: 'abc123',
    last_reviewed_sha: null,
    node_id: 'PR_node',
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
    pending_push: 0,
    pause_reason: null,
    failing_checks: null,
    ...overrides,
  };
}

function makeMockGitHubClient(): GitHubClient {
  return {
    listIssues: vi.fn().mockResolvedValue([makeIssue()]),
    getIssue: vi.fn().mockResolvedValue(makeIssue()),
    updateIssue: vi.fn().mockResolvedValue(undefined),
    addIssueComment: vi.fn().mockResolvedValue(undefined),
    listIssueComments: vi.fn().mockResolvedValue([]),
    fetchPR: vi.fn().mockResolvedValue({
      id: 42,
      number: 42,
      title: 'feat: implement X',
      body: '## Summary\nImplement X',
      headSha: 'abc123',
      draft: true,
      state: 'open',
      mergedAt: null,
    }),
    markPRReady: vi.fn().mockResolvedValue(undefined),
  } as unknown as GitHubClient;
}

function makeSessionManager() {
  const em = new EventEmitter() as EventEmitter & {
    start: ReturnType<typeof vi.fn>;
    isAlive: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    sendOrResume: ReturnType<typeof vi.fn>;
    getLiveCodeSessionCount: ReturnType<typeof vi.fn>;
    hasLiveSessionForTask: ReturnType<typeof vi.fn>;
  };
  em.start = vi.fn();
  em.isAlive = vi.fn().mockReturnValue(false);
  em.send = vi.fn();
  em.sendOrResume = vi.fn();
  em.getLiveCodeSessionCount = vi.fn().mockReturnValue(0);
  em.hasLiveSessionForTask = vi.fn().mockReturnValue(false);
  return em;
}

// ── Phase 1: Dispatch ──────────────────────────────────────────────────────────

describe('GitHub dispatch — AutoLauncher + GithubTaskSourceProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetchReadyTasks returns tasks with github:N IDs', async () => {
    const client = makeMockGitHubClient();
    const provider = new GithubTaskSourceProvider(client, {
      owner: 'owner',
      repo: 'repo',
    });

    const tasks = await provider.fetchReadyTasks(null);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].task.id).toBe(TASK_ID);
    expect(tasks[0].source).toBe('github');
  });

  it('AutoLauncher calls sessionManager.start() with taskId: "github:42"', async () => {
    const client = makeMockGitHubClient();
    const provider = new GithubTaskSourceProvider(client, {
      owner: 'owner',
      repo: 'repo',
    });

    const sessionManager = makeSessionManager();
    sessionManager.start.mockReturnValue('session-abc');
    vi.mocked(getPRByNumber);

    const project = {
      id: 'proj-github',
      name: 'GitHub Project',
      projectDir: '/fake',
      contextUrl: 'https://github.com/owner/repo',
      boardId: null,
      taskSource: 'github' as const,
      gitMode: 'github' as const,
      autoLaunchEnabled: true,
      autoLaunchMilestoneId: null,
      autoMergeEnabled: false,
    };

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [project],
      resolveBackend: () => provider,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    expect(sessionManager.start).toHaveBeenCalledOnce();
    const startCall = sessionManager.start.mock.calls[0];
    const opts = startCall[2] as { taskId?: string };
    expect(opts.taskId).toBe(TASK_ID);
  });

  it('sessionManager.start() task URL is the GitHub issue URL (not a Notion URL)', async () => {
    const client = makeMockGitHubClient();
    const provider = new GithubTaskSourceProvider(client, {
      owner: 'owner',
      repo: 'repo',
    });

    const sessionManager = makeSessionManager();
    sessionManager.start.mockReturnValue('session-abc');

    const project = {
      id: 'proj-github',
      name: 'GitHub Project',
      projectDir: '/fake',
      contextUrl: 'https://github.com/owner/repo',
      boardId: null,
      taskSource: 'github' as const,
      gitMode: 'github' as const,
      autoLaunchEnabled: true,
      autoLaunchMilestoneId: null,
      autoMergeEnabled: false,
    };

    const launcher = new AutoLauncher(sessionManager as never, undefined, {
      listProjects: () => [project],
      resolveBackend: () => provider,
      pollOnStart: false,
    });

    await launcher.pollOnce();

    const startCall = sessionManager.start.mock.calls[0];
    const taskUrl = startCall[0] as string;
    expect(taskUrl).toContain('github.com');
    expect(taskUrl).not.toContain('notion.so');
  });
});

// ── Phase 2: Review ────────────────────────────────────────────────────────────

describe('GitHub review — PRReviewService threads github:N task ID', () => {
  beforeEach(() => vi.clearAllMocks());

  it('review session starts with taskId: "github:42" from PR row', async () => {
    const client = makeMockGitHubClient();
    const provider = new GithubTaskSourceProvider(client, {
      owner: 'owner',
      repo: 'repo',
    });

    // Mock provider.fetchTaskPage to return a task body for the review
    vi.spyOn(provider, 'fetchTaskPage').mockResolvedValue('## Summary\nDo X');

    const sessionManager = makeSessionManager();
    let capturedSessionId: string | undefined;

    sessionManager.start.mockImplementation(
      (_taskUrl: string, _ctxUrl: string, opts: { sessionId?: string }) => {
        capturedSessionId = opts.sessionId ?? 'review-session-id';
        // Emit verdict events then session_ended so waitForVerdict resolves
        setImmediate(() => {
          vi.mocked(getEventsBySession).mockReturnValue([
            {
              id: 1,
              session_id: capturedSessionId!,
              event_type: 'text',
              timestamp: Date.now(),
              message_id: null,
              payload: JSON.stringify({
                type: 'assistant',
                message: {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        verdict: 'approved',
                        dimensions: [],
                        summary: 'All checks passed',
                      }),
                    },
                  ],
                },
              }),
            },
          ]);
          sessionManager.emit('message', {
            type: 'session_ended',
            sessionId: capturedSessionId,
            status: 'done',
          });
        });
        return capturedSessionId;
      },
    );

    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());

    const diffSource: DiffSource = {
      fetchDiff: vi.fn().mockResolvedValue('diff --git a/foo.ts'),
    };

    const reviewService = new PRReviewService(
      client,
      provider, // taskBackendOverride — routes all backend calls to GithubTaskSourceProvider
      sessionManager as never,
      'proj-github',
      'https://github.com/owner/repo',
    );

    const result = await reviewService.reviewPR(
      { type: 'pr', prNumber: 42, repo: REPO },
      diffSource,
    );

    // Verify the review session was started with the github:N task ID
    expect(sessionManager.start).toHaveBeenCalledOnce();
    const startOpts = sessionManager.start.mock.calls[0][2] as {
      taskId?: string;
      sessionType?: string;
    };
    expect(startOpts.taskId).toBe(TASK_ID);
    expect(startOpts.sessionType).toBe('review');

    // Verify verdict resolved correctly
    expect(result.verdict).toBe('approved');
  });
});

// ── Phase 3: Merge / status update ────────────────────────────────────────────

describe('GitHub merge — GithubTaskSourceProvider handles status updates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updateStatus("github:42", "✅ Done") calls client.updateIssue with status:done + state:closed', async () => {
    const client = makeMockGitHubClient();
    vi.mocked(client.getIssue).mockResolvedValue(
      makeIssue({ labels: ['status:in-review', 'type:code'] }),
    );

    const provider = new GithubTaskSourceProvider(client, {
      owner: 'owner',
      repo: 'repo',
    });

    await provider.updateStatus(TASK_ID, '✅ Done');

    expect(client.getIssue).toHaveBeenCalledWith(REPO, ISSUE_NUMBER);
    expect(client.updateIssue).toHaveBeenCalledWith(REPO, ISSUE_NUMBER, {
      labels: expect.arrayContaining(['status:done', 'type:code']),
      state: 'closed',
    });
    // Confirm the old status:in-review label was replaced, not accumulated
    const callArgs = vi.mocked(client.updateIssue).mock.calls[0][2];
    expect(callArgs.labels).not.toContain('status:in-review');
  });

  it('updateStatus("github:42", "🔄 In Progress") calls client.updateIssue without closing the issue', async () => {
    const client = makeMockGitHubClient();
    vi.mocked(client.getIssue).mockResolvedValue(
      makeIssue({ labels: ['status:ready', 'type:code'] }),
    );

    const provider = new GithubTaskSourceProvider(client, {
      owner: 'owner',
      repo: 'repo',
    });

    await provider.updateStatus(TASK_ID, '🔄 In Progress');

    expect(client.updateIssue).toHaveBeenCalledWith(REPO, ISSUE_NUMBER, {
      labels: expect.arrayContaining(['status:in-progress', 'type:code']),
    });
    // state should NOT be set to closed
    const callArgs = vi.mocked(client.updateIssue).mock.calls[0][2];
    expect(callArgs.state).toBeUndefined();
  });

  it('no Notion API is called anywhere in the merge status path', async () => {
    // GithubTaskSourceProvider has no Notion imports — verifying it's the
    // same module that dispatch and review use confirms end-to-end Notion isolation.
    const source = (await import('fs')).readFileSync(
      new URL(
        '../tasks/GithubTaskSourceProvider.ts',
        import.meta.url,
      ).pathname.replace(/^\/([A-Z]:)/, '$1'),
      'utf-8',
    );
    expect(source).not.toContain('NotionClient');
    expect(source).not.toContain('notion.so');
  });
});
