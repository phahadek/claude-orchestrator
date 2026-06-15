/**
 * Tests for waitForVerdict bounded timeout and malformed-JSON recovery.
 *
 * Covers:
 * 1. PR #403 repro: unescaped inner quotes in manualItemsForHuman are repaired
 *    and the verdict is resolved (not an infinite hang).
 * 2. Timeout path: when no verdict arrives and session never emits session_ended,
 *    waitForVerdict resolves within the timeout (no leaked slot).
 * 3. Timeout path resolves via stored-events lenient parse when a malformed event
 *    is in the DB but no live event was parseable.
 * 4. Regression: valid approved / needs_changes verdicts still parse and resolve.
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
    fetchDiff: vi.fn().mockResolvedValue('diff --git a/foo.ts b/foo.ts\n+line'),
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

/** Build a raw session_event payload (event_type='text') containing a verdict JSON. */
function makeVerdictEventPayload(verdictJson: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: verdictJson }],
    },
  });
}

/** Valid verdict JSON with all 5 dimensions passing. */
const VALID_APPROVED_VERDICT = JSON.stringify({
  verdict: 'approved',
  dimensions: [
    { name: 'Title and description vs task Summary', passed: true, notes: 'ok' },
    { name: 'Diff vs Context spec', passed: true, notes: 'ok' },
    { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'ok' },
    { name: 'Changed files vs Files/paths affected list', passed: true, notes: 'ok' },
    { name: 'Size proportionality', passed: true, notes: 'ok' },
  ],
  summary: 'All good.',
  manualItemsForHuman: [],
});

/**
 * Malformed verdict JSON reproducing PR #403: an array element string contains
 * unescaped inner double-quotes, which terminates the string early for a strict parser.
 */
const MALFORMED_VERDICT_WITH_UNESCAPED_QUOTES = `{
  "verdict": "approved",
  "dimensions": [
    { "name": "Title and description vs task Summary", "passed": true, "notes": "ok" },
    { "name": "Diff vs Context spec", "passed": true, "notes": "ok" },
    { "name": "Diff vs Acceptance Criteria", "passed": true, "notes": "ok" },
    { "name": "Changed files vs Files/paths affected list", "passed": true, "notes": "ok" },
    { "name": "Size proportionality", "passed": true, "notes": "ok" }
  ],
  "summary": "All 5 dimensions pass.",
  "manualItemsForHuman": [
    "The IEM Cologne "events-present-markets-unlinked" divergence is visible without journal-grep."
  ]
}`;

/** Run reviewPR and fire a session event; returns resolved result. */
async function runWithEvent(
  eventPayload: string,
  timeoutMs: number = 5000,
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
    timeoutMs,
  );

  vi.mocked(queries.getPRByNumber).mockReturnValue(makePRRow());
  vi.mocked(queries.getEventsBySession).mockReturnValue([]);
  vi.mocked(queries.getSession).mockReturnValue(undefined);

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
    sessionManager.emit('message', {
      type: 'session_event',
      eventType: 'text',
      sessionId: capturedSessionId,
      content: eventPayload,
    });
  }

  return resultPromise;
}

/** Run reviewPR with a short timeout and no events — exercises the timeout path. */
async function runWithTimeout(
  storedEvents: { payload: string; event_type: string }[] = [],
  timeoutMs: number = 100,
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
    timeoutMs,
  );

  vi.mocked(queries.getPRByNumber).mockReturnValue(makePRRow());
  vi.mocked(queries.getEventsBySession).mockReturnValue(storedEvents as never);
  vi.mocked(queries.getSession).mockReturnValue(undefined);
  vi.mocked(queries.setReviewSessionId).mockImplementation(() => {});

  const workItem: WorkItem = { type: 'pr', prNumber: 42, repo: 'owner/repo' };
  // No events emitted — waits until timeout fires.
  return reviewService.reviewPR(workItem, diffSource, 'proj-1');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe('waitForVerdict — malformed JSON repair (PR #403 repro)', () => {
  it('recovers approved verdict from malformed JSON with unescaped inner quotes', async () => {
    const result = await runWithEvent(
      makeVerdictEventPayload(MALFORMED_VERDICT_WITH_UNESCAPED_QUOTES),
    );

    expect(result.verdict).toBe('approved');
    expect(result.summary).toBe('All 5 dimensions pass.');
    expect(result.dimensions).toHaveLength(5);
    expect(result.dimensions.every((d) => d.passed)).toBe(true);
    // The repaired manualItemsForHuman string should contain the unescaped text
    expect(result.manualItemsForHuman).toBeDefined();
    expect(result.manualItemsForHuman![0]).toContain('events-present-markets-unlinked');
  });
});

describe('waitForVerdict — bounded timeout (no leaked slot)', () => {
  it('resolves as incomplete within the timeout when no verdict is emitted', async () => {
    const start = Date.now();
    const result = await runWithTimeout([], 100);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);
    expect(result.verdict).toBe('incomplete');
    expect(result.summary).toContain('timed out');
  });

  it('resolves via stored-events repair parse on timeout when malformed event is stored', async () => {
    const storedEvent = {
      event_type: 'text',
      payload: makeVerdictEventPayload(MALFORMED_VERDICT_WITH_UNESCAPED_QUOTES),
    };

    const result = await runWithTimeout([storedEvent], 100);

    // The repair parse on stored events should recover the approved verdict.
    expect(result.verdict).toBe('approved');
    expect(result.summary).toBe('All 5 dimensions pass.');
  });
});

describe('waitForVerdict — regression: valid verdicts still parse', () => {
  it('resolves approved verdict from valid JSON without repair', async () => {
    const result = await runWithEvent(makeVerdictEventPayload(VALID_APPROVED_VERDICT));

    expect(result.verdict).toBe('approved');
    expect(result.dimensions).toHaveLength(5);
    expect(result.dimensions.every((d) => d.passed)).toBe(true);
  });

  it('resolves needs_changes verdict from valid JSON', async () => {
    const verdictJson = JSON.stringify({
      verdict: 'needs_changes',
      dimensions: [
        { name: 'Title and description vs task Summary', passed: false, notes: 'Missing scope' },
        { name: 'Diff vs Context spec', passed: true, notes: 'ok' },
        { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'ok' },
        { name: 'Changed files vs Files/paths affected list', passed: true, notes: 'ok' },
        { name: 'Size proportionality', passed: true, notes: 'ok' },
      ],
      summary: 'Title is missing the required scope prefix.',
      manualItemsForHuman: [],
    });

    const result = await runWithEvent(makeVerdictEventPayload(verdictJson));

    expect(result.verdict).toBe('needs_changes');
    expect(result.summary).toBe('Title is missing the required scope prefix.');
  });

  it('resolves when session ends and stored events contain valid verdict', async () => {
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
      5000,
    );

    const storedEvent = {
      event_type: 'text',
      payload: makeVerdictEventPayload(VALID_APPROVED_VERDICT),
    };

    vi.mocked(queries.getPRByNumber).mockReturnValue(makePRRow());
    vi.mocked(queries.getEventsBySession).mockReturnValue([storedEvent] as never);
    vi.mocked(queries.getSession).mockReturnValue(undefined);

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
      sessionManager.emit('message', {
        type: 'session_ended',
        sessionId: capturedSessionId,
        status: 'done',
      });
    }

    const result = await resultPromise;
    expect(result.verdict).toBe('approved');
  });
});
