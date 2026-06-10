/**
 * Tests for PRReviewService verdict construction when a review session errors
 * before producing any output (e.g. worktree-setup failure).
 *
 * Verifies:
 * 1. When session ends with status='error' + last_error_detail, the verdict
 *    summary contains the real cause rather than the generic JSON-parse fallback.
 * 2. When session completes normally but produces un-parseable output, the
 *    existing generic fallback still fires (no regression).
 * 3. When session errors but last_error_detail is null, generic fallback fires.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () => ({
  getEventsBySession: vi.fn().mockReturnValue([]),
  setPRReviewResult: vi.fn(),
  getPRByNumber: vi.fn(),
  setReviewSessionId: vi.fn(),
  updatePRDraftStatus: vi.fn(),
  incrementReviewIteration: vi.fn(),
  setLastReviewedSha: vi.fn(),
  setLocalBranchReviewResult: vi.fn(),
  getLocalBranchById: vi.fn(),
  getSession: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    fetchTaskPage: vi.fn().mockResolvedValue(''),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  }),
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import { PRReviewService } from '../github/PRReviewService.js';
import type { DiffSource } from '../github/DiffSource.js';
import * as queries from '../db/queries.js';
import type { GitHubClient } from '../github/GitHubClient.js';
import type { TaskTrackerBackend } from '../tasks/TaskTrackerBackend.js';
import type { PullRequestRow } from '../db/types.js';
import type { WorkItem } from '../github/PRReviewService.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

class MockSessionManager extends EventEmitter {
  send = vi.fn();
  sendOrResume = vi.fn().mockResolvedValue('session-id');
  isAlive = vi.fn().mockReturnValue(false);
  start = vi.fn().mockResolvedValue(undefined);
  kill = vi.fn().mockResolvedValue(undefined);
}

function makePRRow(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: 42,
    pr_url: 'https://github.com/owner/repo/pull/42',
    task_id: 'notion:task-id',
    session_id: 'code-session-id',
    repo: 'owner/repo',
    title: 'feat: test',
    body: null,
    head_branch: 'feature/test',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: null,
    review_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T01:00:00Z',
    synced_at: '2024-01-01T01:00:00Z',
    review_session_id: null,
    review_iteration: 0,
    head_sha: 'abc123',
    last_reviewed_sha: null,
    node_id: null,
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
    failing_checks: null,
    pending_push: 0,
    pause_reason: null,
    pause_reason_set_at: null,
    ci_remediation_attempted_sha: null,
    pre_review_stage: null,
    ...overrides,
  };
}

function makeMockGitHub(): GitHubClient {
  return {
    fetchPR: vi.fn().mockResolvedValue({
      headSha: 'abc123',
      title: 'feat: test',
      body: 'Test PR body',
      id: 42,
    }),
    fetchDiff: vi.fn().mockResolvedValue('diff --git a/foo.ts'),
    markPRReady: vi.fn().mockResolvedValue(undefined),
  } as unknown as GitHubClient;
}

function makeMockDiffSource(): DiffSource {
  return {
    fetchDiff: vi.fn().mockResolvedValue('diff --git a/foo.ts b/foo.ts'),
  } as unknown as DiffSource;
}

function makeMockTaskBackend(): TaskTrackerBackend {
  return {
    type: 'local',
    fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nTest task'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    fetchTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    fetchTaskTitle: vi.fn().mockResolvedValue('Test Task'),
  } as unknown as TaskTrackerBackend;
}

/**
 * Starts a reviewPR call (Case 3 — no prior review session), then fires a
 * session_ended event on the mock session manager. Returns the resolved result.
 */
async function runReviewWithSessionEnded(
  sessionRow: {
    status: string;
    pause_reason: string | null;
    last_error_detail: string | null;
  } | undefined,
  storedEvents: { payload: string; event_type: string }[] = [],
): Promise<import('../github/PRReviewService.js').PRReviewResult> {
  const sessionManager = new MockSessionManager();
  const github = makeMockGitHub();
  const taskBackend = makeMockTaskBackend();
  const diffSource = makeMockDiffSource();

  const reviewService = new PRReviewService(
    github,
    taskBackend,
    sessionManager as unknown as InstanceType<
      typeof import('../session/SessionManager.js').SessionManager
    >,
    'proj-1',
    'https://notion.so/ctx',
  );

  vi.mocked(queries.getPRByNumber).mockReturnValue(makePRRow());
  vi.mocked(queries.getEventsBySession).mockReturnValue(storedEvents as never);
  vi.mocked(queries.getSession).mockReturnValue(sessionRow as never);

  let capturedSessionId: string | undefined;
  vi.mocked(queries.setReviewSessionId).mockImplementation(
    (_prNumber: number, _repo: string, sessionId: string) => {
      capturedSessionId = sessionId;
    },
  );

  const workItem: WorkItem = { type: 'pr', prNumber: 42, repo: 'owner/repo' };
  const resultPromise = reviewService.reviewPR(workItem, diffSource, 'proj-1');

  // Give reviewPR time to register the listener and call start()
  await new Promise((r) => setTimeout(r, 20));

  // Emit session_ended for the captured session id
  if (capturedSessionId) {
    sessionManager.emit('message', {
      type: 'session_ended',
      sessionId: capturedSessionId,
      status: sessionRow?.status ?? 'done',
    });
  }

  return resultPromise;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PRReviewService error verdict construction', () => {
  it('surfaces the real error cause when session errored before producing output', async () => {
    const result = await runReviewWithSessionEnded({
      status: 'error',
      pause_reason: 'launch_failed',
      last_error_detail:
        'git worktree add -b "feature/322-very-long-name" failed: filename too long',
    });

    expect(result.verdict).toBe('incomplete');
    expect(result.summary).toContain('launch_failed');
    expect(result.summary).not.toContain('Failed to parse Claude output');
    expect(result.errorDetail).toContain('git worktree add');
    expect(result.errorDetail).toContain('filename too long');
  });

  it('falls back to generic message when session completed normally but output is not JSON', async () => {
    const nonJsonEvent = {
      event_type: 'system',
      payload: JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'This is not JSON output' }],
        },
      }),
    };

    const result = await runReviewWithSessionEnded(
      // Session completed normally — status='done', no last_error_detail
      { status: 'done', pause_reason: null, last_error_detail: null },
      [nonJsonEvent],
    );

    expect(result.verdict).toBe('incomplete');
    expect(result.summary).toContain('Failed to parse Claude output as JSON');
    expect(result.errorDetail).toBeUndefined();
  });

  it('falls back to generic message when session errored but last_error_detail is null', async () => {
    const result = await runReviewWithSessionEnded({
      status: 'error',
      pause_reason: 'launch_failed',
      last_error_detail: null,
    });

    // No last_error_detail → generic fallback path
    expect(result.verdict).toBe('incomplete');
    expect(result.summary).toContain('Failed to parse Claude output as JSON');
    expect(result.errorDetail).toBeUndefined();
  });

  it('falls back to generic message when session row is not found', async () => {
    const result = await runReviewWithSessionEnded(undefined);

    expect(result.verdict).toBe('incomplete');
    expect(result.summary).toContain('Failed to parse Claude output as JSON');
  });

  it('includes pause_reason in the summary when session errors with a specific reason', async () => {
    const result = await runReviewWithSessionEnded({
      status: 'error',
      pause_reason: 'worktree_recreate_failed',
      last_error_detail: 'Branch already exists: feature/my-task',
    });

    expect(result.summary).toContain('worktree_recreate_failed');
    expect(result.errorDetail).toBe('Branch already exists: feature/my-task');
  });
});
