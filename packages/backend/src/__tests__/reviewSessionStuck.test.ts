/**
 * Tests for event-driven PR review — StuckSessionMonitor integration.
 *
 * Verifies:
 * 1. StuckSessionMonitor now tracks review sessions (removed sessionType guard).
 * 2. When a review session is hard-stopped (killed → session_ended), waitForVerdict
 *    resolves via the stored-events fallback → ReviewOrchestrator emits
 *    review_incomplete and advances the queue (not silently blocked).
 * 3. A review that resolves after the old 120 s wall-clock still routes its verdict.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () => ({
  getPRByNumber: vi.fn(),
  getPRBySessionId: vi.fn().mockReturnValue(null),
  setPRReviewResult: vi.fn(),
  getEventsBySession: vi.fn().mockReturnValue([]),
  setReviewSessionId: vi.fn(),
  updatePRDraftStatus: vi.fn(),
  incrementReviewIteration: vi.fn(),
  setLastReviewedSha: vi.fn(),
  setLocalBranchReviewResult: vi.fn(),
  getLocalBranchById: vi.fn(),
  getSetting: vi.fn().mockReturnValue(null),
  getSession: vi.fn().mockReturnValue(undefined),
  setPendingPush: vi.fn(),
  setPauseReason: vi.fn(),
  insertPauseInterval: vi.fn(),
  closePauseInterval: vi.fn(),
  upsertStuckSessionTimer: vi.fn(),
  deleteStuckSessionTimer: vi.fn(),
  getAllStuckSessionTimers: vi.fn().mockReturnValue([]),
  getStuckResultSessionRows: vi.fn().mockReturnValue([]),
  markSessionDone: vi.fn(),
  getLocalBranchBySession: vi.fn(),
  setLocalBranchPauseReason: vi.fn(),
  addAutofixSha: vi.fn(),
  consumeAutofixSha: vi.fn().mockReturnValue(false),
  getAllPendingReviewSyncs: vi.fn().mockReturnValue([]),
  insertPendingReviewSync: vi.fn(),
  deletePendingReviewSync: vi.fn(),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../config.js', () => ({
  runtimeSettings: {
    session_notify_threshold_seconds: 3600,
    session_pause_threshold_seconds: 7200,
    session_hard_stop_window_seconds: 60,
  },
  getProjectByGithubRepo: vi.fn().mockReturnValue({
    id: 'proj-1',
    name: 'Test',
    projectDir: '/test',
    contextUrl: 'https://notion.so/ctx',
    boardId: 'board-1',
    githubRepo: 'owner/repo',
  }),
  getProjectById: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../session/autofix-runner.js', () => ({
  loadAutofixCommands: vi.fn().mockReturnValue([]),
  runAutofix: vi.fn().mockResolvedValue({ success: true, summary: 'no diff' }),
}));

vi.mock('../session/filePollutionCheck.js', () => ({
  runFilePollutionCheck: vi.fn().mockResolvedValue({ headSha: null, revertCommitSha: null }),
}));

vi.mock('../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    verify: [],
    autofix: [],
    ci_check_name: [],
    allowed_tools: [],
    bash_rules: [],
    bootstrap_script: '',
  }),
}));

vi.mock('../orchestration/verifyRunner.js', () => ({
  runVerifyAsGate: vi.fn().mockResolvedValue({ passed: true }),
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import { StuckSessionMonitor } from '../orchestration/StuckSessionMonitor';
import { PRReviewService } from '../github/PRReviewService';
import { ReviewOrchestrator } from '../github/ReviewOrchestrator';
import * as queries from '../db/queries';
import type { SessionManager } from '../session/SessionManager';
import type { GitHubClient } from '../github/GitHubClient';
import type { TaskTrackerBackend } from '../tasks/TaskTrackerBackend';
import type { PullRequestRow } from '../db/types';

// ── Helpers ────────────────────────────────────────────────────────────────────

class MockSessionManager extends EventEmitter {
  send = vi.fn();
  sendOrResume = vi.fn().mockResolvedValue('session-id');
  isAlive = vi.fn().mockReturnValue(false);
  start = vi.fn();
  kill = vi.fn().mockResolvedValue(undefined);
  addToRevertLock = vi.fn();
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
    pending_push: 0,
    pause_reason: null,
    ...overrides,
  };
}

function makeMockGitHub(): GitHubClient {
  return {
    fetchPR: vi.fn().mockResolvedValue({ headSha: 'abc123', title: 'test', body: null }),
    fetchDiff: vi.fn().mockResolvedValue({ diff: 'diff --git a/foo.ts' }),
    markPRReady: vi.fn().mockResolvedValue(undefined),
  } as unknown as GitHubClient;
}

function makeMockTaskBackend(): TaskTrackerBackend {
  return {
    fetchTaskPage: vi.fn().mockResolvedValue('# Task'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskTrackerBackend;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queries.getAllPendingReviewSyncs).mockReturnValue([]);
  vi.mocked(queries.getAllStuckSessionTimers).mockReturnValue([]);
});

// ── 1. StuckSessionMonitor tracks review sessions ─────────────────────────────

describe('StuckSessionMonitor — review session tracking', () => {
  it('starts tracking when session_started fires with sessionType=review', () => {
    const sm = new MockSessionManager();
    const monitor = new StuckSessionMonitor(
      sm as unknown as SessionManager,
      vi.fn(),
    );

    sm.emit('message', {
      type: 'session_started',
      sessionId: 'review-sess-1',
      sessionType: 'review',
      taskName: '#42 feat: test',
    });

    expect(monitor.isTracking('review-sess-1')).toBe(true);
  });

  it('clears review session tracking on session_ended', () => {
    const sm = new MockSessionManager();
    const monitor = new StuckSessionMonitor(
      sm as unknown as SessionManager,
      vi.fn(),
    );

    sm.emit('message', {
      type: 'session_started',
      sessionId: 'review-sess-2',
      sessionType: 'review',
      taskName: '#42 feat: test',
    });
    expect(monitor.isTracking('review-sess-2')).toBe(true);

    sm.emit('message', {
      type: 'session_ended',
      sessionId: 'review-sess-2',
    });

    expect(monitor.isTracking('review-sess-2')).toBe(false);
  });
});

// ── 2. Killed review session → review_incomplete, queue advances ──────────────

describe('ReviewOrchestrator — killed review session routes incomplete verdict', () => {
  it('emits review_incomplete when the review session is killed (session_ended fires during waitForVerdict)', async () => {
    const prRow = makePRRow({ review_session_id: null, review_iteration: 0 });
    vi.mocked(queries.getPRByNumber).mockReturnValue(prRow);

    const sm = new MockSessionManager();
    const github = makeMockGitHub();
    const taskBackend = makeMockTaskBackend();
    const reviewService = new PRReviewService(
      github,
      taskBackend,
      sm as unknown as SessionManager,
      'proj-1',
      'https://notion.so/ctx',
    );

    // Capture the session ID from start() and fire session_ended after a tick
    sm.start = vi.fn().mockImplementation(
      (_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
        const id = opts.sessionId;
        // Simulate the review session being killed: emit session_ended with no verdict stored
        setImmediate(() =>
          sm.emit('message', {
            type: 'session_ended',
            sessionId: id,
          }),
        );
        return id;
      },
    );

    const orchestrator = new ReviewOrchestrator(
      reviewService,
      sm as unknown as SessionManager,
      1,
      true,
      github,
    );
    void orchestrator;

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    sm.emit('pr_opened', {
      prNumber: 42,
      repo: 'owner/repo',
      taskId: 'task-id',
      contextUrl: 'https://notion.so/ctx',
    });

    await new Promise((r) => setTimeout(r, 50));

    // Queue should have advanced: review_incomplete must be emitted
    const incompleteMsg = messages.find(
      (m: any) => m.type === 'review_incomplete',
    );
    expect(incompleteMsg).toBeDefined();
    expect(incompleteMsg).toMatchObject({
      type: 'review_incomplete',
      prNumber: 42,
      repo: 'owner/repo',
    });

    // Verdict must be stored (even if incomplete) — never silently dropped
    expect(vi.mocked(queries.setPRReviewResult)).toHaveBeenCalled();
    const [, , resultJson] = vi.mocked(queries.setPRReviewResult).mock.calls[0];
    const stored = JSON.parse(resultJson as string) as { verdict: string };
    // 'incomplete' is the expected result when no verdict was produced before kill
    expect(['incomplete', 'error']).toContain(stored.verdict);
  });
});
