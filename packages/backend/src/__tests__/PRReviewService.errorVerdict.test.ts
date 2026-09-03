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
  clearReviewSessionId: vi.fn(),
  updatePRDraftStatus: vi.fn(),
  incrementReviewIteration: vi.fn(),
  setLastReviewedSha: vi.fn(),
  setLocalBranchReviewResult: vi.fn(),
  getLocalBranchById: vi.fn(),
  getSession: vi.fn().mockReturnValue(undefined),
  getPRIntentForPR: vi.fn().mockReturnValue(null),
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
import * as auditLog from '../audit/AuditLog.js';
import type { GitHubClient } from '../github/GitHubClient.js';
import type { TaskTrackerBackend } from '../tasks/TaskTrackerBackend.js';
import type { PullRequestRow } from '../db/types.js';
import type { WorkItem } from '../github/PRReviewService.js';
import type { SessionEvent } from '../db/types.js';

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
    fetchDiff: vi.fn().mockResolvedValue({
      prId: 42,
      diff: 'diff --git a/foo.ts',
      filesChanged: [],
    }),
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
    type: 'yaml',
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
  sessionRow:
    | {
        status: string;
        pause_reason: string | null;
        last_error_detail: string | null;
      }
    | undefined,
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

/**
 * Starts a reviewPR call, then emits a review_verdict_recorded event (the
 * live shape of a review.verdict MCP tool call) followed by a prose text
 * session_event and a session_ended — reproducing a session that calls the
 * tool and then narrates a closing summary. Returns the resolved result.
 */
async function runReviewWithToolVerdict(
  verdict: {
    verdict: 'approved' | 'needs_changes' | 'incomplete' | 'error';
    dimensions: Array<{ name: string; passed: boolean; notes?: string }>;
    summary: string;
  },
  proseText: string,
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
  vi.mocked(queries.getEventsBySession).mockReturnValue([] as never);
  vi.mocked(queries.getSession).mockReturnValue(undefined as never);

  let capturedSessionId: string | undefined;
  vi.mocked(queries.setReviewSessionId).mockImplementation(
    (_prNumber: number, _repo: string, sessionId: string) => {
      capturedSessionId = sessionId;
    },
  );

  const workItem: WorkItem = { type: 'pr', prNumber: 42, repo: 'owner/repo' };
  const resultPromise = reviewService.reviewPR(workItem, diffSource, 'proj-1');

  await new Promise((r) => setTimeout(r, 20));

  if (capturedSessionId) {
    sessionManager.emit('review_verdict_recorded', {
      sessionId: capturedSessionId,
      prNumber: 42,
      repo: 'owner/repo',
      headSha: 'abc123',
      verdict,
    });

    // The session keeps narrating after the tool call — a prose closing
    // block, not JSON — which the text-parsing fallback would otherwise
    // treat as the last assistant message.
    sessionManager.emit('message', {
      type: 'session_event',
      sessionId: capturedSessionId,
      eventType: 'text',
      content: JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: proseText }] },
      }),
    });

    sessionManager.emit('message', {
      type: 'session_ended',
      sessionId: capturedSessionId,
      status: 'done',
    });
  }

  return resultPromise;
}

/** Build a stored assistant text event containing the given text. */
function assistantTextEvent(text: string): SessionEvent {
  return {
    id: 1,
    session_id: 'sess',
    event_type: 'text',
    payload: JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    }),
    created_at: '2024-01-01T00:00:00Z',
  } as unknown as SessionEvent;
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

describe('PRReviewService tool-submitted verdict preference', () => {
  it('resolves with the tool-submitted verdict, not a later prose text block', async () => {
    // Uses needs_changes (not approved) so the result is asserted directly,
    // without also exercising the approved-verdict side-effect path
    // (handleApprovedVerdict), which is orthogonal to what this test covers.
    const result = await runReviewWithToolVerdict(
      {
        verdict: 'needs_changes',
        dimensions: [{ name: 'Tests', passed: false, notes: 'flaky test' }],
        summary: 'Tool-submitted verdict summary',
      },
      'Great, the review is complete and everything looks fine! No issues found.',
    );

    expect(result.verdict).toBe('needs_changes');
    expect(result.dimensions).toEqual([
      { name: 'Tests', passed: false, notes: 'flaky test' },
    ]);
    expect(result.summary).toBe('Tool-submitted verdict summary');
    expect(result.verdict).not.toBe('incomplete');
  });

  it('does not record a review_verdict_parse_fallback audit event when the tool verdict wins', async () => {
    await runReviewWithToolVerdict(
      {
        verdict: 'needs_changes',
        dimensions: [{ name: 'Tests', passed: false, notes: 'broken' }],
        summary: 'Needs changes.',
      },
      'Wrapping up now.',
    );

    expect(auditLog.recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'review_verdict_parse_fallback' }),
    );
  });
});

describe('PRReviewService parse-fallback audit event', () => {
  function makeService(): PRReviewService {
    const github = makeMockGitHub();
    const taskBackend = makeMockTaskBackend();
    const sessionManager = new MockSessionManager();
    return new PRReviewService(
      github,
      taskBackend,
      sessionManager as unknown as InstanceType<
        typeof import('../session/SessionManager.js').SessionManager
      >,
      'proj-1',
      'https://notion.so/ctx',
    );
  }

  it('records verdict incomplete with empty dimensions when no verdict is recoverable', () => {
    const service = makeService();
    const events = [
      assistantTextEvent('Just reading the diff, no verdict yet.'),
    ];

    const result = service.parseReviewResult(
      events,
      42,
      'owner/repo',
      'sess-1',
    );

    expect(result.verdict).toBe('incomplete');
    expect(result.dimensions).toEqual([]);
  });

  it('records a review_verdict_parse_fallback audit event naming the session and PR when the fallback fires', () => {
    const service = makeService();
    const events = [
      assistantTextEvent('Just reading the diff, no verdict yet.'),
    ];

    service.parseReviewResult(events, 42, 'owner/repo', 'sess-1');

    expect(auditLog.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'review_verdict_parse_fallback',
        payload: expect.objectContaining({
          sessionId: 'sess-1',
          prNumber: 42,
          repo: 'owner/repo',
        }),
      }),
    );
  });

  it('does not record the audit event when a verdict is successfully recovered from an earlier text block', () => {
    const service = makeService();
    const verdictJson = JSON.stringify({
      verdict: 'approved',
      dimensions: [{ name: 'Diff vs Context spec', passed: true, notes: '' }],
      summary: 'All good.',
    });
    const toolCallOnlyEvent: SessionEvent = {
      id: 2,
      session_id: 'sess',
      event_type: 'text',
      payload: JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu1', name: 'read_file', input: {} },
          ],
        },
      }),
      created_at: '2024-01-01T00:00:01Z',
    } as unknown as SessionEvent;
    const events = [assistantTextEvent(verdictJson), toolCallOnlyEvent];

    const result = service.parseReviewResult(
      events,
      42,
      'owner/repo',
      'sess-1',
    );

    expect(result.verdict).toBe('approved');
    expect(auditLog.recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'review_verdict_parse_fallback' }),
    );
  });

  it('does not record the audit event when no sessionId is passed', () => {
    const service = makeService();
    const events = [
      assistantTextEvent('Just reading the diff, no verdict yet.'),
    ];

    service.parseReviewResult(events, 42, 'owner/repo');

    expect(auditLog.recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'review_verdict_parse_fallback' }),
    );
  });
});

describe('PRReviewService verdict idempotency per head SHA', () => {
  function makeAliveSessionManager(sessionId: string): MockSessionManager {
    const sm = new MockSessionManager();
    sm.isAlive = vi.fn((id: string) => id === sessionId);
    sm.send = vi.fn().mockReturnValue(true);
    return sm;
  }

  it('keeps a recorded approved verdict when a same-head verdict resolves incomplete, and records a suppression audit event', async () => {
    const sessionManager = makeAliveSessionManager('live-session');
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

    const priorApproved = JSON.stringify({
      prNumber: 42,
      repo: 'owner/repo',
      verdict: 'approved',
      dimensions: [],
      summary: 'Looks good',
      reviewedAt: '2024-01-01T00:00:00Z',
    });
    vi.mocked(queries.getPRByNumber).mockReturnValue(
      makePRRow({
        review_session_id: 'live-session',
        last_reviewed_sha: 'abc123', // matches makeMockGitHub's fetchPR headSha
        review_result: priorApproved,
      }),
    );

    const workItem: WorkItem = { type: 'pr', prNumber: 42, repo: 'owner/repo' };
    const resultPromise = reviewService.reviewPR(workItem, diffSource, 'proj-1');

    await new Promise((r) => setTimeout(r, 20));

    // Simulates the timeout-recovery path resolving to incomplete for the
    // same head that already has a complete, tool-submitted verdict on file.
    sessionManager.emit('review_verdict_recorded', {
      sessionId: 'live-session',
      prNumber: 42,
      repo: 'owner/repo',
      headSha: 'abc123',
      verdict: {
        verdict: 'incomplete',
        dimensions: [],
        summary: 'Review verdict timed out after 25 min.',
      },
    });

    const result = await resultPromise;

    expect(result.verdict).toBe('approved');
    expect(result.summary).toBe('Looks good');
    expect(queries.setPRReviewResult).not.toHaveBeenCalled();
    expect(auditLog.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'review_verdict_overwrite_suppressed',
        payload: expect.objectContaining({
          pr_number: 42,
          repo: 'owner/repo',
          head_sha: 'abc123',
          suppressed_verdict: 'incomplete',
          kept_verdict: 'approved',
        }),
      }),
    );
    // A suppressed verdict must never flow onward as if it were a real
    // incomplete result — nothing should attempt to reopen a terminal
    // session to deliver it.
    expect(auditLog.recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'session_terminal_reopened' }),
    );
  });

  it('still overwrites an older approved verdict when a genuine tool-submitted verdict targets a new head', async () => {
    const sessionManager = makeAliveSessionManager('live-session');
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

    vi.mocked(queries.getPRByNumber).mockReturnValue(
      makePRRow({
        review_session_id: 'live-session',
        last_reviewed_sha: 'old-sha', // differs from the new headSha 'abc123'
        review_result: JSON.stringify({
          prNumber: 42,
          repo: 'owner/repo',
          verdict: 'approved',
          dimensions: [],
          summary: 'Previously approved',
        }),
      }),
    );

    const workItem: WorkItem = { type: 'pr', prNumber: 42, repo: 'owner/repo' };
    const resultPromise = reviewService.reviewPR(workItem, diffSource, 'proj-1');

    await new Promise((r) => setTimeout(r, 20));

    sessionManager.emit('review_verdict_recorded', {
      sessionId: 'live-session',
      prNumber: 42,
      repo: 'owner/repo',
      headSha: 'abc123',
      verdict: {
        verdict: 'needs_changes',
        dimensions: [{ name: 'Tests', passed: false, notes: 'broken' }],
        summary: 'New commits broke something.',
      },
    });

    const result = await resultPromise;

    expect(result.verdict).toBe('needs_changes');
    expect(queries.setPRReviewResult).toHaveBeenCalledWith(
      42,
      'owner/repo',
      expect.stringContaining('needs_changes'),
    );
    expect(auditLog.recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'review_verdict_overwrite_suppressed' }),
    );
  });
});

describe('PRReviewService reReviewPR terminal-session handling', () => {
  it('resolves from the recorded verdict without calling sendOrResume when the review session is done and the head matches last_reviewed_sha', async () => {
    const sessionManager = new MockSessionManager();
    const github = makeMockGitHub();
    const taskBackend = makeMockTaskBackend();
    const reviewService = new PRReviewService(
      github,
      taskBackend,
      sessionManager as unknown as InstanceType<
        typeof import('../session/SessionManager.js').SessionManager
      >,
      'proj-1',
      'https://notion.so/ctx',
    );

    vi.mocked(queries.getPRByNumber).mockReturnValue(
      makePRRow({
        review_session_id: 'done-session',
        last_reviewed_sha: 'abc123', // matches makeMockGitHub's fetchPR headSha
        review_result: JSON.stringify({
          verdict: 'needs_changes',
          dimensions: [],
          summary: 'fix x',
        }),
      }),
    );
    vi.mocked(queries.getSession).mockReturnValue({ status: 'done' } as never);

    const result = await reviewService.reReviewPR(
      42,
      'owner/repo',
      'proj-1',
      'https://notion.so/ctx',
    );

    expect(result.verdict).toBe('needs_changes');
    expect(sessionManager.sendOrResume).not.toHaveBeenCalled();
  });

  it('launches a fresh review session instead of a follow-up when the review session is done and the head has changed', async () => {
    const sessionManager = new MockSessionManager();
    const github = makeMockGitHub();
    const taskBackend = makeMockTaskBackend();
    const reviewService = new PRReviewService(
      github,
      taskBackend,
      sessionManager as unknown as InstanceType<
        typeof import('../session/SessionManager.js').SessionManager
      >,
      'proj-1',
      'https://notion.so/ctx',
    );

    vi.mocked(queries.getPRByNumber).mockReturnValue(
      makePRRow({
        review_session_id: 'done-session',
        last_reviewed_sha: 'old-sha', // differs from headSha 'abc123'
        review_result: JSON.stringify({
          verdict: 'needs_changes',
          dimensions: [],
          summary: 'fix x',
        }),
      }),
    );
    vi.mocked(queries.getSession).mockReturnValue({ status: 'done' } as never);

    const resultPromise = reviewService.reReviewPR(
      42,
      'owner/repo',
      'proj-1',
      'https://notion.so/ctx',
    );

    await new Promise((r) => setTimeout(r, 20));

    expect(sessionManager.sendOrResume).not.toHaveBeenCalled();
    expect(sessionManager.start).toHaveBeenCalled();
    expect(queries.clearReviewSessionId).toHaveBeenCalledWith(42, 'owner/repo');

    const startCall = sessionManager.start.mock.calls[0] as [
      string,
      string,
      { sessionId: string },
    ];
    const startedSessionId = startCall[2].sessionId;
    sessionManager.emit('review_verdict_recorded', {
      sessionId: startedSessionId,
      prNumber: 42,
      repo: 'owner/repo',
      headSha: 'abc123',
      verdict: { verdict: 'approved', dimensions: [], summary: 'Now fine' },
    });

    const result = await resultPromise;
    expect(result.verdict).toBe('approved');
  });

  it('is a no-op with an audit row when the PR is merged', async () => {
    const sessionManager = new MockSessionManager();
    const github = makeMockGitHub();
    const taskBackend = makeMockTaskBackend();
    const reviewService = new PRReviewService(
      github,
      taskBackend,
      sessionManager as unknown as InstanceType<
        typeof import('../session/SessionManager.js').SessionManager
      >,
      'proj-1',
      'https://notion.so/ctx',
    );

    vi.mocked(queries.getPRByNumber).mockReturnValue(
      makePRRow({
        state: 'merged',
        review_session_id: 'some-session',
        review_result: JSON.stringify({
          verdict: 'approved',
          dimensions: [],
          summary: 'ok',
        }),
      }),
    );

    const result = await reviewService.reReviewPR(
      42,
      'owner/repo',
      'proj-1',
      'https://notion.so/ctx',
    );

    expect(result.verdict).toBe('approved');
    expect(sessionManager.sendOrResume).not.toHaveBeenCalled();
    expect(sessionManager.start).not.toHaveBeenCalled();
    expect(github.fetchPR).not.toHaveBeenCalled();
    expect(auditLog.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 're_review_skipped_pr_terminal',
        payload: expect.objectContaining({
          pr_number: 42,
          repo: 'owner/repo',
          state: 'merged',
        }),
      }),
    );
  });
});
