/**
 * Integration test: end-to-end PR review with a deliberately-failing session setup.
 *
 * Unlike the unit tests in PRReviewService.errorVerdict.test.ts (which mock the
 * DB layer entirely), this test wires up a real in-memory SQLite DB via
 * setupTestDb() so that both the session-row read (getSession) and the final
 * verdict write (setPRReviewResult) go through the real queries module.
 *
 * Scenario: a review session's worktree-setup step throws before the Claude
 * subprocess ever launches. SessionManager writes status='error' and
 * last_error_detail to the sessions table, then emits session_ended. The
 * test verifies that:
 *   1. The verdict resolved by PRReviewService.reviewPR has the real cause
 *      (not the generic "Failed to parse Claude output" fallback).
 *   2. When the caller (ReviewOrchestrator in production) persists the verdict
 *      via setPRReviewResult, the pull_requests.review_result JSON stored in the
 *      DB also carries the actionable error — i.e., the dashboard would show it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Real in-memory SQLite (must be hoisted before any transitive DB import) ───

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../audit/AuditLog.js', () => ({ recordEvent: vi.fn() }));
vi.mock('../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    fetchTaskPage: vi.fn().mockResolvedValue(''),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  }),
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import { PRReviewService } from '../github/PRReviewService.js';
import { setPRReviewResult } from '../db/queries.js';
import type { DiffSource } from '../github/DiffSource.js';
import type { GitHubClient } from '../github/GitHubClient.js';
import type { TaskTrackerBackend } from '../tasks/TaskTrackerBackend.js';
import type { WorkItem } from '../github/PRReviewService.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const WORKTREE_ERROR =
  'git worktree add -b "feature/322-my-very-long-branch-name-that-exceeds-windows-max-path-limit" failed: filename too long';

/**
 * MockSessionManager that deliberately fails its session setup:
 *   - start() inserts an errored session row into the real in-memory DB
 *   - then emits session_ended (as SessionManager.markSessionErrored does)
 */
class FailingSessionManager extends EventEmitter {
  send = vi.fn();
  sendOrResume = vi.fn();
  isAlive = vi.fn().mockReturnValue(false);
  kill = vi.fn().mockResolvedValue(undefined);

  start = vi.fn().mockImplementation(
    async (
      _contextUrl: string,
      _projectContextUrl: string,
      opts: { sessionId: string; [key: string]: unknown },
    ) => {
      // Simulate completeStart rejection: write the errored session row first.
      const { db } = await import('../db/db.js');
      db.prepare(
        `INSERT INTO sessions
         (session_id, status, started_at, session_type, pause_reason, last_error_detail)
         VALUES (@session_id, 'error', @started_at, 'review', 'launch_failed', @last_error_detail)`,
      ).run({
        session_id: opts.sessionId,
        started_at: Date.now(),
        last_error_detail: WORKTREE_ERROR,
      });

      // Emit session_ended after the current microtask queue drains, matching
      // the real SessionManager.markSessionErrored behaviour.
      process.nextTick(() => {
        this.emit('message', {
          type: 'session_ended',
          sessionId: opts.sessionId,
          status: 'error',
        });
      });
    },
  );
}

function makeMockGitHub(): GitHubClient {
  return {
    fetchPR: vi.fn().mockResolvedValue({
      headSha: 'abc123',
      title: 'feat: test',
      body: '',
      id: 42,
    }),
    fetchDiff: vi.fn().mockResolvedValue('diff --git a/foo.ts b/foo.ts'),
    markPRReady: vi.fn().mockResolvedValue(undefined),
  } as unknown as GitHubClient;
}

function makeMockTaskBackend(): TaskTrackerBackend {
  return {
    type: 'local',
    fetchTaskPage: vi.fn().mockResolvedValue(''),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    fetchTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    fetchTaskTitle: vi.fn().mockResolvedValue('Test Task'),
  } as unknown as TaskTrackerBackend;
}

function makeMockDiffSource(): DiffSource {
  return {
    fetchDiff: vi.fn().mockResolvedValue('diff --git a/foo.ts b/foo.ts'),
  } as unknown as DiffSource;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PRReviewService worktree-error — integration', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { db } = await import('../db/db.js');
    db.exec('DELETE FROM pull_requests');
    db.exec('DELETE FROM sessions');
  });

  it('stores the real error cause in review_result when the session setup fails before producing output', async () => {
    const { db } = await import('../db/db.js');

    // Seed the PR row so getPRByNumber finds it.
    db.prepare(
      `INSERT INTO pull_requests
         (pr_number, pr_url, repo, title, state, draft, created_at, updated_at, synced_at,
          task_id, session_id, head_sha)
       VALUES (42, 'https://github.com/owner/repo/pull/42', 'owner/repo',
               'feat: test', 'open', 0,
               '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z',
               'notion:task-id', 'code-session-id', 'abc123')`,
    ).run();

    const sessionManager = new FailingSessionManager();
    const reviewService = new PRReviewService(
      makeMockGitHub(),
      makeMockTaskBackend(),
      sessionManager as unknown as InstanceType<
        typeof import('../session/SessionManager.js').SessionManager
      >,
      'proj-1',
      'https://notion.so/ctx',
    );

    const workItem: WorkItem = { type: 'pr', prNumber: 42, repo: 'owner/repo' };
    const result = await reviewService.reviewPR(
      workItem,
      makeMockDiffSource(),
      'proj-1',
    );

    // ── Assert: verdict returned to the caller (ReviewOrchestrator) ───────────

    expect(result.verdict).toBe('incomplete');
    expect(result.summary).toContain('launch_failed');
    expect(result.summary).not.toContain('Failed to parse Claude output');
    expect(result.errorDetail).toContain('filename too long');

    // ── Assert: verdict persisted to DB (simulating ReviewOrchestrator's write) ─
    // ReviewOrchestrator calls setPRReviewResult(result) after reviewPR returns.
    // We replicate that write here to verify the full round-trip.
    setPRReviewResult(42, 'owner/repo', JSON.stringify(result));

    const row = db
      .prepare(
        `SELECT review_result FROM pull_requests
         WHERE pr_number = 42 AND repo = 'owner/repo'`,
      )
      .get() as { review_result: string | null };

    expect(row.review_result).not.toBeNull();
    const stored = JSON.parse(row.review_result!) as Record<string, unknown>;

    expect(stored.verdict).toBe('incomplete');
    expect(stored.summary).not.toContain('Failed to parse Claude output');
    expect(typeof stored.errorDetail).toBe('string');
    expect(stored.errorDetail as string).toContain('filename too long');
  });
});
