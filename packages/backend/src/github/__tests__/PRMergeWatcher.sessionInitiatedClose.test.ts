import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../config', () => ({
  getProjectByGithubRepo: vi.fn(),
  AUTO_REVIEW_ENABLED: true,
}));
vi.mock('../../config/settings', () => ({
  typedGetSetting: vi.fn().mockReturnValue(5),
}));
vi.mock('../../session/orchestrator-config', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    test: [],
    test_timeout_sec: 300,
    test_max_rss_mb: 0,
    test_fail_fast: true,
  }),
}));
vi.mock('../../session/autofix-runner', () => ({
  loadAutofixCommands: vi.fn().mockReturnValue([]),
  runAutofix: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../audit/AuditLog', () => ({ recordEvent: vi.fn() }));
vi.mock('../../db/queries', () => ({
  getAllOpenPRs: vi.fn().mockReturnValue([]),
  getPRByNumber: vi.fn(),
  updatePRState: vi.fn(),
  updateMergeState: vi.fn(),
  setPauseReason: vi.fn(),
  setCiRemediationAttemptedSha: vi.fn(),
  getSession: vi.fn().mockReturnValue(null),
  addAutofixSha: vi.fn(),
  consumeAutofixSha: vi.fn().mockReturnValue(null),
  deleteAllAutofixShasForPR: vi.fn(),
  setHeadSha: vi.fn(),
  setHeadBranch: vi.fn(),
  setLastReviewedSha: vi.fn(),
  setPRReviewResult: vi.fn(),
  setPendingPush: vi.fn(),
  getTestResult: vi.fn().mockReturnValue(null),
  markSessionDone: vi.fn(),
  setPreReviewStage: vi.fn(),
  clearTerminalPRFlags: vi.fn(),
  clearSessionInitiatedPRClose: vi.fn(),
  updateSessionStatus: vi.fn(),
}));
vi.mock('../../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));
vi.mock('../reviewUtils', () => ({
  formatCIFailureFeedback: vi.fn(),
  shouldAutoReview: vi.fn().mockReturnValue(true),
  formatReviewFeedback: vi.fn().mockReturnValue('feedback'),
  truncateLog: vi.fn((s: string) => s),
  CI_LOG_EXCERPT_CAP: 4000,
}));
vi.mock('../conflictNudge', () => ({ sendConflictNudge: vi.fn() }));
vi.mock('../pollUtils', () => ({
  isTerminalStalePR: vi.fn().mockReturnValue(false),
}));
vi.mock('../../db/pauseReason', () => ({
  parsePauseReason: vi.fn().mockReturnValue(null),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { PRMergeWatcher } from '../PRMergeWatcher';
import {
  getAllOpenPRs,
  getPRByNumber,
  updatePRState,
  getSession,
  setHeadBranch,
  setHeadSha,
  clearTerminalPRFlags,
  clearSessionInitiatedPRClose,
} from '../../db/queries';
import { typedGetSetting } from '../../config/settings';
import { getProjectByGithubRepo } from '../../config';
import type { GitHubClient } from '../GitHubClient';
import type { SessionManager } from '../../session/SessionManager';
import type { PullRequestRow } from '../../db/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PR_NUMBER = 42;
const REPO = 'owner/repo';
const CODING_SESSION_ID = 'coding-session';
const REVIEW_SESSION_ID = 'review-session';

function makePRRow(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: PR_NUMBER,
    pr_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
    task_id: 'notion:task-abc',
    session_id: CODING_SESSION_ID,
    repo: REPO,
    title: 'feat: test',
    body: null,
    head_branch: 'feature/test',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: null,
    review_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    synced_at: '2024-01-01T00:00:00Z',
    review_session_id: REVIEW_SESSION_ID,
    review_iteration: 0,
    head_sha: 'old-sha',
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
    conflict_nudge_sha: null,
    stalled_pr_retry_count: 0,
    session_initiated_close_at: null,
    ...overrides,
  };
}

function makeGithubClient(
  overrides: Partial<Record<string, unknown>> = {},
): GitHubClient {
  return {
    getPRState: vi.fn().mockResolvedValue({ state: 'closed', headSha: null }),
    fetchPR: vi.fn().mockResolvedValue({
      headBranch: 'feature/test',
      headSha: 'new-sha',
      state: 'open',
    }),
    listOpenPRStates: vi.fn(),
    ...overrides,
  } as unknown as GitHubClient;
}

function makeSessionManager(): SessionManager {
  return {
    endSession: vi.fn(),
    sendOrResume: vi.fn().mockResolvedValue('review-session-id'),
    markSessionErrored: vi.fn(),
  } as unknown as SessionManager;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(typedGetSetting).mockReturnValue(5); // 5-minute grace default
  vi.mocked(getProjectByGithubRepo).mockReturnValue({
    id: 'project-abc',
    projectDir: '/repo',
    contextUrl: 'https://notion.so/project-abc',
    baseBranch: 'dev',
    githubRepo: REPO,
  } as never);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PRMergeWatcher — session-initiated PR close churn recovery', () => {
  it('defers terminalization when close is session-initiated and coding session is non-terminal (within grace)', async () => {
    const pr = makePRRow({
      session_initiated_close_at: Date.now() - 1_000, // 1s ago, well within 5m grace
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    vi.mocked(getSession).mockReturnValue({ status: 'running' } as never);

    const github = makeGithubClient({
      getPRState: vi.fn().mockResolvedValue({ state: 'closed', headSha: null }),
    });
    const sessions = makeSessionManager();
    const broadcast = vi.fn();

    const watcher = new PRMergeWatcher(github, sessions, undefined, broadcast);
    await watcher.poll();

    expect(sessions.markSessionErrored).not.toHaveBeenCalled();
    expect(updatePRState).not.toHaveBeenCalledWith(PR_NUMBER, REPO, 'closed');
    expect(clearSessionInitiatedPRClose).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'pr_closed' }),
    );
  });

  it('reconciles when the PR is reopened: state=open, head_branch/head_sha restored, error cleared', async () => {
    const pr = makePRRow({
      state: 'open',
      session_initiated_close_at: Date.now() - 1_000,
      head_sha: 'old-sha',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    vi.mocked(getSession).mockReturnValue({ status: 'running' } as never);
    vi.mocked(getPRByNumber).mockReturnValue(
      makePRRow({ head_sha: 'new-sha', head_branch: 'feature/test' }),
    );

    const github = makeGithubClient({
      getPRState: vi
        .fn()
        .mockResolvedValue({ state: 'open', headSha: 'new-sha' }),
      fetchPR: vi.fn().mockResolvedValue({
        headBranch: 'feature/test',
        headSha: 'new-sha',
        state: 'open',
      }),
    });
    const sessions = makeSessionManager();
    const broadcast = vi.fn();

    const watcher = new PRMergeWatcher(github, sessions, undefined, broadcast);
    await watcher.poll();

    expect(updatePRState).toHaveBeenCalledWith(PR_NUMBER, REPO, 'open');
    expect(setHeadBranch).toHaveBeenCalledWith(PR_NUMBER, REPO, 'feature/test');
    expect(setHeadSha).toHaveBeenCalledWith(PR_NUMBER, REPO, 'new-sha');
    expect(clearTerminalPRFlags).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'session_reconciled',
    );
    expect(clearSessionInitiatedPRClose).toHaveBeenCalledWith(PR_NUMBER, REPO);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'pr_reconciled', prNumber: PR_NUMBER }),
    );
    expect(sessions.markSessionErrored).not.toHaveBeenCalled();
  });

  it('terminalizes when the coding session is already terminal (no reopen)', async () => {
    const pr = makePRRow({
      session_initiated_close_at: Date.now() - 1_000,
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    vi.mocked(getSession).mockReturnValue({ status: 'error' } as never);

    const github = makeGithubClient({
      getPRState: vi.fn().mockResolvedValue({ state: 'closed', headSha: null }),
    });
    const sessions = makeSessionManager();
    const broadcast = vi.fn();

    const watcher = new PRMergeWatcher(github, sessions, undefined, broadcast);
    await watcher.poll();

    expect(updatePRState).toHaveBeenCalledWith(PR_NUMBER, REPO, 'closed');
    expect(sessions.markSessionErrored).toHaveBeenCalledWith(
      CODING_SESSION_ID,
      'error',
      'pr_closed',
    );
    expect(clearSessionInitiatedPRClose).toHaveBeenCalledWith(PR_NUMBER, REPO);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'pr_closed', prNumber: PR_NUMBER }),
    );
  });

  it('terminalizes once the grace period expires without a reopen', async () => {
    const pr = makePRRow({
      session_initiated_close_at: Date.now() - 10 * 60_000, // 10 min ago > 5m grace
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    vi.mocked(getSession).mockReturnValue({ status: 'running' } as never);

    const github = makeGithubClient({
      getPRState: vi.fn().mockResolvedValue({ state: 'closed', headSha: null }),
    });
    const sessions = makeSessionManager();
    const broadcast = vi.fn();

    const watcher = new PRMergeWatcher(github, sessions, undefined, broadcast);
    await watcher.poll();

    expect(updatePRState).toHaveBeenCalledWith(PR_NUMBER, REPO, 'closed');
    expect(sessions.markSessionErrored).toHaveBeenCalledWith(
      CODING_SESSION_ID,
      'error',
      'pr_closed',
    );
    expect(clearSessionInitiatedPRClose).toHaveBeenCalledWith(PR_NUMBER, REPO);
  });

  it('terminalizes immediately on a human close (no session-initiated mark) — unchanged behavior', async () => {
    const pr = makePRRow({ session_initiated_close_at: null });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    vi.mocked(getSession).mockReturnValue({ status: 'running' } as never);

    const github = makeGithubClient({
      getPRState: vi.fn().mockResolvedValue({ state: 'closed', headSha: null }),
    });
    const sessions = makeSessionManager();
    const broadcast = vi.fn();

    const watcher = new PRMergeWatcher(github, sessions, undefined, broadcast);
    await watcher.poll();

    expect(updatePRState).toHaveBeenCalledWith(PR_NUMBER, REPO, 'closed');
    expect(sessions.markSessionErrored).toHaveBeenCalledWith(
      CODING_SESSION_ID,
      'error',
      'pr_closed',
    );
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'pr_closed', prNumber: PR_NUMBER }),
    );
  });
});
