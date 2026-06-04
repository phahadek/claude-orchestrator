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
  } as unknown as ReviewOrchestrator;
}

function makeMockSessions(): SessionManager {
  return {
    endSession: vi.fn(),
    sendOrResume: vi.fn().mockResolvedValue('session-id'),
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

  it('calls sendOrResume when merge_state transitions to dirty', async () => {
    const pr = makePRRow({
      merge_state: 'clean',
      session_id: 'coding-session',
      base_branch: 'dev',
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
      'PR #42 has merge conflicts with the base branch. Rebase onto `dev`, resolve the conflicts, and push the fixed branch.',
    );
  });

  it('does NOT call sendOrResume when merge_state is already dirty', async () => {
    const pr = makePRRow({
      merge_state: 'dirty',
      session_id: 'coding-session',
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
    );
  });
});
