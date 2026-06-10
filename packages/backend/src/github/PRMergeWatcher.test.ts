import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () => ({
  getAllOpenPRs: vi.fn().mockReturnValue([]),
  updatePRState: vi.fn(),
  updateMergeState: vi.fn(),
  setPauseReason: vi.fn(),
  setCiRemediationAttemptedSha: vi.fn(),
  getPRByNumber: vi.fn().mockReturnValue(null),
  getSession: vi.fn().mockReturnValue(null),
  addAutofixSha: vi.fn(),
  consumeAutofixSha: vi.fn().mockReturnValue(false),
  deleteAllAutofixShasForPR: vi.fn(),
  setHeadSha: vi.fn(),
  setLastReviewedSha: vi.fn(),
  setPRReviewResult: vi.fn(),
  setPendingPush: vi.fn(),
  getSetting: vi.fn().mockReturnValue(null),
  getTestResult: vi.fn().mockReturnValue(undefined),
  markSessionDone: vi.fn(),
  setPreReviewStage: vi.fn(),
  setConflictNudgeSha: vi.fn(),
}));

vi.mock('../config.js', () => ({
  getProjectByGithubRepo: vi.fn().mockReturnValue(null),
  AUTO_REVIEW_ENABLED: true,
}));

vi.mock('../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi
    .fn()
    .mockReturnValue({ ci_check_name: [], test: [], test_timeout_sec: 300 }),
}));

vi.mock('../session/autofix-runner.js', () => ({
  loadAutofixCommands: vi.fn().mockReturnValue([]),
  runAutofix: vi.fn().mockResolvedValue({ success: true, summary: 'no diff' }),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

import { PRMergeWatcher } from './PRMergeWatcher';
import {
  getAllOpenPRs,
  updatePRState,
  updateMergeState,
  setPauseReason,
  setCiRemediationAttemptedSha,
  getPRByNumber,
  getSession,
  addAutofixSha,
  consumeAutofixSha,
  deleteAllAutofixShasForPR,
  setHeadSha,
  getTestResult,
  markSessionDone,
  setPendingPush,
  setConflictNudgeSha,
} from '../db/queries';
import { loadAutofixCommands, runAutofix } from '../session/autofix-runner';
import { loadOrchestratorConfig } from '../session/orchestrator-config';
import { recordEvent } from '../audit/AuditLog';
import { getProjectByGithubRepo } from '../config';
import type { AutoMerger } from './AutoMerger';
import type { GitHubClient } from './GitHubClient';
import type { SessionManager } from '../session/SessionManager';
import type { NotionClient } from '../notion/NotionClient';
import type { PRReviewService, PRReviewResult } from './PRReviewService';
import type { ReviewOrchestrator } from './ReviewOrchestrator';
import type { ServerMessage } from '../ws/types';
import type { PullRequestRow } from '../db/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockGitHub(): GitHubClient {
  return {
    getPRState: vi.fn().mockResolvedValue({ state: 'open', headSha: null }),
    getMergeability: vi
      .fn()
      .mockResolvedValue({ mergeable: null, mergeableState: null }),
    getMergeabilityWithRetry: vi
      .fn()
      .mockResolvedValue({ mergeable: null, mergeableState: null }),
    getFailingChecks: vi.fn().mockResolvedValue([]),
    fetchPR: vi.fn().mockResolvedValue({ headSha: null }),
    // Default: GitHub still computing — watcher should skip.
    categorizeMergeability: vi.fn().mockResolvedValue({
      category: 'unknown',
      mergeState: 'unknown',
      rawMergeableState: null,
      failingChecks: [],
      headSha: null,
    }),
  } as unknown as GitHubClient;
}

function makeMockPRReviewService(
  result: Partial<PRReviewResult> = {},
): PRReviewService {
  return {
    reReviewPR: vi.fn().mockResolvedValue({
      verdict: 'approved',
      summary: 'Looks good',
      dimensions: [],
      prNumber: 42,
      repo: 'owner/repo',
      reviewedAt: new Date().toISOString(),
      ...result,
    }),
  } as unknown as PRReviewService;
}

function makeMockReviewOrchestrator(): ReviewOrchestrator {
  return {
    runAutofixPipeline: vi.fn().mockResolvedValue(undefined),
    consumeAutofixSha: vi.fn().mockReturnValue(false),
    runTestPipeline: vi.fn().mockResolvedValue(undefined),
    isReviewInFlight: vi.fn().mockReturnValue(false),
    enqueueReview: vi.fn(),
  } as unknown as ReviewOrchestrator;
}

function makeMockSessions(): SessionManager {
  return {
    endSession: vi.fn(),
    sendOrResume: vi.fn().mockResolvedValue('session-id'),
    markSessionErrored: vi.fn(),
    markForBranchDeletion: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  } as unknown as SessionManager;
}

function makeMockNotion(): NotionClient {
  return {
    updateStatus: vi.fn().mockResolvedValue(undefined),
  } as unknown as NotionClient;
}

function makeMockAutoMerger(): AutoMerger {
  return {
    attempt: vi.fn(),
  } as unknown as AutoMerger;
}

function makePRRow(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: 42,
    pr_url: 'https://github.com/owner/repo/pull/42',
    task_id: 'notion:task-abc',
    session_id: 'coding-session',
    repo: 'owner/repo',
    title: 'feat: test',
    body: null,
    head_branch: 'feature/test',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: JSON.stringify({
      verdict: 'approved',
      dimensions: [],
      summary: 'Looks good',
    }),
    review_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    synced_at: '2024-01-01T00:00:00Z',
    review_session_id: 'review-session',
    review_iteration: 1,
    head_sha: null,
    last_reviewed_sha: null,
    node_id: null,
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
    failing_checks: null,
    pending_push: 0,
    pause_reason: null,
    ci_remediation_attempted_sha: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── poll() ────────────────────────────────────────────────────────────────────

describe('PRMergeWatcher.poll()', () => {
  it('does not call getPRState when there are no open PRs', async () => {
    vi.mocked(getAllOpenPRs).mockReturnValue([]);
    const github = makeMockGitHub();

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(github.getPRState)).not.toHaveBeenCalled();
  });

  it('calls getPRState for each open PR', async () => {
    const pr = makePRRow();
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(github.getPRState)).toHaveBeenCalledWith(42, 'owner/repo');
  });

  it('checks PRs with no review verdict (review_result IS NULL)', async () => {
    const pr = makePRRow({ review_result: null });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(github.getPRState)).toHaveBeenCalledWith(42, 'owner/repo');
  });

  it('checks PRs with needs_changes verdict', async () => {
    const pr = makePRRow({
      review_result: JSON.stringify({
        verdict: 'needs_changes',
        dimensions: [],
        summary: 'Fix required',
      }),
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(github.getPRState)).toHaveBeenCalledWith(42, 'owner/repo');
  });

  it('checks PRs with error verdict', async () => {
    const pr = makePRRow({
      review_result: JSON.stringify({
        verdict: 'error',
        dimensions: [],
        summary: 'Review failed',
      }),
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(github.getPRState)).toHaveBeenCalledWith(42, 'owner/repo');
  });

  it('merged PR without approved verdict still triggers session kill and Notion update', async () => {
    const pr = makePRRow({
      review_result: null,
      session_id: 'coding-session',
      review_session_id: 'review-session',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    vi.mocked(github.getPRState).mockResolvedValue({
      state: 'merged',
      headSha: null,
    });
    const sessions = makeMockSessions();
    const notion = makeMockNotion();

    const watcher = new PRMergeWatcher(github, sessions, notion, () => {});
    await watcher.poll();

    expect(vi.mocked(updatePRState)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'merged',
    );
    expect(vi.mocked(sessions.endSession)).toHaveBeenCalledWith(
      'coding-session',
    );
    expect(vi.mocked(sessions.endSession)).toHaveBeenCalledWith(
      'review-session',
    );
    expect(vi.mocked(notion.updateStatus)).toHaveBeenCalledWith(
      'notion:task-abc',
      '✅ Done',
    );
  });

  it('merged PR with needs_changes verdict triggers session end and Notion update', async () => {
    const pr = makePRRow({
      review_result: JSON.stringify({ verdict: 'needs_changes' }),
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    vi.mocked(github.getPRState).mockResolvedValue({
      state: 'merged',
      headSha: null,
    });
    const sessions = makeMockSessions();
    const notion = makeMockNotion();

    const watcher = new PRMergeWatcher(github, sessions, notion, () => {});
    await watcher.poll();

    expect(vi.mocked(updatePRState)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'merged',
    );
    expect(vi.mocked(sessions.endSession)).toHaveBeenCalledWith(
      'coding-session',
    );
    expect(vi.mocked(notion.updateStatus)).toHaveBeenCalledWith(
      'notion:task-abc',
      '✅ Done',
    );
  });

  it('calls handleMerged when GitHub state is merged', async () => {
    const pr = makePRRow();
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    vi.mocked(github.getPRState).mockResolvedValue({
      state: 'merged',
      headSha: null,
    });
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(updatePRState)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'merged',
    );
    expect(vi.mocked(sessions.endSession)).toHaveBeenCalledWith(
      'coding-session',
    );
    expect(vi.mocked(sessions.endSession)).toHaveBeenCalledWith(
      'review-session',
    );
  });

  it('broadcasts pr_closed and updates state when GitHub state is closed', async () => {
    const pr = makePRRow();
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    vi.mocked(github.getPRState).mockResolvedValue({
      state: 'closed',
      headSha: null,
    });

    const messages: ServerMessage[] = [];
    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      (msg) => messages.push(msg),
    );
    await watcher.poll();

    expect(vi.mocked(updatePRState)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'closed',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'pr_closed',
      prNumber: 42,
      repo: 'owner/repo',
    });
  });
});

// ── PR closed — session terminal transition ───────────────────────────────────

describe('PRMergeWatcher — idle→error session transition on PR close', () => {
  function makeWatcherForClosedPR(
    pr: PullRequestRow,
    sessions: SessionManager,
  ): PRMergeWatcher {
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    vi.mocked(github.getPRState).mockResolvedValue({
      state: 'closed',
      headSha: null,
    });
    vi.mocked(getProjectByGithubRepo).mockReturnValue({} as never);
    return new PRMergeWatcher(github, sessions, undefined, () => {});
  }

  it('calls markSessionErrored with pr_closed reason for the coding session', async () => {
    const pr = makePRRow({
      session_id: 'coding-session',
      review_session_id: null,
    });
    const sessions = makeMockSessions();

    const watcher = makeWatcherForClosedPR(pr, sessions);
    await watcher.poll();

    expect(vi.mocked(sessions.markSessionErrored)).toHaveBeenCalledWith(
      'coding-session',
      'error',
      'pr_closed',
    );
  });

  it('ends review session when PR is closed', async () => {
    const pr = makePRRow({
      session_id: 'coding-session',
      review_session_id: 'review-session',
    });
    const sessions = makeMockSessions();

    const watcher = makeWatcherForClosedPR(pr, sessions);
    await watcher.poll();

    expect(vi.mocked(sessions.endSession)).toHaveBeenCalledWith(
      'review-session',
    );
  });

  it('does not call markSessionErrored when closed PR has no session_id', async () => {
    const pr = makePRRow({ session_id: null });
    const sessions = makeMockSessions();

    const watcher = makeWatcherForClosedPR(pr, sessions);
    await watcher.poll();

    expect(vi.mocked(sessions.markSessionErrored)).not.toHaveBeenCalled();
  });
});

// ── checkMergeability / dirty transition ─────────────────────────────────────

describe('PRMergeWatcher dirty-transition sendOrResume', () => {
  function mockCategorize(
    github: GitHubClient,
    value: {
      category: 'clean' | 'conflict' | 'ci_failed' | 'blocked' | 'unknown';
      mergeState: string;
      rawMergeableState: string | null;
      failingChecks: Array<{ name: string; conclusion: string }>;
    },
  ): void {
    vi.mocked(
      (
        github as unknown as {
          categorizeMergeability: (n: number, r: string) => Promise<unknown>;
        }
      ).categorizeMergeability,
    ).mockResolvedValue(value);
  }

  it('calls sendOrResume when conflict detected (SHA-keyed dedup, not transition-gated)', async () => {
    const pr = makePRRow({
      merge_state: 'clean',
      session_id: 'coding-session',
      base_branch: 'dev',
      head_sha: 'sha-abc',
      conflict_nudge_sha: null,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorize(github, {
      category: 'conflict',
      mergeState: 'dirty',
      rawMergeableState: 'dirty',
      failingChecks: [],
    });
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(sessions.sendOrResume)).toHaveBeenCalledWith(
      'coding-session',
      expect.stringContaining('Rebase'),
    );
    expect(vi.mocked(setConflictNudgeSha)).toHaveBeenCalledWith(42, 'owner/repo', 'sha-abc');
  });

  it('does NOT call sendOrResume when conflict_nudge_sha matches head_sha (SHA dedup)', async () => {
    const pr = makePRRow({
      merge_state: 'dirty',
      session_id: 'coding-session',
      head_sha: 'sha-abc',
      conflict_nudge_sha: 'sha-abc',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorize(github, {
      category: 'conflict',
      mergeState: 'dirty',
      rawMergeableState: 'dirty',
      failingChecks: [],
    });
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(sessions.sendOrResume)).not.toHaveBeenCalled();
  });

  it('does NOT call sendOrResume when PR has no session_id', async () => {
    const pr = makePRRow({ merge_state: 'clean', session_id: null });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorize(github, {
      category: 'conflict',
      mergeState: 'dirty',
      rawMergeableState: 'dirty',
      failingChecks: [],
    });
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(sessions.sendOrResume)).not.toHaveBeenCalled();
  });
});

// ── mergeability category branches ───────────────────────────────────────────

describe('PRMergeWatcher categorization branches', () => {
  function mockCategorize(
    github: GitHubClient,
    value: {
      category: 'clean' | 'conflict' | 'ci_failed' | 'blocked' | 'unknown';
      mergeState: string;
      rawMergeableState: string | null;
      failingChecks: Array<{ name: string; conclusion: string }>;
    },
  ): void {
    vi.mocked(
      (
        github as unknown as {
          categorizeMergeability: (n: number, r: string) => Promise<unknown>;
        }
      ).categorizeMergeability,
    ).mockResolvedValue(value);
  }

  it('messages session with structured CI failure format when transitioning to ci_failed', async () => {
    const pr = makePRRow({
      merge_state: 'clean',
      session_id: 'coding-session',
      head_sha: 'abc123', // non-null sha so per-SHA dedup fires on first observation
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorize(github, {
      category: 'ci_failed',
      mergeState: 'ci_failed',
      rawMergeableState: 'unstable',
      failingChecks: [
        { name: 'lint', conclusion: 'failure' },
        { name: 'unit', conclusion: 'failure' },
      ],
    });
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    const sentMessage = vi.mocked(sessions.sendOrResume).mock
      .calls[0][1] as string;
    // Structured format: heading with PR number
    expect(sentMessage).toMatch(/## CI Failure — PR #42/);
    // Failing check names rendered as list items
    expect(sentMessage).toContain('- lint');
    expect(sentMessage).toContain('- unit');
    // GitHub checks URL present
    expect(sentMessage).toContain(
      'https://github.com/owner/repo/pull/42/checks',
    );
    // Instruction block present
    expect(sentMessage).toMatch(/investigate the failures and push a fix/i);
    // NOT the legacy plain-text format
    expect(sentMessage).not.toMatch(/CI checks are failing.*lint, unit/);

    expect(vi.mocked(updateMergeState)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      0,
      'ci_failed',
      ['lint', 'unit'],
    );
  });

  it('does NOT message session for blocked category (requires human action)', async () => {
    const pr = makePRRow({
      merge_state: 'clean',
      session_id: 'coding-session',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorize(github, {
      category: 'blocked',
      mergeState: 'blocked',
      rawMergeableState: 'blocked',
      failingChecks: [],
    });
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(sessions.sendOrResume)).not.toHaveBeenCalled();
    expect(vi.mocked(updateMergeState)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      0,
      'blocked',
      null,
    );
  });

  it('broadcasts pr_mergeability_changed with failingChecks for ci_failed', async () => {
    const pr = makePRRow({
      merge_state: 'clean',
      session_id: 'coding-session',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorize(github, {
      category: 'ci_failed',
      mergeState: 'ci_failed',
      rawMergeableState: 'blocked',
      failingChecks: [{ name: 'typecheck', conclusion: 'failure' }],
    });
    const messages: ServerMessage[] = [];
    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      (m) => messages.push(m),
    );

    await watcher.poll();

    const event = messages.find((m) => m.type === 'pr_mergeability_changed');
    expect(event).toBeDefined();
    expect(event).toMatchObject({
      mergeState: 'ci_failed',
      failingChecks: ['typecheck'],
      mergeable: false,
    });
  });

  it('skips update when GitHub reports unknown with no raw state (still computing)', async () => {
    const pr = makePRRow({ merge_state: 'clean' });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorize(github, {
      category: 'unknown',
      mergeState: 'unknown',
      rawMergeableState: null,
      failingChecks: [],
    });
    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );

    await watcher.poll();

    expect(vi.mocked(updateMergeState)).not.toHaveBeenCalled();
  });

  it('updates DB (but not session) when failing-check names change without state change', async () => {
    const pr = makePRRow({
      merge_state: 'ci_failed',
      session_id: 'coding-session',
      failing_checks: JSON.stringify(['old-check']),
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorize(github, {
      category: 'ci_failed',
      mergeState: 'ci_failed',
      rawMergeableState: 'unstable',
      failingChecks: [{ name: 'new-check', conclusion: 'failure' }],
    });
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(updateMergeState)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      0,
      'ci_failed',
      ['new-check'],
    );
    expect(vi.mocked(sessions.sendOrResume)).not.toHaveBeenCalled();
  });
});

// ── handleMerged() ────────────────────────────────────────────────────────────

describe('PRMergeWatcher.handleMerged()', () => {
  it('updates PR state to merged', async () => {
    const pr = makePRRow();
    const watcher = new PRMergeWatcher(
      makeMockGitHub(),
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    await watcher.handleMerged(pr, 'abc123');

    expect(vi.mocked(updatePRState)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'merged',
    );
  });

  it('broadcasts pr_merged with sha', async () => {
    const pr = makePRRow({ task_id: null });
    const messages: ServerMessage[] = [];
    const watcher = new PRMergeWatcher(
      makeMockGitHub(),
      makeMockSessions(),
      makeMockNotion(),
      (msg) => messages.push(msg),
    );
    await watcher.handleMerged(pr, 'deadbeef');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'pr_merged',
      prNumber: 42,
      repo: 'owner/repo',
      sha: 'deadbeef',
    });
  });

  it('calls NotionClient.updateStatus with Done', async () => {
    const pr = makePRRow({ task_id: 'notion:task-xyz' });
    const notion = makeMockNotion();
    const watcher = new PRMergeWatcher(
      makeMockGitHub(),
      makeMockSessions(),
      notion,
      () => {},
    );
    await watcher.handleMerged(pr, null);

    expect(vi.mocked(notion.updateStatus)).toHaveBeenCalledWith(
      'notion:task-xyz',
      '✅ Done',
    );
  });

  it('suppresses pr_merged broadcast when called with silent: true', async () => {
    const pr = makePRRow({ task_id: null });
    const messages: ServerMessage[] = [];
    const watcher = new PRMergeWatcher(
      makeMockGitHub(),
      makeMockSessions(),
      makeMockNotion(),
      (msg) => messages.push(msg),
    );
    await watcher.handleMerged(pr, 'abc123', { silent: true });

    // State still updates, sessions still end, but no pr_merged broadcast
    expect(vi.mocked(updatePRState)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'merged',
    );
    expect(messages.filter((m) => m.type === 'pr_merged')).toHaveLength(0);
  });

  it('calls markSessionDone for the code session on merge (idle → done)', async () => {
    const pr = makePRRow({
      session_id: 'sess-idle-123',
      pr_url: 'https://github.com/owner/repo/pull/42',
    });
    const watcher = new PRMergeWatcher(
      makeMockGitHub(),
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    await watcher.handleMerged(pr, 'abc123');

    expect(vi.mocked(markSessionDone)).toHaveBeenCalledWith(
      'sess-idle-123',
      expect.any(Number),
      'https://github.com/owner/repo/pull/42',
    );
  });

  it('does not call markSessionDone when session_id is null', async () => {
    const pr = makePRRow({ session_id: null });
    const watcher = new PRMergeWatcher(
      makeMockGitHub(),
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    await watcher.handleMerged(pr, 'abc123');

    expect(vi.mocked(markSessionDone)).not.toHaveBeenCalled();
  });
});

// ── first-poll-after-boot suppression ────────────────────────────────────────

describe('PRMergeWatcher first-poll-after-boot suppression', () => {
  it('does NOT broadcast pr_merged on the first poll for PRs that GitHub reports as merged', async () => {
    const pr = makePRRow({ task_id: null });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    vi.mocked(github.getPRState).mockResolvedValue({
      state: 'merged',
      headSha: null,
    });

    const messages: ServerMessage[] = [];
    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      (msg) => messages.push(msg),
    );
    await watcher.poll();

    // SQLite state still transitions to merged
    expect(vi.mocked(updatePRState)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'merged',
    );
    // But no pr_merged notification fires for the historical merge
    expect(messages.filter((m) => m.type === 'pr_merged')).toHaveLength(0);
  });

  it('DOES broadcast pr_merged on the second poll when a merge is freshly observed', async () => {
    const pr = makePRRow({ task_id: null });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    // First poll: PR still open. Second poll: now merged.
    vi.mocked(github.getPRState)
      .mockResolvedValueOnce({ state: 'open', headSha: null })
      .mockResolvedValueOnce({ state: 'merged', headSha: null });

    const messages: ServerMessage[] = [];
    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      (msg) => messages.push(msg),
    );
    await watcher.poll();
    await watcher.poll();

    expect(messages.filter((m) => m.type === 'pr_merged')).toHaveLength(1);
  });

  it('start() immediate poll acts as first-poll-after-boot — suppresses pr_merged for pre-merged PRs', async () => {
    const pr = makePRRow({
      task_id: null,
      head_branch: 'main',
      session_id: null,
      review_session_id: null,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({} as never);
    const github = makeMockGitHub();
    vi.mocked(github.getPRState).mockResolvedValue({
      state: 'merged',
      headSha: null,
    });

    const messages: ServerMessage[] = [];
    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      undefined,
      (msg) => messages.push(msg),
    );

    const pollSpy = vi.spyOn(watcher, 'poll');
    watcher.start(Number.MAX_SAFE_INTEGER);
    await pollSpy.mock.results[0].value;

    expect(vi.mocked(updatePRState)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'merged',
    );
    expect(messages.filter((m) => m.type === 'pr_merged')).toHaveLength(0);

    watcher.stop();
  });
});

// ── ci_failing auto-recovery ──────────────────────────────────────────────────

describe('PRMergeWatcher ci_failing auto-recovery', () => {
  function mockCategorize(
    github: GitHubClient,
    value: {
      category: 'clean' | 'conflict' | 'ci_failed' | 'blocked' | 'unknown';
      mergeState: string;
      rawMergeableState: string | null;
      failingChecks: Array<{ name: string; conclusion: string }>;
    },
  ): void {
    vi.mocked(
      (
        github as unknown as {
          categorizeMergeability: (n: number, r: string) => Promise<unknown>;
        }
      ).categorizeMergeability,
    ).mockResolvedValue(value);
  }

  it('clears pause_reason, calls AutoMerger.attempt, and broadcasts when ci_failing PR becomes clean', async () => {
    const pr = makePRRow({
      pause_reason: 'ci_failing',
      merge_state: 'ci_failed',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorize(github, {
      category: 'clean',
      mergeState: 'clean',
      rawMergeableState: 'clean',
      failingChecks: [],
    });
    const autoMerger = makeMockAutoMerger();
    const messages: ServerMessage[] = [];
    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      (msg) => messages.push(msg),
    );
    watcher.setAutoMerger(autoMerger);
    await watcher.poll();

    expect(vi.mocked(setPauseReason)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      null,
    );
    expect(vi.mocked(autoMerger.attempt)).toHaveBeenCalledWith(
      42,
      'owner/repo',
    );
    expect(messages.some((m) => m.type === 'pr_pause_cleared')).toBe(true);
  });

  it('clears pause and retries even when merge_state was already clean in DB (PR #311 scenario)', async () => {
    const pr = makePRRow({
      pause_reason: 'ci_failing',
      merge_state: 'clean',
      failing_checks: null,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorize(github, {
      category: 'clean',
      mergeState: 'clean',
      rawMergeableState: 'clean',
      failingChecks: [],
    });
    const autoMerger = makeMockAutoMerger();
    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    watcher.setAutoMerger(autoMerger);
    await watcher.poll();

    expect(vi.mocked(setPauseReason)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      null,
    );
    expect(vi.mocked(autoMerger.attempt)).toHaveBeenCalledWith(
      42,
      'owner/repo',
    );
  });

  it('does NOT clear pause when merge_state is still ci_failed', async () => {
    const pr = makePRRow({
      pause_reason: 'ci_failing',
      merge_state: 'ci_failed',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorize(github, {
      category: 'ci_failed',
      mergeState: 'ci_failed',
      rawMergeableState: 'unstable',
      failingChecks: [{ name: 'lint', conclusion: 'failure' }],
    });
    const autoMerger = makeMockAutoMerger();
    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    watcher.setAutoMerger(autoMerger);
    await watcher.poll();

    expect(vi.mocked(setPauseReason)).not.toHaveBeenCalled();
    expect(vi.mocked(autoMerger.attempt)).not.toHaveBeenCalled();
  });

  it('does NOT clear pause when pause_reason is stuck_timeout even if merge_state is clean', async () => {
    const pr = makePRRow({
      pause_reason: 'stuck_timeout',
      merge_state: 'ci_failed',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorize(github, {
      category: 'clean',
      mergeState: 'clean',
      rawMergeableState: 'clean',
      failingChecks: [],
    });
    const autoMerger = makeMockAutoMerger();
    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    watcher.setAutoMerger(autoMerger);
    await watcher.poll();

    expect(vi.mocked(setPauseReason)).not.toHaveBeenCalled();
    expect(vi.mocked(autoMerger.attempt)).not.toHaveBeenCalled();
  });

  it('clears pause when merge_state transitions from ci_failed to unstable (no failing checks)', async () => {
    const pr = makePRRow({
      pause_reason: 'ci_failing',
      merge_state: 'ci_failed',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorize(github, {
      category: 'unknown',
      mergeState: 'unstable',
      rawMergeableState: 'unstable',
      failingChecks: [],
    });
    const autoMerger = makeMockAutoMerger();
    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    watcher.setAutoMerger(autoMerger);
    await watcher.poll();

    expect(vi.mocked(setPauseReason)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      null,
    );
    expect(vi.mocked(autoMerger.attempt)).toHaveBeenCalledWith(
      42,
      'owner/repo',
    );
  });
});

// ── autofix-first CI failure path ────────────────────────────────────────────

describe('PRMergeWatcher autofix-first CI failure path', () => {
  afterEach(() => {
    // Restore defaults so subsequent describe blocks aren't polluted
    vi.mocked(getProjectByGithubRepo).mockReturnValue(null);
    vi.mocked(getSession).mockReturnValue(null);
    vi.mocked(loadAutofixCommands).mockReturnValue([]);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      summary: 'no diff',
    });
  });

  function mockCategorizeCI(github: GitHubClient): void {
    vi.mocked(
      (
        github as unknown as {
          categorizeMergeability: (n: number, r: string) => Promise<unknown>;
        }
      ).categorizeMergeability,
    ).mockResolvedValue({
      category: 'ci_failed',
      mergeState: 'ci_failed',
      rawMergeableState: 'unstable',
      failingChecks: [{ name: 'build', conclusion: 'failure' }],
    });
  }

  it('swallows CI failure and writes audit entry when autofix produces a commit', async () => {
    const pr = makePRRow({
      merge_state: 'clean',
      session_id: 'coding-session',
      head_sha: 'original-sha',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorizeCI(github);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/proj',
    } as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run format:write']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      commitSha: 'autofix-sha-abc',
      summary: 'formatted',
    });

    const sessions = makeMockSessions();
    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(sessions.sendOrResume)).not.toHaveBeenCalled();
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'autofix_for_ci_failure',
        actor_type: 'system',
        payload: expect.objectContaining({
          pr_number: 42,
          commit_sha: 'autofix-sha-abc',
          failing_checks: ['build'],
          source: 'ci',
        }),
      }),
    );
  });

  it('forwards CI failure to session when autofix produces no diff', async () => {
    const pr = makePRRow({
      merge_state: 'clean',
      session_id: 'coding-session',
      head_sha: 'sha-test',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorizeCI(github);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/proj',
    } as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run format:write']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      summary: 'no diff',
    });

    const sessions = makeMockSessions();
    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(sessions.sendOrResume)).toHaveBeenCalledWith(
      'coding-session',
      expect.stringMatching(/## CI Failure — PR #42/),
    );
    expect(vi.mocked(recordEvent)).not.toHaveBeenCalled();
  });

  it('forwards CI failure when autofix throws', async () => {
    const pr = makePRRow({
      merge_state: 'clean',
      session_id: 'coding-session',
      head_sha: 'sha-test',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorizeCI(github);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/proj',
    } as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run format:write']);
    vi.mocked(runAutofix).mockRejectedValue(new Error('git failed'));

    const sessions = makeMockSessions();
    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(sessions.sendOrResume)).toHaveBeenCalledWith(
      'coding-session',
      expect.stringMatching(/## CI Failure — PR #42/),
    );
  });

  it('forwards CI failure when session worktree is missing', async () => {
    const pr = makePRRow({
      merge_state: 'clean',
      session_id: 'coding-session',
      head_sha: 'sha-test',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorizeCI(github);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/proj',
    } as any);
    vi.mocked(getSession).mockReturnValue(null); // no session
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run format:write']);

    const sessions = makeMockSessions();
    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(runAutofix)).not.toHaveBeenCalled();
    expect(vi.mocked(sessions.sendOrResume)).toHaveBeenCalledWith(
      'coding-session',
      expect.stringMatching(/## CI Failure — PR #42/),
    );
  });

  it('forwards CI failure when autofixCommands is empty', async () => {
    const pr = makePRRow({
      merge_state: 'clean',
      session_id: 'coding-session',
      head_sha: 'sha-test',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorizeCI(github);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/proj',
    } as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue([]);

    const sessions = makeMockSessions();
    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(runAutofix)).not.toHaveBeenCalled();
    expect(vi.mocked(sessions.sendOrResume)).toHaveBeenCalledWith(
      'coding-session',
      expect.stringMatching(/## CI Failure — PR #42/),
    );
  });

  it('loop guard: does not re-trigger autofix when last autofix SHA matches PR head', async () => {
    // First poll: clean → ci_failed, autofix commits 'autofix-sha'
    const pr1 = makePRRow({
      merge_state: 'clean',
      session_id: 'coding-session',
      head_sha: 'original-sha',
    });
    // Second poll: unknown → ci_failed, head_sha is now the autofix commit
    const pr2 = makePRRow({
      merge_state: 'unknown',
      session_id: 'coding-session',
      head_sha: 'autofix-sha',
    });

    // First poll: 'original-sha' not in DB → run autofix
    // Second poll: 'autofix-sha' IS in DB (was just added by first poll) → skip
    vi.mocked(consumeAutofixSha)
      .mockReturnValueOnce(false) // first poll: original-sha not registered
      .mockReturnValueOnce(true); // second poll: autofix-sha is registered

    vi.mocked(getAllOpenPRs)
      .mockReturnValueOnce([pr1])
      .mockReturnValueOnce([pr2]);

    const github = makeMockGitHub();
    vi.mocked(
      (
        github as unknown as {
          categorizeMergeability: (n: number, r: string) => Promise<unknown>;
        }
      ).categorizeMergeability,
    ).mockResolvedValue({
      category: 'ci_failed',
      mergeState: 'ci_failed',
      rawMergeableState: 'unstable',
      failingChecks: [{ name: 'build', conclusion: 'failure' }],
    });

    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/proj',
    } as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run format:write']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      commitSha: 'autofix-sha',
      summary: 'formatted',
    });

    const sessions = makeMockSessions();
    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );

    // First poll: autofix runs, SHA recorded, CI failure swallowed
    await watcher.poll();
    expect(vi.mocked(runAutofix)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sessions.sendOrResume)).not.toHaveBeenCalled();

    vi.mocked(runAutofix).mockClear();
    vi.mocked(sessions.sendOrResume).mockClear();

    // Second poll: loop guard fires — autofix NOT called, CI failure forwarded
    await watcher.poll();
    expect(vi.mocked(runAutofix)).not.toHaveBeenCalled();
    expect(vi.mocked(sessions.sendOrResume)).toHaveBeenCalledWith(
      'coding-session',
      expect.stringMatching(/## CI Failure — PR #42/),
    );
  });
});

// ── checkMergeabilityNow terminal-state guard ────────────────────────────────

describe('PRMergeWatcher.checkMergeabilityNow terminal-state guard', () => {
  it('does not call categorizeMergeability when PR state is merged', async () => {
    const pr = makePRRow({ state: 'merged' });
    vi.mocked(getPRByNumber).mockReturnValue(pr);
    const github = makeMockGitHub();
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.checkMergeabilityNow(42, 'owner/repo');

    expect(vi.mocked(github.categorizeMergeability)).not.toHaveBeenCalled();
    expect(vi.mocked(sessions.sendOrResume)).not.toHaveBeenCalled();
  });

  it('does not call categorizeMergeability when PR state is closed', async () => {
    const pr = makePRRow({ state: 'closed' });
    vi.mocked(getPRByNumber).mockReturnValue(pr);
    const github = makeMockGitHub();
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.checkMergeabilityNow(42, 'owner/repo');

    expect(vi.mocked(github.categorizeMergeability)).not.toHaveBeenCalled();
    expect(vi.mocked(sessions.sendOrResume)).not.toHaveBeenCalled();
  });

  it('suppresses broadcast and sendOrResume when PR merges during categorizeMergeability round-trip (race)', async () => {
    const openPR = makePRRow({
      state: 'open',
      merge_state: 'clean',
      session_id: 'coding-session',
    });
    const mergedPR = makePRRow({ state: 'merged', merge_state: 'clean' });
    // First call (checkMergeabilityNow fetch) → open; second call (post-async re-check) → merged
    vi.mocked(getPRByNumber)
      .mockReturnValueOnce(openPR)
      .mockReturnValueOnce(mergedPR);
    const github = makeMockGitHub();
    vi.mocked(
      (
        github as unknown as {
          categorizeMergeability: (n: number, r: string) => Promise<unknown>;
        }
      ).categorizeMergeability,
    ).mockResolvedValue({
      category: 'ci_failed',
      mergeState: 'ci_failed',
      rawMergeableState: 'unstable',
      failingChecks: [{ name: 'lint', conclusion: 'failure' }],
    });
    const sessions = makeMockSessions();
    const messages: ServerMessage[] = [];

    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      (msg) => messages.push(msg),
    );
    await watcher.checkMergeabilityNow(42, 'owner/repo');

    expect(vi.mocked(sessions.sendOrResume)).not.toHaveBeenCalled();
    expect(vi.mocked(updateMergeState)).not.toHaveBeenCalled();
    expect(
      messages.filter((m) => m.type === 'pr_mergeability_changed'),
    ).toHaveLength(0);
  });

  it('calls updateMergeState and sendOrResume for open PR with ci_failed (normal path regression)', async () => {
    const pr = makePRRow({
      state: 'open',
      merge_state: 'clean',
      session_id: 'coding-session',
      head_sha: 'sha-test', // non-null so per-SHA dedup fires on first observation
    });
    vi.mocked(getPRByNumber).mockReturnValue(pr);
    const github = makeMockGitHub();
    vi.mocked(
      (
        github as unknown as {
          categorizeMergeability: (n: number, r: string) => Promise<unknown>;
        }
      ).categorizeMergeability,
    ).mockResolvedValue({
      category: 'ci_failed',
      mergeState: 'ci_failed',
      rawMergeableState: 'unstable',
      failingChecks: [{ name: 'lint', conclusion: 'failure' }],
    });
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.checkMergeabilityNow(42, 'owner/repo');

    expect(vi.mocked(updateMergeState)).toHaveBeenCalled();
    expect(vi.mocked(sessions.sendOrResume)).toHaveBeenCalledWith(
      'coding-session',
      expect.stringMatching(/## CI Failure — PR #42/),
    );
  });
});

// ── orchestrator_autofix_shas cleanup ─────────────────────────────────────────

describe('PRMergeWatcher — autofix SHA cleanup on merge/close', () => {
  it('handleMerged calls deleteAllAutofixShasForPR for the merged PR', async () => {
    const pr = makePRRow({
      task_id: null,
      session_id: null,
      review_session_id: null,
    });
    const watcher = new PRMergeWatcher(
      makeMockGitHub(),
      makeMockSessions(),
      undefined,
      () => {},
    );

    await watcher.handleMerged(pr, null);

    expect(vi.mocked(deleteAllAutofixShasForPR)).toHaveBeenCalledWith(
      42,
      'owner/repo',
    );
  });

  it('PR closed without merging calls deleteAllAutofixShasForPR', async () => {
    const pr = makePRRow();
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    vi.mocked(github.getPRState).mockResolvedValue({
      state: 'closed',
      headSha: null,
    });

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      undefined,
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(deleteAllAutofixShasForPR)).toHaveBeenCalledWith(
      42,
      'owner/repo',
    );
  });
});

// ── CI-failure autofix dedup with DB ─────────────────────────────────────────

describe('PRMergeWatcher — CI-failure autofix dedup reads from DB', () => {
  it('skips autofix when consumeAutofixSha returns true for head_sha (DB dedup)', async () => {
    const pr = makePRRow({
      state: 'open',
      merge_state: 'clean',
      session_id: 'coding-session',
      head_sha: 'already-autofixed-sha',
      review_result: JSON.stringify({ verdict: 'approved' }),
    });
    vi.mocked(getPRByNumber).mockReturnValue(pr);
    vi.mocked(getSession).mockReturnValue({ worktree_path: '/fake/wt' } as any);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/tmp',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run lint']);

    // Simulate: SHA was registered in DB (e.g., before a restart)
    vi.mocked(consumeAutofixSha).mockReturnValue(true);

    const github = makeMockGitHub();
    vi.mocked((github as any).categorizeMergeability).mockResolvedValue({
      category: 'ci_failed',
      mergeState: 'ci_failed',
      rawMergeableState: 'unstable',
      failingChecks: [{ name: 'lint', conclusion: 'failure' }],
    });

    const sessions = makeMockSessions();
    const watcher = new PRMergeWatcher(github, sessions, undefined, () => {});
    await watcher.checkMergeabilityNow(42, 'owner/repo');

    expect(vi.mocked(runAutofix)).not.toHaveBeenCalled();
    expect(vi.mocked(consumeAutofixSha)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'already-autofixed-sha',
    );
  });

  it('after restart, autofix does NOT re-run for a SHA registered before the restart', async () => {
    const pr = makePRRow({
      state: 'open',
      merge_state: 'dirty',
      session_id: 'coding-session',
      head_sha: 'pre-restart-autofix-sha',
      review_result: JSON.stringify({ verdict: 'approved' }),
    });
    vi.mocked(getPRByNumber).mockReturnValue(pr);
    vi.mocked(getSession).mockReturnValue({ worktree_path: '/fake/wt' } as any);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/tmp',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run lint']);

    // SHA was added to DB by a previous instance; DB returns true on restart
    vi.mocked(consumeAutofixSha).mockReturnValue(true);

    const github = makeMockGitHub();
    vi.mocked((github as any).categorizeMergeability).mockResolvedValue({
      category: 'ci_failed',
      mergeState: 'ci_failed',
      rawMergeableState: 'unstable',
      failingChecks: [{ name: 'ci', conclusion: 'failure' }],
    });

    // New PRMergeWatcher instance (simulating restart — no in-memory Map)
    const freshWatcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      undefined,
      () => {},
    );
    await freshWatcher.checkMergeabilityNow(42, 'owner/repo');

    expect(vi.mocked(runAutofix)).not.toHaveBeenCalled();
  });

  it('autofix runs and calls addAutofixSha when head_sha is not in DB', async () => {
    const pr = makePRRow({
      state: 'open',
      merge_state: 'clean',
      session_id: 'coding-session',
      head_sha: 'not-autofixed-sha',
      review_result: JSON.stringify({ verdict: 'approved' }),
    });
    vi.mocked(getPRByNumber).mockReturnValue(pr);
    vi.mocked(getSession).mockReturnValue({ worktree_path: '/fake/wt' } as any);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/tmp',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run lint']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      commitSha: 'new-autofix-sha',
      summary: 'done',
    });

    vi.mocked(consumeAutofixSha).mockReturnValue(false);

    const github = makeMockGitHub();
    vi.mocked((github as any).categorizeMergeability).mockResolvedValue({
      category: 'ci_failed',
      mergeState: 'ci_failed',
      rawMergeableState: 'unstable',
      failingChecks: [{ name: 'lint', conclusion: 'failure' }],
    });

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      undefined,
      () => {},
    );
    await watcher.checkMergeabilityNow(42, 'owner/repo');

    expect(vi.mocked(runAutofix)).toHaveBeenCalled();
    expect(vi.mocked(addAutofixSha)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'new-autofix-sha',
    );
  });
});

// ── ci_remediation_attempted_sha per-SHA dedup ────────────────────────────────

describe('PRMergeWatcher — ci_remediation_attempted_sha per-SHA dedup', () => {
  beforeEach(() => {
    // Reset mocks that may have been set to non-default values by prior describe blocks
    vi.mocked(getProjectByGithubRepo).mockReturnValue(null);
    vi.mocked(getSession).mockReturnValue(null);
    vi.mocked(loadAutofixCommands).mockReturnValue([]);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      summary: 'no diff',
    });
  });

  function mockCategorizeCI(
    github: GitHubClient,
    failingChecks = [{ name: 'build', conclusion: 'failure' }],
  ): void {
    vi.mocked((github as any).categorizeMergeability).mockResolvedValue({
      category: 'ci_failed',
      mergeState: 'ci_failed',
      rawMergeableState: 'unstable',
      failingChecks,
    });
  }

  it('fires remediation on first observation when ci_remediation_attempted_sha is null (paused PR scenario)', async () => {
    // Simulates: AutoMerger already wrote merge_state='ci_failed', stateChanged=false.
    const pr = makePRRow({
      pause_reason: 'ci_failing',
      merge_state: 'ci_failed',
      session_id: 'coding-session',
      head_sha: 'sha-abc',
      ci_remediation_attempted_sha: null,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorizeCI(github);
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(setCiRemediationAttemptedSha)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'sha-abc',
    );
    expect(vi.mocked(sessions.sendOrResume)).toHaveBeenCalledWith(
      'coding-session',
      expect.stringMatching(/## CI Failure — PR #42/),
    );
  });

  it('does NOT re-fire remediation on subsequent polls with the same head_sha', async () => {
    const pr = makePRRow({
      merge_state: 'ci_failed',
      session_id: 'coding-session',
      head_sha: 'sha-abc',
      ci_remediation_attempted_sha: 'sha-abc', // already remediated for this SHA
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorizeCI(github);
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(setCiRemediationAttemptedSha)).not.toHaveBeenCalled();
    expect(vi.mocked(sessions.sendOrResume)).not.toHaveBeenCalled();
  });

  it('fires remediation again when head_sha advances to a new SHA after a push', async () => {
    const pr = makePRRow({
      merge_state: 'ci_failed',
      session_id: 'coding-session',
      head_sha: 'sha-B',
      ci_remediation_attempted_sha: 'sha-A', // remediated for old SHA
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorizeCI(github);
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(setCiRemediationAttemptedSha)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'sha-B',
    );
    expect(vi.mocked(sessions.sendOrResume)).toHaveBeenCalledWith(
      'coding-session',
      expect.stringMatching(/## CI Failure — PR #42/),
    );
  });

  it('does NOT touch ci_remediation_attempted_sha for clean category polls', async () => {
    const pr = makePRRow({
      merge_state: 'clean',
      session_id: 'coding-session',
      head_sha: 'sha-abc',
      ci_remediation_attempted_sha: null,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    vi.mocked((github as any).categorizeMergeability).mockResolvedValue({
      category: 'clean',
      mergeState: 'clean',
      rawMergeableState: 'clean',
      failingChecks: [],
    });

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(setCiRemediationAttemptedSha)).not.toHaveBeenCalled();
  });

  it('autofix path sets ci_remediation_attempted_sha before producing a commit', async () => {
    const pr = makePRRow({
      merge_state: 'clean',
      session_id: 'coding-session',
      head_sha: 'original-sha',
      ci_remediation_attempted_sha: null,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorizeCI(github);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/proj',
    } as any);
    vi.mocked(getSession).mockReturnValue({ worktree_path: '/wt' } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run format:write']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      commitSha: 'autofix-sha',
      summary: 'formatted',
    });
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    // SHA reservation happened before autofix
    expect(vi.mocked(setCiRemediationAttemptedSha)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'original-sha',
    );
    // Autofix ran and session was NOT messaged (CI re-runs on new SHA)
    expect(vi.mocked(runAutofix)).toHaveBeenCalled();
    expect(vi.mocked(sessions.sendOrResume)).not.toHaveBeenCalled();
  });

  it('session-feedback path sets ci_remediation_attempted_sha so it does not re-send on next poll', async () => {
    const pr = makePRRow({
      merge_state: 'clean',
      session_id: 'coding-session',
      head_sha: 'sha-xyz',
      ci_remediation_attempted_sha: null,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorizeCI(github);
    // No autofix commands → falls through to session feedback
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/proj',
    } as any);
    vi.mocked(getSession).mockReturnValue({ worktree_path: '/wt' } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue([]);
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(setCiRemediationAttemptedSha)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'sha-xyz',
    );
    expect(vi.mocked(sessions.sendOrResume)).toHaveBeenCalledWith(
      'coding-session',
      expect.stringMatching(/## CI Failure — PR #42/),
    );
  });

  it('existing lastAutofixShas dedup still prevents autofix re-run even when ci_remediation fires', async () => {
    const pr = makePRRow({
      merge_state: 'ci_failed',
      session_id: 'coding-session',
      head_sha: 'sha-new',
      ci_remediation_attempted_sha: null, // not yet remediated for this SHA
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorizeCI(github);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/proj',
    } as any);
    vi.mocked(getSession).mockReturnValue({ worktree_path: '/wt' } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run lint']);
    // Autofix SHA already recorded in orchestrator_autofix_shas
    vi.mocked(consumeAutofixSha).mockReturnValue(true);
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    // ci_remediation_attempted_sha was set (outer dedup reserved the SHA)
    expect(vi.mocked(setCiRemediationAttemptedSha)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'sha-new',
    );
    // Inner autofix dedup prevented the re-run
    expect(vi.mocked(runAutofix)).not.toHaveBeenCalled();
    // Session still got the message (autofix skipped → fall through)
    expect(vi.mocked(sessions.sendOrResume)).toHaveBeenCalledWith(
      'coding-session',
      expect.stringMatching(/## CI Failure — PR #42/),
    );
  });
});

// ── head_sha out-of-band refresh ──────────────────────────────────────────────

describe('PRMergeWatcher — out-of-band head_sha refresh via poll()', () => {
  it('calls setHeadSha when GitHub head SHA differs from DB head_sha', async () => {
    const pr = makePRRow({ head_sha: 'old-sha-111' });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    vi.mocked(getPRByNumber).mockReturnValue(pr);
    const github = makeMockGitHub();
    vi.mocked(github.getPRState).mockResolvedValue({
      state: 'open',
      headSha: 'new-sha-999',
    });

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(setHeadSha)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'new-sha-999',
    );
  });

  it('does NOT call setHeadSha when GitHub head SHA matches DB head_sha', async () => {
    const pr = makePRRow({ head_sha: 'same-sha-abc' });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    vi.mocked(github.getPRState).mockResolvedValue({
      state: 'open',
      headSha: 'same-sha-abc',
    });

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(setHeadSha)).not.toHaveBeenCalled();
  });

  it('does NOT call setHeadSha when GitHub returns null headSha', async () => {
    const pr = makePRRow({ head_sha: 'some-sha' });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    vi.mocked(github.getPRState).mockResolvedValue({
      state: 'open',
      headSha: null,
    });

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(setHeadSha)).not.toHaveBeenCalled();
  });
});

// ── handlePushDetected watcher-path push pipeline ─────────────────────────────

describe('PRMergeWatcher.handlePushDetected() — push pipeline', () => {
  it('calls runAutofixPipeline then reReviewPR on a new push', async () => {
    const pr = makePRRow({
      head_sha: 'sha-new',
      last_reviewed_sha: 'sha-old',
      review_iteration: 0,
      review_session_id: 'review-session',
    });
    const reviewOrchestrator = makeMockReviewOrchestrator();
    const reviewService = makeMockPRReviewService();
    vi.mocked(
      reviewService.reReviewPR as ReturnType<typeof vi.fn>,
    ).mockResolvedValue({
      verdict: 'approved',
      summary: 'LGTM',
      dimensions: [],
      prNumber: 42,
      repo: 'owner/repo',
      reviewedAt: new Date().toISOString(),
    });
    const github = makeMockGitHub();
    vi.mocked(github.fetchPR as ReturnType<typeof vi.fn>).mockResolvedValue({
      headSha: 'sha-new',
    });

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    watcher.setPRReviewService(reviewService);
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.handlePushDetected(pr);
    await new Promise((r) => setTimeout(r, 50));

    expect(
      vi.mocked(
        reviewOrchestrator.runAutofixPipeline as ReturnType<typeof vi.fn>,
      ),
    ).toHaveBeenCalledWith(42, 'owner/repo', 'notion:task-abc');
    expect(
      vi.mocked(reviewService.reReviewPR as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalled();
  });

  it('broadcasts review_verdict: approved when reReviewPR returns approved', async () => {
    const pr = makePRRow({
      head_sha: 'sha-new',
      last_reviewed_sha: 'sha-old',
      review_iteration: 0,
      review_session_id: 'review-session',
    });
    const reviewOrchestrator = makeMockReviewOrchestrator();
    const reviewService = makeMockPRReviewService();
    vi.mocked(
      reviewService.reReviewPR as ReturnType<typeof vi.fn>,
    ).mockResolvedValue({
      verdict: 'approved',
      summary: 'LGTM',
      dimensions: [],
      prNumber: 42,
      repo: 'owner/repo',
      reviewedAt: new Date().toISOString(),
    });
    const github = makeMockGitHub();
    vi.mocked(github.fetchPR as ReturnType<typeof vi.fn>).mockResolvedValue({
      headSha: 'sha-new',
    });
    const messages: ServerMessage[] = [];

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      (m) => messages.push(m),
    );
    watcher.setPRReviewService(reviewService);
    watcher.setReviewOrchestrator(reviewOrchestrator);
    watcher.setAutoMerger(makeMockAutoMerger());

    await watcher.handlePushDetected(pr);
    await new Promise((r) => setTimeout(r, 50));

    expect(
      messages.some(
        (m) => m.type === 'review_verdict' && (m as any).verdict === 'approved',
      ),
    ).toBe(true);
  });

  it('calls sendOrResume when reReviewPR returns verdict: needs_changes', async () => {
    const pr = makePRRow({
      head_sha: 'sha-new',
      last_reviewed_sha: 'sha-old',
      review_iteration: 0,
      review_session_id: 'review-session',
      session_id: 'coding-session',
    });
    const reviewOrchestrator = makeMockReviewOrchestrator();
    const reviewService = makeMockPRReviewService();
    vi.mocked(
      reviewService.reReviewPR as ReturnType<typeof vi.fn>,
    ).mockResolvedValue({
      verdict: 'needs_changes',
      summary: 'Fix the bug',
      dimensions: [
        {
          name: 'correctness',
          verdict: 'needs_changes',
          feedback: 'Bug found',
        },
      ],
      prNumber: 42,
      repo: 'owner/repo',
      reviewedAt: new Date().toISOString(),
    });
    const github = makeMockGitHub();
    vi.mocked(github.fetchPR as ReturnType<typeof vi.fn>).mockResolvedValue({
      headSha: 'sha-new',
    });
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    watcher.setPRReviewService(reviewService);
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.handlePushDetected(pr);
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(sessions.sendOrResume)).toHaveBeenCalledWith(
      'coding-session',
      expect.any(String),
    );
  });

  it('does not trigger push pipeline when head_sha is unchanged during poll()', async () => {
    const pr = makePRRow({ head_sha: 'unchanged-sha' });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    vi.mocked(github.getPRState).mockResolvedValue({
      state: 'open',
      headSha: 'unchanged-sha',
    });
    const reviewOrchestrator = makeMockReviewOrchestrator();
    const reviewService = makeMockPRReviewService();

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    watcher.setPRReviewService(reviewService);
    watcher.setReviewOrchestrator(reviewOrchestrator);
    await watcher.poll();
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(setHeadSha)).not.toHaveBeenCalled();
    expect(
      vi.mocked(
        reviewOrchestrator.runAutofixPipeline as ReturnType<typeof vi.fn>,
      ),
    ).not.toHaveBeenCalled();
    expect(
      vi.mocked(reviewService.reReviewPR as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });

  it('triggers push pipeline when head_sha changes during poll() (watcher-path integration)', async () => {
    const pr = makePRRow({
      head_sha: 'old-sha',
      last_reviewed_sha: 'old-sha',
      review_iteration: 0,
      review_session_id: 'review-session',
    });
    const refreshedPr = { ...pr, head_sha: 'new-sha-xyz' };
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    vi.mocked(getPRByNumber).mockReturnValue(refreshedPr);
    const github = makeMockGitHub();
    vi.mocked(github.getPRState).mockResolvedValue({
      state: 'open',
      headSha: 'new-sha-xyz',
    });
    vi.mocked(github.fetchPR as ReturnType<typeof vi.fn>).mockResolvedValue({
      headSha: 'new-sha-xyz',
    });
    const reviewOrchestrator = makeMockReviewOrchestrator();
    const reviewService = makeMockPRReviewService();
    vi.mocked(
      reviewService.reReviewPR as ReturnType<typeof vi.fn>,
    ).mockResolvedValue({
      verdict: 'approved',
      summary: 'LGTM',
      dimensions: [],
      prNumber: 42,
      repo: 'owner/repo',
      reviewedAt: new Date().toISOString(),
    });

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    watcher.setPRReviewService(reviewService);
    watcher.setReviewOrchestrator(reviewOrchestrator);
    await watcher.poll();
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(setHeadSha)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'new-sha-xyz',
    );
    expect(
      vi.mocked(
        reviewOrchestrator.runAutofixPipeline as ReturnType<typeof vi.fn>,
      ),
    ).toHaveBeenCalledWith(42, 'owner/repo', 'notion:task-abc');
  });

  it('preserves existing WS-handler behavior: thin wrapper calls handlePushDetected directly', async () => {
    // Verifies the server.ts thin-wrapper path: when a coding session fires
    // push_detected, it calls prMergeWatcher.handlePushDetected(prRow) directly.
    const pr = makePRRow({
      head_sha: 'sha-from-session',
      last_reviewed_sha: 'old-sha',
      review_iteration: 0,
      review_session_id: 'review-session',
      session_id: 'coding-session',
    });
    const github = makeMockGitHub();
    vi.mocked(github.fetchPR as ReturnType<typeof vi.fn>).mockResolvedValue({
      headSha: 'sha-from-session',
    });
    const reviewOrchestrator = makeMockReviewOrchestrator();
    const reviewService = makeMockPRReviewService();
    vi.mocked(
      reviewService.reReviewPR as ReturnType<typeof vi.fn>,
    ).mockResolvedValue({
      verdict: 'approved',
      summary: 'LGTM',
      dimensions: [],
      prNumber: 42,
      repo: 'owner/repo',
      reviewedAt: new Date().toISOString(),
    });

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    watcher.setPRReviewService(reviewService);
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.handlePushDetected(pr);
    await new Promise((r) => setTimeout(r, 50));

    expect(
      vi.mocked(
        reviewOrchestrator.runAutofixPipeline as ReturnType<typeof vi.fn>,
      ),
    ).toHaveBeenCalledWith(42, 'owner/repo', 'notion:task-abc');
    expect(
      vi.mocked(reviewService.reReviewPR as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalled();
  });
});

// ── incomplete verdict + push re-review ──────────────────────────────────────

describe('PRMergeWatcher — incomplete verdict + push triggers re-review', () => {
  it('fires reReviewPR when head_sha != last_reviewed_sha and verdict is incomplete', async () => {
    const pr = makePRRow({
      head_sha: 'sha-new',
      last_reviewed_sha: 'sha-incomplete',
      review_iteration: 1,
      review_session_id: 'review-session',
      session_id: 'coding-session',
      review_result: JSON.stringify({
        verdict: 'incomplete',
        summary: 'Could not assess the PR.',
        dimensions: [],
      }),
    });
    const reviewOrchestrator = makeMockReviewOrchestrator();
    const reviewService = makeMockPRReviewService({
      verdict: 'approved',
      summary: 'LGTM',
    });
    const github = makeMockGitHub();
    vi.mocked(github.fetchPR as ReturnType<typeof vi.fn>).mockResolvedValue({
      headSha: 'sha-new',
    });

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    watcher.setPRReviewService(reviewService);
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.handlePushDetected(pr);
    await new Promise((r) => setTimeout(r, 50));

    expect(
      vi.mocked(reviewService.reReviewPR as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalled();
  });

  it('does NOT fire reReviewPR when head_sha equals last_reviewed_sha (terminal stale)', async () => {
    const pr = makePRRow({
      head_sha: 'sha-same',
      last_reviewed_sha: 'sha-same',
      review_iteration: 1,
      review_session_id: 'review-session',
      session_id: 'coding-session',
      review_result: JSON.stringify({
        verdict: 'incomplete',
        summary: 'Could not assess the PR.',
        dimensions: [],
      }),
    });
    const reviewOrchestrator = makeMockReviewOrchestrator();
    const reviewService = makeMockPRReviewService();
    const github = makeMockGitHub();
    vi.mocked(github.fetchPR as ReturnType<typeof vi.fn>).mockResolvedValue({
      headSha: 'sha-same',
    });

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    watcher.setPRReviewService(reviewService);
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.handlePushDetected(pr);
    await new Promise((r) => setTimeout(r, 50));

    expect(
      vi.mocked(reviewService.reReviewPR as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });

  it('fires review_escalated instead of re-review when iteration cap is reached', async () => {
    const pr = makePRRow({
      head_sha: 'sha-new',
      last_reviewed_sha: 'sha-old',
      review_iteration: 3, // at the default cap of 3
      review_session_id: 'review-session',
      session_id: 'coding-session',
      review_result: JSON.stringify({
        verdict: 'incomplete',
        summary: 'Could not assess.',
        dimensions: [],
      }),
    });
    const reviewOrchestrator = makeMockReviewOrchestrator();
    const reviewService = makeMockPRReviewService();
    const github = makeMockGitHub();
    vi.mocked(github.fetchPR as ReturnType<typeof vi.fn>).mockResolvedValue({
      headSha: 'sha-new',
    });
    const messages: ServerMessage[] = [];

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      (m) => messages.push(m),
    );
    watcher.setPRReviewService(reviewService);
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.handlePushDetected(pr);
    await new Promise((r) => setTimeout(r, 50));

    expect(
      vi.mocked(reviewService.reReviewPR as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
    expect(messages.some((m) => m.type === 'review_escalated')).toBe(true);
  });

  it('calls sendOrResume on implementing session when re-review returns incomplete', async () => {
    const pr = makePRRow({
      head_sha: 'sha-new',
      last_reviewed_sha: 'sha-old',
      review_iteration: 1,
      review_session_id: 'review-session',
      session_id: 'coding-session',
    });
    const reviewOrchestrator = makeMockReviewOrchestrator();
    const reviewService = makeMockPRReviewService({
      verdict: 'incomplete',
      summary: 'Still cannot assess.',
      dimensions: [
        {
          name: 'Diff vs Acceptance Criteria',
          passed: false,
          notes: 'Tests unreadable',
        },
      ],
    });
    const github = makeMockGitHub();
    vi.mocked(github.fetchPR as ReturnType<typeof vi.fn>).mockResolvedValue({
      headSha: 'sha-new',
    });
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    watcher.setPRReviewService(reviewService);
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.handlePushDetected(pr);
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(sessions.sendOrResume)).toHaveBeenCalledWith(
      'coding-session',
      expect.stringContaining('Incomplete'),
    );
  });

  it('still broadcasts review_incomplete WS event when re-review returns incomplete', async () => {
    const pr = makePRRow({
      head_sha: 'sha-new',
      last_reviewed_sha: 'sha-old',
      review_iteration: 1,
      review_session_id: 'review-session',
      session_id: 'coding-session',
    });
    const reviewOrchestrator = makeMockReviewOrchestrator();
    const reviewService = makeMockPRReviewService({
      verdict: 'incomplete',
      summary: 'Still cannot assess.',
      dimensions: [],
    });
    const github = makeMockGitHub();
    vi.mocked(github.fetchPR as ReturnType<typeof vi.fn>).mockResolvedValue({
      headSha: 'sha-new',
    });
    const messages: ServerMessage[] = [];

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      (m) => messages.push(m),
    );
    watcher.setPRReviewService(reviewService);
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.handlePushDetected(pr);
    await new Promise((r) => setTimeout(r, 50));

    expect(messages.some((m) => m.type === 'review_incomplete')).toBe(true);
  });
});

// ── pendingReReviews leak recovery ────────────────────────────────────────────

describe('PRMergeWatcher — pendingReReviews leak recovery', () => {
  it('cleans up pendingReReviews when runAutofixPipeline throws', async () => {
    const pr = makePRRow({
      head_sha: 'sha-new',
      last_reviewed_sha: 'sha-old',
      review_iteration: 0,
      review_session_id: 'review-session',
      session_id: 'coding-session',
    });
    const reviewOrchestrator = makeMockReviewOrchestrator();
    vi.mocked(
      reviewOrchestrator.runAutofixPipeline as ReturnType<typeof vi.fn>,
    ).mockRejectedValue(new Error('autofix failed'));
    const github = makeMockGitHub();
    vi.mocked(github.fetchPR as ReturnType<typeof vi.fn>).mockResolvedValue({
      headSha: 'sha-new',
    });
    const reviewService = makeMockPRReviewService();

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    watcher.setPRReviewService(reviewService);
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.handlePushDetected(pr);
    await new Promise((r) => setTimeout(r, 50));

    expect((watcher as any).pendingReReviews.has('coding-session')).toBe(false);
  });

  it('cleans up pendingReReviews when runTestPipeline throws', async () => {
    const pr = makePRRow({
      head_sha: 'sha-new',
      last_reviewed_sha: 'sha-old',
      review_iteration: 0,
      review_session_id: 'review-session',
      session_id: 'coding-session',
    });
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/proj',
    } as any);
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      ci_check_name: [],
      test: ['npm test'],
      test_timeout_sec: 60,
      test_max_rss_mb: 0,
      test_fail_fast: false,
      autofix: [],
      verify: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    } as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/wt/session',
    } as any);
    const reviewOrchestrator = makeMockReviewOrchestrator();
    vi.mocked(
      reviewOrchestrator.runTestPipeline as ReturnType<typeof vi.fn>,
    ).mockRejectedValue(new Error('test pipeline failed'));
    const github = makeMockGitHub();
    vi.mocked(github.fetchPR as ReturnType<typeof vi.fn>).mockResolvedValue({
      headSha: 'sha-new',
    });
    const reviewService = makeMockPRReviewService();

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    watcher.setPRReviewService(reviewService);
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.handlePushDetected(pr);
    await new Promise((r) => setTimeout(r, 50));

    expect((watcher as any).pendingReReviews.has('coding-session')).toBe(false);
  });

  it('sweepStalePendingReReviews removes entries older than TTL and emits warn', () => {
    const watcher = new PRMergeWatcher(
      makeMockGitHub(),
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const staleTimestamp = Date.now() - 6 * 60 * 1000; // 6 min > 5 min TTL
    (watcher as any).pendingReReviews.set(
      'stale-session-id-abc',
      staleTimestamp,
    );

    (watcher as any).sweepStalePendingReReviews();

    expect((watcher as any).pendingReReviews.has('stale-session-id-abc')).toBe(
      false,
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '[PRMergeWatcher] sweeping stale pendingReReview for session stale-se',
      ),
    );
    warnSpy.mockRestore();
  });

  it('second handlePushDetected for same session proceeds after previous cleanup', async () => {
    const pr = makePRRow({
      head_sha: 'sha-new',
      last_reviewed_sha: 'sha-old',
      review_iteration: 0,
      review_session_id: 'review-session',
      session_id: 'coding-session',
    });
    const reviewOrchestrator = makeMockReviewOrchestrator();
    vi.mocked(
      reviewOrchestrator.runAutofixPipeline as ReturnType<typeof vi.fn>,
    ).mockRejectedValueOnce(new Error('autofix failed'));
    const github = makeMockGitHub();
    vi.mocked(github.fetchPR as ReturnType<typeof vi.fn>).mockResolvedValue({
      headSha: 'sha-new',
    });
    const reviewService = makeMockPRReviewService();
    vi.mocked(
      reviewService.reReviewPR as ReturnType<typeof vi.fn>,
    ).mockResolvedValue({
      verdict: 'approved',
      summary: 'LGTM',
      dimensions: [],
      prNumber: 42,
      repo: 'owner/repo',
      reviewedAt: new Date().toISOString(),
    });

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    watcher.setPRReviewService(reviewService);
    watcher.setReviewOrchestrator(reviewOrchestrator);

    // First call — runAutofixPipeline throws; pendingReReviews must be cleaned up
    await watcher.handlePushDetected(pr);
    await new Promise((r) => setTimeout(r, 50));

    // Second call — must NOT be blocked by the pendingReReviews guard
    await watcher.handlePushDetected(pr);
    await new Promise((r) => setTimeout(r, 50));

    // runAutofixPipeline called twice: once (throw), once (success)
    expect(
      vi.mocked(
        reviewOrchestrator.runAutofixPipeline as ReturnType<typeof vi.fn>,
      ),
    ).toHaveBeenCalledTimes(2);
  });
});

// ── Orchestrator-run test gate (F2) ──────────────────────────────────────────

describe('PRMergeWatcher — orchestrator test gate (F2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProjectByGithubRepo).mockReturnValue(null);
    vi.mocked(getTestResult).mockReturnValue(undefined);
  });

  function mockCategorizeClean(github: GitHubClient): void {
    vi.mocked((github as any).categorizeMergeability).mockResolvedValue({
      category: 'clean',
      mergeState: 'clean',
      rawMergeableState: 'clean',
      failingChecks: [],
    });
  }

  it('pauses with ci_failing and routes test output to session when latest-SHA test fails', async () => {
    const pr = makePRRow({
      head_sha: 'sha-fail',
      session_id: 'coding-session',
      ci_remediation_attempted_sha: null,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorizeClean(github);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/proj',
    } as any);
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      ci_check_name: [],
      test: ['npm test'],
      test_timeout_sec: 300,
      autofix: [],
      verify: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    } as any);
    vi.mocked(getTestResult).mockReturnValue({
      pr_number: 42,
      repo: 'owner/repo',
      sha: 'sha-fail',
      passed: 0,
      output: 'FAIL src/foo.test.ts\n  ● test name\n    expected 1 to equal 2',
      ran_at: '2026-01-01T00:00:00Z',
    } as any);
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(setCiRemediationAttemptedSha)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'sha-fail',
    );
    expect(vi.mocked(setPauseReason)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'ci_failing',
    );
    const sent = vi.mocked(sessions.sendOrResume).mock.calls[0]?.[1] as string;
    expect(sent).toMatch(/## CI Failure — PR #42/);
    expect(sent).toContain('FAIL src/foo.test.ts');
    // GitHub mergeability was NOT consulted — returned early after test gate
    expect(vi.mocked(github.categorizeMergeability)).not.toHaveBeenCalled();
  });

  it('proceeds to review/merge when latest-SHA test passes (no gate)', async () => {
    const pr = makePRRow({
      head_sha: 'sha-pass',
      session_id: 'coding-session',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorizeClean(github);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/proj',
    } as any);
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      ci_check_name: [],
      test: ['npm test'],
      test_timeout_sec: 300,
      autofix: [],
      verify: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    } as any);
    vi.mocked(getTestResult).mockReturnValue({
      pr_number: 42,
      repo: 'owner/repo',
      sha: 'sha-pass',
      passed: 1,
      output: 'All tests passed',
      ran_at: '2026-01-01T00:00:00Z',
    } as any);
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    // No pause, no remediation
    expect(vi.mocked(setPauseReason)).not.toHaveBeenCalledWith(
      42,
      'owner/repo',
      'ci_failing',
    );
    expect(vi.mocked(sessions.sendOrResume)).not.toHaveBeenCalled();
    // GitHub mergeability was consulted (normal flow)
    expect(vi.mocked(github.categorizeMergeability)).toHaveBeenCalled();
  });

  it('does not re-remediate when ci_remediation_attempted_sha matches head_sha', async () => {
    const pr = makePRRow({
      head_sha: 'sha-fail',
      session_id: 'coding-session',
      ci_remediation_attempted_sha: 'sha-fail', // already remediated
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorizeClean(github);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/proj',
    } as any);
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      ci_check_name: [],
      test: ['npm test'],
      test_timeout_sec: 300,
      autofix: [],
      verify: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    } as any);
    vi.mocked(getTestResult).mockReturnValue({
      pr_number: 42,
      repo: 'owner/repo',
      sha: 'sha-fail',
      passed: 0,
      output: 'Test failed',
      ran_at: '2026-01-01T00:00:00Z',
    } as any);
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    // Dedup: no re-remediation for the same SHA
    expect(vi.mocked(setCiRemediationAttemptedSha)).not.toHaveBeenCalled();
    expect(vi.mocked(sessions.sendOrResume)).not.toHaveBeenCalled();
    // Still returns early (gated on failing tests)
    expect(vi.mocked(github.categorizeMergeability)).not.toHaveBeenCalled();
  });

  it('re-gates and remediates when a new head_sha has a failing test result', async () => {
    const pr = makePRRow({
      head_sha: 'sha-new',
      session_id: 'coding-session',
      ci_remediation_attempted_sha: 'sha-old', // remediated for old SHA only
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorizeClean(github);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/proj',
    } as any);
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      ci_check_name: [],
      test: ['npm test'],
      test_timeout_sec: 300,
      autofix: [],
      verify: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    } as any);
    vi.mocked(getTestResult).mockReturnValue({
      pr_number: 42,
      repo: 'owner/repo',
      sha: 'sha-new',
      passed: 0,
      output: 'Fix failed',
      ran_at: '2026-01-01T00:00:00Z',
    } as any);
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(
      github,
      sessions,
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    expect(vi.mocked(setCiRemediationAttemptedSha)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'sha-new',
    );
    expect(vi.mocked(sessions.sendOrResume)).toHaveBeenCalledWith(
      'coding-session',
      expect.stringMatching(/## CI Failure — PR #42/),
    );
  });

  it('skips test gate when no test: commands configured', async () => {
    const pr = makePRRow({ head_sha: 'sha-abc', session_id: 'coding-session' });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    const github = makeMockGitHub();
    mockCategorizeClean(github);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/proj',
    } as any);
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      ci_check_name: [],
      test: [],
      test_timeout_sec: 300,
      autofix: [],
      verify: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    } as any);
    vi.mocked(getTestResult).mockReturnValue({
      passed: 0,
      output: 'irrelevant',
    } as any);

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    await watcher.poll();

    // Gate not engaged — falls through to GitHub mergeability
    expect(vi.mocked(github.categorizeMergeability)).toHaveBeenCalled();
  });

  it('runs runTestPipeline for a new push SHA in the re-review path', async () => {
    const pr = makePRRow({
      head_sha: 'sha-new',
      last_reviewed_sha: 'sha-old',
      review_iteration: 0,
      review_session_id: 'review-session',
      session_id: 'coding-session',
    });
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/proj',
    } as any);
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      ci_check_name: [],
      test: ['npm test'],
      test_timeout_sec: 60,
      test_max_rss_mb: 0,
      test_fail_fast: true,
      autofix: [],
      verify: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    } as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/wt/session',
    } as any);
    const reviewOrchestrator = makeMockReviewOrchestrator();
    const reviewService = makeMockPRReviewService();
    vi.mocked(
      reviewService.reReviewPR as ReturnType<typeof vi.fn>,
    ).mockResolvedValue({
      verdict: 'approved',
      summary: 'LGTM',
      dimensions: [],
      prNumber: 42,
      repo: 'owner/repo',
      reviewedAt: new Date().toISOString(),
    });
    const github = makeMockGitHub();
    vi.mocked(github.fetchPR as ReturnType<typeof vi.fn>).mockResolvedValue({
      headSha: 'sha-new',
    });

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      makeMockNotion(),
      () => {},
    );
    watcher.setPRReviewService(reviewService);
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.handlePushDetected(pr);
    await new Promise((r) => setTimeout(r, 50));

    expect(
      vi.mocked(reviewOrchestrator.runTestPipeline as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'sha-new',
      '/wt/session',
      ['npm test'],
      60,
      0,
      true,
    );
  });
});

// ── handlePushDetected — post-gate-failure direct enqueue ─────────────────────

describe('PRMergeWatcher.handlePushDetected() — post-gate-failure enqueue', () => {
  it('push after autofix_failed with review_session_id=null → enqueueReview called, not setPendingPush', async () => {
    const pr = makePRRow({
      review_session_id: null,
      review_result: JSON.stringify({
        verdict: 'autofix_failed',
        summary: 'lint failed',
        dimensions: [],
      }),
      head_sha: 'sha-fix',
      last_reviewed_sha: 'sha-old',
      review_iteration: 0,
    });
    vi.mocked(getSession).mockReturnValue({
      task_url: 'https://notion.so/task-1',
    } as any);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      contextUrl: 'https://notion.so/ctx',
    } as any);

    const reviewOrchestrator = makeMockReviewOrchestrator();
    const watcher = new PRMergeWatcher(
      makeMockGitHub(),
      makeMockSessions(),
      undefined,
      () => {},
    );
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.handlePushDetected(pr);

    expect(
      vi.mocked(reviewOrchestrator.enqueueReview as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith({
      prNumber: 42,
      repo: 'owner/repo',
      taskId: 'notion:task-abc',
      taskUrl: 'https://notion.so/task-1',
      contextUrl: 'https://notion.so/ctx',
    });
    expect(vi.mocked(setPendingPush)).not.toHaveBeenCalled();
  });

  it('push after verify_failed with review_session_id=null → enqueueReview called', async () => {
    const pr = makePRRow({
      review_session_id: null,
      review_result: JSON.stringify({
        verdict: 'verify_failed',
        summary: 'build failed',
        dimensions: [],
      }),
      head_sha: 'sha-fix',
      last_reviewed_sha: 'sha-old',
      review_iteration: 0,
    });
    vi.mocked(getSession).mockReturnValue({ task_url: '' } as any);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      contextUrl: '',
    } as any);

    const reviewOrchestrator = makeMockReviewOrchestrator();
    const watcher = new PRMergeWatcher(
      makeMockGitHub(),
      makeMockSessions(),
      undefined,
      () => {},
    );
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.handlePushDetected(pr);

    expect(
      vi.mocked(reviewOrchestrator.enqueueReview as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 42, repo: 'owner/repo' }),
    );
    expect(vi.mocked(setPendingPush)).not.toHaveBeenCalled();
  });

  it('push after autofix_failed with review in flight → falls back to setPendingPush', async () => {
    const pr = makePRRow({
      review_session_id: null,
      review_result: JSON.stringify({
        verdict: 'autofix_failed',
        summary: 'lint failed',
        dimensions: [],
      }),
      head_sha: 'sha-fix',
      last_reviewed_sha: 'sha-old',
      review_iteration: 0,
    });
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      contextUrl: '',
    } as any);

    const reviewOrchestrator = makeMockReviewOrchestrator();
    vi.mocked(
      reviewOrchestrator.isReviewInFlight as ReturnType<typeof vi.fn>,
    ).mockReturnValue(true);

    const watcher = new PRMergeWatcher(
      makeMockGitHub(),
      makeMockSessions(),
      undefined,
      () => {},
    );
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.handlePushDetected(pr);

    expect(
      vi.mocked(reviewOrchestrator.enqueueReview as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
    expect(vi.mocked(setPendingPush)).toHaveBeenCalledWith(42, 'owner/repo', 1);
  });

  it('push after autofix_failed but orchestrator not set → falls back to setPendingPush', async () => {
    const pr = makePRRow({
      review_session_id: null,
      review_result: JSON.stringify({
        verdict: 'autofix_failed',
        summary: 'lint failed',
        dimensions: [],
      }),
      head_sha: 'sha-fix',
      last_reviewed_sha: 'sha-old',
      review_iteration: 0,
    });
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      contextUrl: '',
    } as any);

    const watcher = new PRMergeWatcher(
      makeMockGitHub(),
      makeMockSessions(),
      undefined,
      () => {},
    );
    // No orchestrator set

    await watcher.handlePushDetected(pr);

    expect(vi.mocked(setPendingPush)).toHaveBeenCalledWith(42, 'owner/repo', 1);
  });

  it('push after autofix_failed but iteration cap reached → escalates, does not enqueue', async () => {
    const messages: ServerMessage[] = [];
    const pr = makePRRow({
      review_session_id: null,
      review_result: JSON.stringify({
        verdict: 'autofix_failed',
        summary: 'lint failed',
        dimensions: [],
      }),
      head_sha: 'sha-fix',
      last_reviewed_sha: 'sha-old',
      review_iteration: 3, // at cap (default max = 3)
    });
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      contextUrl: '',
    } as any);

    const reviewOrchestrator = makeMockReviewOrchestrator();
    const watcher = new PRMergeWatcher(
      makeMockGitHub(),
      makeMockSessions(),
      undefined,
      (m) => messages.push(m),
    );
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.handlePushDetected(pr);

    expect(
      vi.mocked(reviewOrchestrator.enqueueReview as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
    expect(vi.mocked(setPendingPush)).not.toHaveBeenCalled();
    expect(vi.mocked(setPauseReason)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'max_reviews',
    );
    expect(messages.some((m) => m.type === 'review_escalated')).toBe(true);
  });

  it('push with null review_result and review_session_id=null → original setPendingPush behavior', async () => {
    const pr = makePRRow({
      review_session_id: null,
      review_result: null,
      head_sha: 'sha-fix',
      last_reviewed_sha: null,
      review_iteration: 0,
    });
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      contextUrl: '',
    } as any);

    const reviewOrchestrator = makeMockReviewOrchestrator();
    const watcher = new PRMergeWatcher(
      makeMockGitHub(),
      makeMockSessions(),
      undefined,
      () => {},
    );
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.handlePushDetected(pr);

    expect(
      vi.mocked(reviewOrchestrator.enqueueReview as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
    expect(vi.mocked(setPendingPush)).toHaveBeenCalledWith(42, 'owner/repo', 1);
  });

  it('push with non-gate verdict (needs_changes) and review_session_id=null → setPendingPush', async () => {
    const pr = makePRRow({
      review_session_id: null,
      review_result: JSON.stringify({
        verdict: 'needs_changes',
        summary: 'fix it',
        dimensions: [],
      }),
      head_sha: 'sha-fix',
      last_reviewed_sha: 'sha-old',
      review_iteration: 0,
    });
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      contextUrl: '',
    } as any);

    const reviewOrchestrator = makeMockReviewOrchestrator();
    const watcher = new PRMergeWatcher(
      makeMockGitHub(),
      makeMockSessions(),
      undefined,
      () => {},
    );
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.handlePushDetected(pr);

    expect(
      vi.mocked(reviewOrchestrator.enqueueReview as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
    expect(vi.mocked(setPendingPush)).toHaveBeenCalledWith(42, 'owner/repo', 1);
  });

  it('during-review push (review_session_id set) still uses original re-review path (regression)', async () => {
    const pr = makePRRow({
      review_session_id: 'review-session',
      review_result: JSON.stringify({
        verdict: 'autofix_failed',
        summary: 'lint',
        dimensions: [],
      }),
      head_sha: 'sha-fix',
      last_reviewed_sha: 'sha-old',
      review_iteration: 0,
    });
    const reviewService = makeMockPRReviewService({ verdict: 'approved' });
    const reviewOrchestrator = makeMockReviewOrchestrator();
    const github = makeMockGitHub();
    vi.mocked(github.fetchPR as ReturnType<typeof vi.fn>).mockResolvedValue({
      headSha: 'sha-fix',
    });
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      contextUrl: '',
    } as any);

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      undefined,
      () => {},
    );
    watcher.setPRReviewService(reviewService);
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.handlePushDetected(pr);
    await new Promise((r) => setTimeout(r, 50));

    // enqueueReview should NOT be called — the original re-review path runs
    expect(
      vi.mocked(reviewOrchestrator.enqueueReview as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
    expect(
      vi.mocked(reviewService.reReviewPR as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalled();
  });
});

// ── sweepPendingPushDeadLetters (via poll) ─────────────────────────────────────

describe('PRMergeWatcher — sweepPendingPushDeadLetters', () => {
  it('pending_push=1, no review in flight, shouldAutoReview=true → clears flag and enqueues', async () => {
    const pr = makePRRow({
      pending_push: 1,
      head_sha: 'sha-new',
      last_reviewed_sha: 'sha-old',
      review_iteration: 0,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      contextUrl: 'https://ctx',
    } as any);
    vi.mocked(getSession).mockReturnValue({ task_url: 'https://task' } as any);

    const github = makeMockGitHub();
    vi.mocked(github.getPRState).mockResolvedValue({
      state: 'open',
      headSha: 'sha-new',
    });

    const reviewOrchestrator = makeMockReviewOrchestrator();
    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      undefined,
      () => {},
    );
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.poll();

    expect(vi.mocked(setPendingPush)).toHaveBeenCalledWith(42, 'owner/repo', 0);
    expect(
      vi.mocked(reviewOrchestrator.enqueueReview as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        prNumber: 42,
        repo: 'owner/repo',
        contextUrl: 'https://ctx',
      }),
    );
  });

  it('pending_push=1, review in flight → skips sweep', async () => {
    const pr = makePRRow({
      pending_push: 1,
      head_sha: 'sha-new',
      last_reviewed_sha: 'sha-old',
      review_iteration: 0,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      contextUrl: '',
    } as any);

    const github = makeMockGitHub();
    vi.mocked(github.getPRState).mockResolvedValue({
      state: 'open',
      headSha: 'sha-new',
    });

    const reviewOrchestrator = makeMockReviewOrchestrator();
    vi.mocked(
      reviewOrchestrator.isReviewInFlight as ReturnType<typeof vi.fn>,
    ).mockReturnValue(true);

    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      undefined,
      () => {},
    );
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.poll();

    expect(vi.mocked(setPendingPush)).not.toHaveBeenCalledWith(
      42,
      'owner/repo',
      0,
    );
    expect(
      vi.mocked(reviewOrchestrator.enqueueReview as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });

  it('pending_push=0 → not swept', async () => {
    const pr = makePRRow({
      pending_push: 0,
      head_sha: 'sha-new',
      last_reviewed_sha: 'sha-old',
      review_iteration: 0,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      contextUrl: '',
    } as any);

    const github = makeMockGitHub();
    vi.mocked(github.getPRState).mockResolvedValue({
      state: 'open',
      headSha: 'sha-new',
    });

    const reviewOrchestrator = makeMockReviewOrchestrator();
    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      undefined,
      () => {},
    );
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.poll();

    expect(
      vi.mocked(reviewOrchestrator.enqueueReview as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });

  it('pending_push=1 but head_sha === last_reviewed_sha → shouldAutoReview=false, skips', async () => {
    const pr = makePRRow({
      pending_push: 1,
      head_sha: 'sha-same',
      last_reviewed_sha: 'sha-same',
      review_iteration: 0,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      contextUrl: '',
    } as any);

    const github = makeMockGitHub();
    vi.mocked(github.getPRState).mockResolvedValue({
      state: 'open',
      headSha: 'sha-same',
    });

    const reviewOrchestrator = makeMockReviewOrchestrator();
    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      undefined,
      () => {},
    );
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.poll();

    expect(
      vi.mocked(reviewOrchestrator.enqueueReview as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
    expect(vi.mocked(setPendingPush)).not.toHaveBeenCalledWith(
      42,
      'owner/repo',
      0,
    );
  });

  it('pending_push=1, iteration cap reached → shouldAutoReview=false, skips', async () => {
    const pr = makePRRow({
      pending_push: 1,
      head_sha: 'sha-new',
      last_reviewed_sha: 'sha-old',
      review_iteration: 3, // at default cap
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      contextUrl: '',
    } as any);

    const github = makeMockGitHub();
    vi.mocked(github.getPRState).mockResolvedValue({
      state: 'open',
      headSha: 'sha-new',
    });

    const reviewOrchestrator = makeMockReviewOrchestrator();
    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      undefined,
      () => {},
    );
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.poll();

    expect(
      vi.mocked(reviewOrchestrator.enqueueReview as ReturnType<typeof vi.fn>),
    ).not.toHaveBeenCalled();
  });

  it('sweeps multiple pending_push PRs in one poll cycle', async () => {
    const pr1 = makePRRow({
      id: 1,
      pr_number: 10,
      pending_push: 1,
      head_sha: 'sha-a',
      last_reviewed_sha: 'sha-old',
      review_iteration: 0,
    });
    const pr2 = makePRRow({
      id: 2,
      pr_number: 20,
      pending_push: 1,
      head_sha: 'sha-b',
      last_reviewed_sha: 'sha-old',
      review_iteration: 0,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr1, pr2]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      contextUrl: '',
    } as any);
    vi.mocked(getSession).mockReturnValue({ task_url: '' } as any);

    const github = makeMockGitHub();
    vi.mocked(github.getPRState).mockResolvedValue({
      state: 'open',
      headSha: null,
    });

    const reviewOrchestrator = makeMockReviewOrchestrator();
    const watcher = new PRMergeWatcher(
      github,
      makeMockSessions(),
      undefined,
      () => {},
    );
    watcher.setReviewOrchestrator(reviewOrchestrator);

    await watcher.poll();

    expect(vi.mocked(setPendingPush)).toHaveBeenCalledWith(10, 'owner/repo', 0);
    expect(vi.mocked(setPendingPush)).toHaveBeenCalledWith(20, 'owner/repo', 0);
    expect(
      vi.mocked(reviewOrchestrator.enqueueReview as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledTimes(2);
  });

  it('integration: gate failure → push after exit → review fires without operator intervention (#608 ordering)', async () => {
    // Step 1: PR is in autofix_failed state (gate ran, review_session_id=NULL)
    const prAfterGateFailure = makePRRow({
      review_session_id: null,
      review_result: JSON.stringify({
        verdict: 'autofix_failed',
        summary: 'lint exit 1',
        dimensions: [],
      }),
      head_sha: 'sha-d8ff855',
      last_reviewed_sha: 'sha-d8ff855',
      review_iteration: 0,
      pending_push: 0,
    });

    // Step 2: Implementing session pushes a fix — head_sha changes to new commit
    const prAfterFix = {
      ...prAfterGateFailure,
      head_sha: 'sha-b47c5ca',
      last_reviewed_sha: 'sha-d8ff855',
    };

    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      contextUrl: 'https://ctx',
    } as any);
    vi.mocked(getSession).mockReturnValue({
      task_url: 'https://task',
      worktree_path: '/wt',
    } as any);

    const reviewOrchestrator = makeMockReviewOrchestrator();
    const watcher = new PRMergeWatcher(
      makeMockGitHub(),
      makeMockSessions(),
      undefined,
      () => {},
    );
    watcher.setReviewOrchestrator(reviewOrchestrator);

    // handlePushDetected fires when the fix is pushed — review_session_id=NULL, gate-failure verdict
    await watcher.handlePushDetected(prAfterFix);

    // Review is enqueued directly — no pending_push dead letter
    expect(
      vi.mocked(reviewOrchestrator.enqueueReview as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 42, repo: 'owner/repo' }),
    );
    expect(vi.mocked(setPendingPush)).not.toHaveBeenCalled();
  });
});

// ── start() — immediate first poll ────────────────────────────────────────────

describe('PRMergeWatcher.start()', () => {
  it('fires one poll immediately on start before any interval tick', () => {
    vi.useFakeTimers();
    const watcher = new PRMergeWatcher(
      makeMockGitHub(),
      makeMockSessions(),
      undefined,
      () => {},
    );
    const pollSpy = vi.spyOn(watcher, 'poll').mockResolvedValue(undefined);

    watcher.start(60_000);

    expect(pollSpy).toHaveBeenCalledTimes(1);
    watcher.stop();
    vi.useRealTimers();
  });

  it('second start() is a no-op — no extra immediate poll or extra timer', () => {
    vi.useFakeTimers();
    const watcher = new PRMergeWatcher(
      makeMockGitHub(),
      makeMockSessions(),
      undefined,
      () => {},
    );
    const pollSpy = vi.spyOn(watcher, 'poll').mockResolvedValue(undefined);

    watcher.start(60_000);
    watcher.start(60_000);

    expect(pollSpy).toHaveBeenCalledTimes(1);
    watcher.stop();
    vi.useRealTimers();
  });

  it('poll error in the immediate call is caught and logged, not thrown', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const watcher = new PRMergeWatcher(
      makeMockGitHub(),
      makeMockSessions(),
      undefined,
      () => {},
    );
    vi.spyOn(watcher, 'poll').mockRejectedValue(new Error('boom'));

    expect(() => watcher.start(60_000)).not.toThrow();
    await vi.runAllTimersAsync();

    expect(warnSpy).toHaveBeenCalledWith(
      '[PRMergeWatcher] poll error:',
      'boom',
    );
    warnSpy.mockRestore();
    watcher.stop();
    vi.useRealTimers();
  });
});

// ── conflict nudge: shared helper, SHA dedup, audit on failure ────────────────

describe('PRMergeWatcher conflict nudge', () => {
  function mockCategorizeConflict(github: GitHubClient): void {
    vi.mocked(
      (github as unknown as { categorizeMergeability: () => Promise<unknown> }).categorizeMergeability,
    ).mockResolvedValue({
      category: 'conflict',
      mergeState: 'dirty',
      rawMergeableState: 'dirty',
      failingChecks: [],
      headSha: 'sha-abc',
    });
  }

  it('nudges session even when already dirty (no stateChanged gate — first-poll case)', async () => {
    const pr = makePRRow({
      merge_state: 'dirty',
      session_id: 'coding-session',
      head_sha: 'sha-abc',
      conflict_nudge_sha: null,
      review_result: JSON.stringify({ verdict: 'approved' }),
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    vi.mocked(getPRByNumber).mockReturnValue({ ...pr });
    const github = makeMockGitHub();
    mockCategorizeConflict(github);
    const sessions = makeMockSessions();

    const watcher = new PRMergeWatcher(github, sessions, undefined, () => {});
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/tmp',
    } as ReturnType<typeof getProjectByGithubRepo>);
    await watcher.poll();

    expect(vi.mocked(sessions.sendOrResume)).toHaveBeenCalledWith(
      'coding-session',
      expect.stringContaining('Rebase'),
    );
    expect(vi.mocked(setConflictNudgeSha)).toHaveBeenCalledWith(42, 'owner/repo', 'sha-abc');
  });

  it('failed conflict nudge delivery emits audit event (conflict_nudge_delivery_failed)', async () => {
    const pr = makePRRow({
      merge_state: 'clean',
      session_id: 'coding-session',
      head_sha: 'sha-abc',
      conflict_nudge_sha: null,
      review_result: JSON.stringify({ verdict: 'approved' }),
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    vi.mocked(getPRByNumber).mockReturnValue({ ...pr });
    const github = makeMockGitHub();
    vi.mocked(
      (github as unknown as { categorizeMergeability: () => Promise<unknown> }).categorizeMergeability,
    ).mockResolvedValue({
      category: 'conflict',
      mergeState: 'dirty',
      rawMergeableState: 'dirty',
      failingChecks: [],
      headSha: 'sha-abc',
    });
    const sessions = makeMockSessions();
    vi.mocked(sessions.sendOrResume).mockRejectedValueOnce(new Error('session gone'));
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/tmp',
    } as ReturnType<typeof getProjectByGithubRepo>);

    const watcher = new PRMergeWatcher(github, sessions, undefined, () => {});
    await watcher.poll();

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'conflict_nudge_delivery_failed',
        payload: expect.objectContaining({
          pr_number: 42,
          session_id: 'coding-session',
          cause: 'conflict',
        }),
      }),
    );
  });

  it('integration: conflicted PR is paused → session nudged → new push still-conflicting → re-nudged', async () => {
    // First poll: PR is clean, no nudge
    const pr1 = makePRRow({
      merge_state: 'clean',
      session_id: 'coding-session',
      head_sha: 'sha-v1',
      conflict_nudge_sha: null,
      review_result: JSON.stringify({ verdict: 'approved' }),
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr1]);
    vi.mocked(getPRByNumber).mockReturnValue({ ...pr1 });
    const github = makeMockGitHub();
    vi.mocked(
      (github as unknown as { categorizeMergeability: () => Promise<unknown> }).categorizeMergeability,
    ).mockResolvedValue({
      category: 'conflict',
      mergeState: 'dirty',
      rawMergeableState: 'dirty',
      failingChecks: [],
      headSha: 'sha-v1',
    });
    const sessions = makeMockSessions();
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/tmp',
    } as ReturnType<typeof getProjectByGithubRepo>);

    const watcher = new PRMergeWatcher(github, sessions, undefined, () => {});
    await watcher.poll();

    // First poll: nudge sent for sha-v1
    expect(vi.mocked(sessions.sendOrResume)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setConflictNudgeSha)).toHaveBeenCalledWith(42, 'owner/repo', 'sha-v1');

    vi.clearAllMocks();

    // Second poll: same SHA, nudge sha matches — no re-nudge (clearStalePauses re-fail)
    const pr2 = { ...pr1, conflict_nudge_sha: 'sha-v1' };
    vi.mocked(getAllOpenPRs).mockReturnValue([pr2]);
    vi.mocked(getPRByNumber).mockReturnValue(pr2);
    vi.mocked(
      (github as unknown as { categorizeMergeability: () => Promise<unknown> }).categorizeMergeability,
    ).mockResolvedValue({
      category: 'conflict',
      mergeState: 'dirty',
      rawMergeableState: 'dirty',
      failingChecks: [],
      headSha: 'sha-v1',
    });
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/tmp',
    } as ReturnType<typeof getProjectByGithubRepo>);

    await watcher.poll();
    expect(vi.mocked(sessions.sendOrResume)).not.toHaveBeenCalled();

    vi.clearAllMocks();

    // Third poll: new push (sha-v2) still conflicted → re-nudge
    const pr3 = { ...pr1, head_sha: 'sha-v2', conflict_nudge_sha: 'sha-v1' };
    vi.mocked(getAllOpenPRs).mockReturnValue([pr3]);
    vi.mocked(getPRByNumber).mockReturnValue(pr3);
    vi.mocked(
      (github as unknown as { categorizeMergeability: () => Promise<unknown> }).categorizeMergeability,
    ).mockResolvedValue({
      category: 'conflict',
      mergeState: 'dirty',
      rawMergeableState: 'dirty',
      failingChecks: [],
      headSha: 'sha-v2',
    });
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/tmp',
    } as ReturnType<typeof getProjectByGithubRepo>);

    await watcher.poll();
    expect(vi.mocked(sessions.sendOrResume)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setConflictNudgeSha)).toHaveBeenCalledWith(42, 'owner/repo', 'sha-v2');
  });
});
