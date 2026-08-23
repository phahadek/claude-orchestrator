/**
 * Base-attributable-failures exemption for PRMergeWatcher's
 * flake_recovery_attempts — see baseAttribution.ts.
 *  - a verified-flaky re-run that still fails, confirmed base-attributable
 *    (base tree total_fail), never charges the counter, and marks
 *    flake_recovery_base_exhausted.
 *  - once already exhausted (paused with flake-recovery-exhausted), a PR
 *    whose flake_recovery_base_exhausted flag is set has resetFlakeRecoveryAttempts()
 *    called — the same reset a passing re-run already uses — the next time
 *    base comes back clean_pass, scoped to that PR alone.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/queries', () => ({
  getAllOpenPRs: vi.fn().mockReturnValue([]),
  getPRByNumber: vi.fn(),
  updatePRState: vi.fn(),
  updateMergeState: vi.fn(),
  setPauseReason: vi.fn(),
  setCiRemediationAttemptedSha: vi.fn(),
  getSession: vi.fn().mockReturnValue(null),
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
  setPreReviewStage: vi.fn(),
  clearTerminalPRFlags: vi.fn(),
  setConflictNudgeSha: vi.fn(),
  setHeadBranch: vi.fn(),
  clearSessionInitiatedPRClose: vi.fn(),
  incrementFlakeRecoveryAttempts: vi.fn(),
  resetFlakeRecoveryAttempts: vi.fn(),
  setFlakeRecoveryBaseExhausted: vi.fn(),
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
  loadOrchestratorConfig: vi
    .fn()
    .mockReturnValue({ ci_check_name: [], test: [], test_timeout_sec: 300 }),
}));

vi.mock('../../session/autofix-runner', () => ({
  loadAutofixCommands: vi.fn().mockReturnValue([]),
  runAutofix: vi.fn().mockResolvedValue({ success: true, summary: 'no diff' }),
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));

vi.mock('../conflictNudge', () => ({ sendConflictNudge: vi.fn() }));

vi.mock('../pollUtils', () => ({
  isTerminalStalePR: vi.fn().mockReturnValue(false),
}));

vi.mock('../../orchestration/baseAttribution', () => ({
  isBaseTotalFail: vi.fn(),
  isProjectBaseHealthy: vi.fn(),
  hasBaseTotalFailSince: vi.fn(),
}));

import { PRMergeWatcher } from '../PRMergeWatcher';
import {
  getPRByNumber,
  setPauseReason,
  getSession,
  incrementFlakeRecoveryAttempts,
  resetFlakeRecoveryAttempts,
  setFlakeRecoveryBaseExhausted,
} from '../../db/queries';
import { recordEvent } from '../../audit/AuditLog';
import { getProjectByGithubRepo } from '../../config';
import { typedGetSetting } from '../../config/settings';
import {
  isBaseTotalFail,
  isProjectBaseHealthy,
  hasBaseTotalFailSince,
} from '../../orchestration/baseAttribution';
import {
  pauseReasonFromCanonical,
  serializePauseReason,
} from '../../db/pauseReason';
import type { GitHubClient } from '../GitHubClient';
import type { SessionManager } from '../../session/SessionManager';
import type { AutoMerger } from '../AutoMerger';
import type { PullRequestRow } from '../../db/types';
import type { VerifiedFlakyDispositionPayload } from '../types';

const PR_NUMBER = 1715;
const REPO = 'owner/repo';
const HEAD_SHA = 'sha-flaky-1';

const CI_FAILING_PAUSE = serializePauseReason(
  pauseReasonFromCanonical('ci_failing'),
);

function makePRRow(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: PR_NUMBER,
    pr_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
    task_id: 'task-abc',
    session_id: 'coding-session',
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
    head_sha: HEAD_SHA,
    last_reviewed_sha: null,
    node_id: null,
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
    failing_checks: null,
    pending_push: 0,
    pause_reason: CI_FAILING_PAUSE,
    pause_reason_set_at: Date.now(),
    ci_remediation_attempted_sha: HEAD_SHA,
    pre_review_stage: null,
    conflict_nudge_sha: null,
    stalled_pr_retry_count: 0,
    stalled_retry_base_exhausted: 0,
    session_initiated_close_at: null,
    reviewer_requested_at: null,
    flake_recovery_attempts: 0,
    flake_recovery_base_exhausted: 0,
    human_merge_only: 0,
    pr_intent_id: null,
    ...overrides,
  };
}

function makePayload(
  overrides: Partial<VerifiedFlakyDispositionPayload> = {},
): VerifiedFlakyDispositionPayload {
  return {
    sessionId: 'coding-session',
    prNumber: PR_NUMBER,
    repo: REPO,
    headSha: HEAD_SHA,
    disposition: { gate: 'ci', reason: 'xdist/Postgres contention' },
    ...overrides,
  };
}

function makeMockGitHub(): GitHubClient {
  return {
    rerunFailedJobs: vi.fn().mockResolvedValue([
      { id: 1, priorStartedAt: '2026-01-01T00:00:00Z', rerequested: true },
      { id: 2, priorStartedAt: '2026-01-01T00:00:00Z', rerequested: true },
    ]),
    waitForCheckRunsCompletion: vi.fn().mockResolvedValue(true),
    getPRState: vi.fn().mockResolvedValue({ state: 'open', headSha: HEAD_SHA }),
    categorizeMergeability: vi.fn().mockResolvedValue({
      category: 'ci_failed',
      mergeState: 'ci_failed',
      rawMergeableState: 'unstable',
      failingChecks: [{ name: 'build', conclusion: 'failure' }],
      headSha: HEAD_SHA,
    }),
  } as unknown as GitHubClient;
}

function makeMockSessions(): SessionManager {
  return {
    on: vi.fn(),
    off: vi.fn(),
    sendOrResume: vi.fn().mockResolvedValue('session-id'),
  } as unknown as SessionManager;
}

function makeMockAutoMerger(): AutoMerger {
  return {
    attempt: vi.fn(),
    clearStalePauses: vi.fn(),
  } as unknown as AutoMerger;
}

function makeWatcher(github: GitHubClient) {
  const sessions = makeMockSessions();
  const broadcast = vi.fn();
  const watcher = new PRMergeWatcher(
    github,
    sessions,
    undefined,
    broadcast,
  ) as PRMergeWatcher & { handleVerifiedFlakyDisposition: any };
  const autoMerger = makeMockAutoMerger();
  watcher.setAutoMerger(autoMerger);
  return { watcher, autoMerger, sessions, broadcast };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(typedGetSetting).mockReturnValue(2);
  vi.mocked(getProjectByGithubRepo).mockReturnValue({
    id: 'project-1',
    projectDir: '/repo',
    contextUrl: 'https://notion.so/project',
    githubRepo: REPO,
  } as any);
  vi.mocked(getSession).mockReturnValue({
    worktree_path: '/tmp/worktree',
  } as any);
});

describe('PRMergeWatcher — flake_recovery_attempts base-attributable exemption', () => {
  it('does not charge flake_recovery_attempts when a same-SHA re-run still fails for a confirmed base-attributable reason', async () => {
    vi.mocked(isBaseTotalFail).mockResolvedValue(true);
    const github = makeMockGitHub();
    const { watcher } = makeWatcher(github);
    const pr = makePRRow({ flake_recovery_attempts: 1 });
    vi.mocked(getPRByNumber).mockReturnValue(pr);

    await watcher.handleVerifiedFlakyDisposition(makePayload());

    expect(incrementFlakeRecoveryAttempts).not.toHaveBeenCalled();
    expect(setFlakeRecoveryBaseExhausted).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      true,
    );
  });

  it('charges flake_recovery_attempts normally when a re-run failure is not base-attributable live, but still arms the flag unconditionally on any failed re-run', async () => {
    vi.mocked(isBaseTotalFail).mockResolvedValue(false);
    const github = makeMockGitHub();
    const { watcher } = makeWatcher(github);
    const pr = makePRRow({ flake_recovery_attempts: 1 });
    vi.mocked(getPRByNumber).mockReturnValue(pr);

    await watcher.handleVerifiedFlakyDisposition(makePayload());

    expect(incrementFlakeRecoveryAttempts).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
    );
    // Arming is decoupled from the live "charge this attempt or not" check —
    // the actual base-attributability verdict for a later budget-restore is
    // deferred to hasBaseTotalFailSince's recovery-time history comparison.
    expect(setFlakeRecoveryBaseExhausted).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      true,
    );
  });

  it('restores the budget via resetFlakeRecoveryAttempts once base recovers for a PR whose exhaustion was base-attributable, then proceeds with the re-run normally', async () => {
    vi.mocked(isProjectBaseHealthy).mockResolvedValue(true);
    vi.mocked(hasBaseTotalFailSince).mockResolvedValue(true);
    const github = makeMockGitHub();
    const { watcher } = makeWatcher(github);
    // Mutable PR row shared across the initial lookup and the post-reset
    // re-fetch — mirrors the retry-cap test's mutation pattern, simulating
    // resetFlakeRecoveryAttempts's real DB write.
    const pr = makePRRow({
      flake_recovery_attempts: 2, // at cap (typedGetSetting mocked to 2)
      flake_recovery_base_exhausted: 1,
    });
    vi.mocked(getPRByNumber).mockImplementation(() => pr);
    vi.mocked(resetFlakeRecoveryAttempts).mockImplementation(() => {
      pr.flake_recovery_attempts = 0;
      pr.flake_recovery_base_exhausted = 0;
    });

    await watcher.handleVerifiedFlakyDisposition(makePayload());

    expect(resetFlakeRecoveryAttempts).toHaveBeenCalledWith(PR_NUMBER, REPO);
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'flake_recovery_base_recovery_reset',
      }),
    );
    // Restored budget means this re-run proceeds instead of staying
    // exhausted — the re-run (still ci_failed per the mock) increments once
    // rather than re-exhausting immediately.
    expect(setPauseReason).not.toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'ci_failing',
      'flake-recovery-exhausted',
    );
    expect(incrementFlakeRecoveryAttempts).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
    );
  });

  it('never restores an exhausted PR whose exhaustion was not base-attributable, even once base recovers', async () => {
    vi.mocked(isProjectBaseHealthy).mockResolvedValue(true);
    const github = makeMockGitHub();
    const { watcher } = makeWatcher(github);
    const pr = makePRRow({
      flake_recovery_attempts: 2,
      flake_recovery_base_exhausted: 0,
    });
    vi.mocked(getPRByNumber).mockReturnValue(pr);

    await watcher.handleVerifiedFlakyDisposition(makePayload());

    expect(resetFlakeRecoveryAttempts).not.toHaveBeenCalled();
    expect(setPauseReason).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'ci_failing',
      'flake-recovery-exhausted',
    );
  });

  it('never restores a base-attributable-exhausted PR while base-health history shows no total_fail since exhaustion, even though the live snapshot is clean_pass', async () => {
    vi.mocked(isProjectBaseHealthy).mockResolvedValue(true);
    vi.mocked(hasBaseTotalFailSince).mockResolvedValue(false);
    const github = makeMockGitHub();
    const { watcher } = makeWatcher(github);
    const pr = makePRRow({
      flake_recovery_attempts: 2,
      flake_recovery_base_exhausted: 1,
    });
    vi.mocked(getPRByNumber).mockReturnValue(pr);

    await watcher.handleVerifiedFlakyDisposition(makePayload());

    expect(resetFlakeRecoveryAttempts).not.toHaveBeenCalled();
    expect(setPauseReason).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'ci_failing',
      'flake-recovery-exhausted',
    );
  });
});
