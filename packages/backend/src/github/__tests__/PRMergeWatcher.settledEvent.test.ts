import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Regression coverage for subscribing PRMergeWatcher to testRequestLane's
// in-process settle broadcast, so a PR's F2 gate is re-checked the moment
// its full-suite run settles instead of waiting for the next poll tick.

// ── Module mocks ──────────────────────────────────────────────────────────────

const laneEvents = new EventEmitter();

vi.mock('../../orchestration/testRequestLane', () => ({
  evaluateF2LaneFlakyDisposition: vi.fn().mockReturnValue(true),
  runProjectTestRequest: vi.fn(),
  testRequestLaneEvents: laneEvents,
}));

vi.mock('../../db/queries', () => ({
  getAllOpenPRs: vi.fn().mockReturnValue([]),
  getPRByNumber: vi.fn(),
  updatePRState: vi.fn(),
  updateMergeState: vi.fn(),
  setPauseReason: vi.fn(),
  setCiRemediationAttemptedSha: vi.fn(),
  getSession: vi.fn(),
  addAutofixSha: vi.fn(),
  consumeAutofixSha: vi.fn().mockReturnValue(false),
  deleteAllAutofixShasForPR: vi.fn(),
  setHeadSha: vi.fn(),
  setLastReviewedSha: vi.fn(),
  setPRReviewResult: vi.fn(),
  setPendingPush: vi.fn(),
  getLatestTestRequestRun: vi.fn().mockReturnValue(undefined),
  markSessionDone: vi.fn(),
  updateSessionStatus: vi.fn(),
  recordPrAnchoredCompletingSignal: vi.fn(),
  clearTerminalPRFlags: vi.fn(),
  setHeadBranch: vi.fn(),
  clearSessionInitiatedPRClose: vi.fn(),
  incrementFlakeRecoveryAttempts: vi.fn(),
  resetFlakeRecoveryAttempts: vi.fn(),
  recordMergeCommitForSession: vi.fn(),
  setConflictNudgeSha: vi.fn(),
  setPreReviewStage: vi.fn(),
}));

vi.mock('../../config', () => ({
  getProjectByGithubRepo: vi.fn(),
  AUTO_REVIEW_ENABLED: true,
}));

vi.mock('../../config/settings', () => ({
  typedGetSetting: vi.fn().mockReturnValue(2),
}));

vi.mock('../../session/orchestrator-config', () => ({
  resolvePreGrantCapabilities: vi.fn(() => []),
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    ci_check_name: [],
    test: ['npm run test'],
    test_timeout_sec: 300,
  }),
}));

vi.mock('../../session/autofix-runner', () => ({
  loadAutofixCommands: vi.fn().mockReturnValue([]),
  runAutofix: vi.fn().mockResolvedValue({ success: true, summary: 'no diff' }),
  getChangedFiles: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../session/analyzeGating', () => ({
  computeWholeTreeContentHash: vi.fn(),
}));

vi.mock('../../audit/AuditLog', () => ({ recordEvent: vi.fn() }));

vi.mock('../../audit/flakyRemediationFiling', () => ({
  closeFlakyRemediationTaskIfLinked: vi.fn(),
}));

vi.mock('../../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));

vi.mock('../conflictNudge', () => ({ sendConflictNudge: vi.fn() }));

vi.mock('../pollUtils', () => ({
  isTerminalStalePR: vi.fn().mockReturnValue(false),
}));

import { PRMergeWatcher } from '../PRMergeWatcher';
import {
  getAllOpenPRs,
  getPRByNumber,
  getSession,
} from '../../db/queries';
import { getProjectByGithubRepo } from '../../config';
import { computeWholeTreeContentHash } from '../../session/analyzeGating';
import { runProjectTestRequest } from '../../orchestration/testRequestLane';
import { isTerminalStalePR } from '../pollUtils';
import {
  recordGitHubRateLimit,
  __resetGitHubRateLimitForTests,
} from '../rateLimitBackoff';
import { GitHubRateLimitError } from '../types';
import type { GitHubClient } from '../GitHubClient';
import type { SessionManager } from '../../session/SessionManager';
import type { PullRequestRow } from '../../db/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const REPO = 'owner/repo';
const PROJECT_ID = 'proj-1';

function makePRRow(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: 1,
    pr_url: `https://github.com/${REPO}/pull/1`,
    task_id: 'task-abc',
    session_id: 'session-1',
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
    review_session_id: null,
    review_iteration: 0,
    head_sha: 'sha-1',
    last_reviewed_sha: null,
    node_id: null,
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
    failing_checks: null,
    pending_push: 0,
    ci_remediation_attempted_sha: null,
    pause_reason: null,
    pause_reason_set_at: null,
    pre_review_stage: null,
    conflict_nudge_sha: null,
    stalled_pr_retry_count: 0,
    session_initiated_close_at: null,
    reviewer_requested_at: null,
    flake_recovery_attempts: 0,
    reconcile_exhausted: 0,
    ...overrides,
  } as PullRequestRow;
}

function makeMockGitHub(): GitHubClient {
  return {
    getPRState: vi.fn().mockResolvedValue({ state: 'open', headSha: 'sha-1' }),
    categorizeMergeability: vi.fn().mockResolvedValue({
      category: 'clean',
      mergeState: 'clean',
      rawMergeableState: 'clean',
      failingChecks: [],
      headSha: 'sha-1',
    }),
  } as unknown as GitHubClient;
}

function makeMockSessions(): SessionManager {
  return {
    on: vi.fn(),
    off: vi.fn(),
    sendOrResume: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionManager;
}

/** Worktree path per session id — computeWholeTreeContentHash's mock derives its hash from this. */
const WORKTREE_BY_SESSION: Record<string, string> = {
  'session-1': '/proj/worktree-1',
  'session-2': '/proj/worktree-2',
};

describe('PRMergeWatcher — testRequestLane settled-event subscription', () => {
  let watcher: PRMergeWatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetGitHubRateLimitForTests();
    laneEvents.removeAllListeners();

    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: PROJECT_ID,
      projectDir: '/proj',
    } as never);
    vi.mocked(getSession).mockImplementation(
      (sessionId: string) =>
        ({
          worktree_path: WORKTREE_BY_SESSION[sessionId] ?? null,
        }) as never,
    );
    vi.mocked(computeWholeTreeContentHash).mockImplementation(
      async (worktreePath: string) => `hash-of-${worktreePath}`,
    );
    vi.mocked(isTerminalStalePR).mockReturnValue(false);

    watcher = new PRMergeWatcher(
      makeMockGitHub(),
      makeMockSessions(),
      undefined,
      () => {},
    );
  });

  afterEach(() => {
    laneEvents.removeAllListeners();
    __resetGitHubRateLimitForTests();
  });

  /** Primes lastContentHashByPR for `pr` via a read-only mergeability pass. */
  async function primeContentHash(pr: PullRequestRow): Promise<void> {
    vi.mocked(getPRByNumber).mockReturnValueOnce(pr);
    await watcher.checkMergeabilityNow(pr.pr_number, pr.repo);
  }

  it('re-checks exactly the open PR matching the settled content hash, and none other', async () => {
    const pr1 = makePRRow({ pr_number: 1, session_id: 'session-1' });
    const pr2 = makePRRow({ pr_number: 2, session_id: 'session-2' });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr1, pr2]);

    await primeContentHash(pr1);
    await primeContentHash(pr2);

    const spy = vi
      .spyOn(watcher, 'checkMergeabilityNow')
      .mockResolvedValue(undefined);

    laneEvents.emit('settled', {
      projectId: PROJECT_ID,
      contentHash: `hash-of-${WORKTREE_BY_SESSION['session-1']}`,
      runKind: 'full',
      state: 'passed',
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(pr1.pr_number, REPO);
  });

  it('re-checks a PR at most once for the same (pr, contentHash) settle', async () => {
    const pr1 = makePRRow({ pr_number: 1, session_id: 'session-1' });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr1]);

    await primeContentHash(pr1);

    const spy = vi
      .spyOn(watcher, 'checkMergeabilityNow')
      .mockResolvedValue(undefined);

    const settledEvent = {
      projectId: PROJECT_ID,
      contentHash: `hash-of-${WORKTREE_BY_SESSION['session-1']}`,
      runKind: 'full' as const,
      state: 'passed' as const,
    };
    laneEvents.emit('settled', settledEvent);
    laneEvents.emit('settled', settledEvent);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does nothing while the GitHub rate limit is active', async () => {
    const pr1 = makePRRow({ pr_number: 1, session_id: 'session-1' });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr1]);

    await primeContentHash(pr1);

    recordGitHubRateLimit(
      new GitHubRateLimitError(
        'rate limited',
        new Date(Date.now() + 60_000),
        5000,
        5000,
      ),
      '[test]',
    );

    const spy = vi
      .spyOn(watcher, 'checkMergeabilityNow')
      .mockResolvedValue(undefined);

    laneEvents.emit('settled', {
      projectId: PROJECT_ID,
      contentHash: `hash-of-${WORKTREE_BY_SESSION['session-1']}`,
      runKind: 'full',
      state: 'passed',
    });

    expect(spy).not.toHaveBeenCalled();
  });

  it('does nothing for a stalled_reconcile_cap-parked PR', async () => {
    const pr1 = makePRRow({ pr_number: 1, session_id: 'session-1' });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr1]);

    await primeContentHash(pr1);

    vi.mocked(isTerminalStalePR).mockReturnValue(true);

    const spy = vi
      .spyOn(watcher, 'checkMergeabilityNow')
      .mockResolvedValue(undefined);

    laneEvents.emit('settled', {
      projectId: PROJECT_ID,
      contentHash: `hash-of-${WORKTREE_BY_SESSION['session-1']}`,
      runKind: 'full',
      state: 'passed',
    });

    expect(spy).not.toHaveBeenCalled();
  });

  it('never calls runProjectTestRequest — the handler is a reader, never a trigger', async () => {
    const pr1 = makePRRow({ pr_number: 1, session_id: 'session-1' });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr1]);

    await primeContentHash(pr1);

    laneEvents.emit('settled', {
      projectId: PROJECT_ID,
      contentHash: `hash-of-${WORKTREE_BY_SESSION['session-1']}`,
      runKind: 'full',
      state: 'passed',
    });

    expect(runProjectTestRequest).not.toHaveBeenCalled();
  });
});
