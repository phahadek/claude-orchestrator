/**
 * PRMergeWatcher.reattributePausedPR — re-attributes an already-paused PR
 * against fresh cross-tree evidence with no rerun and no
 * flake_recovery_attempts increment.
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
  getLatestTestRequestRunForSession: vi.fn(),
  isRunFailureBreadthAttributable: vi.fn(),
  resolveBreadthOwnTree: vi.fn(
    (_projectId: string, s: { sessionId?: string | null }) => ({
      sessionIds: s.sessionId ? [s.sessionId] : [],
      worktreePaths: [],
    }),
  ),
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
  updateTestRequestRunState: vi.fn(),
}));

vi.mock(
  '../../orchestration/baseAttributableFilter',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    filterBaseAttributableFailuresForF2Gate: vi.fn(),
  }),
);

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

import { PRMergeWatcher } from '../PRMergeWatcher';
import {
  getPRByNumber,
  setPauseReason,
  getSession,
  incrementFlakeRecoveryAttempts,
  getLatestTestRequestRunForSession,
  updateTestRequestRunState,
} from '../../db/queries';
import { filterBaseAttributableFailuresForF2Gate } from '../../orchestration/baseAttributableFilter';
import { getProjectByGithubRepo } from '../../config';
import { typedGetSetting } from '../../config/settings';
import {
  pauseReasonFromCanonical,
  serializePauseReason,
} from '../../db/pauseReason';
import type { GitHubClient } from '../GitHubClient';
import type { SessionManager } from '../../session/SessionManager';
import type { AutoMerger } from '../AutoMerger';
import type { PullRequestRow } from '../../db/types';

const PR_NUMBER = 1715;
const REPO = 'owner/repo';
const HEAD_SHA = 'sha-flaky-1';
const LATEST_RUN = { id: 'run-latest' };

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

function makeMockGitHub(): GitHubClient {
  return {
    getPRState: vi.fn().mockResolvedValue({ state: 'open', headSha: HEAD_SHA }),
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
  const broadcast = vi.fn();
  const watcher = new PRMergeWatcher(
    github,
    makeMockSessions(),
    undefined,
    broadcast,
  );
  const autoMerger = makeMockAutoMerger();
  watcher.setAutoMerger(autoMerger);
  return { watcher, autoMerger, broadcast };
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
  vi.mocked(getLatestTestRequestRunForSession).mockReturnValue(
    LATEST_RUN as any,
  );
});

describe('PRMergeWatcher — reattributePausedPR', () => {
  function setup(outcome: 'filtered_pass' | 'filtered_partial') {
    const github = makeMockGitHub();
    (github as any).fetchDiff = vi
      .fn()
      .mockResolvedValue({ filesChanged: ['src/a.ts'] });
    const { watcher, autoMerger, broadcast } = makeWatcher(github);
    const pr = makePRRow({ flake_recovery_attempts: 1 });
    vi.mocked(getPRByNumber).mockReturnValue(pr);
    vi.mocked(getLatestTestRequestRunForSession).mockReturnValue({
      id: 'run-latest',
      state: 'failed',
    } as any);
    vi.mocked(filterBaseAttributableFailuresForF2Gate).mockResolvedValue({
      result: { outcome, passed: outcome === 'filtered_pass' },
      guardBlocked: [],
    } as any);
    const checkNow = vi
      .spyOn(watcher as any, 'checkMergeabilityNow')
      .mockResolvedValue(undefined);
    return { watcher, autoMerger, broadcast, checkNow };
  }

  it('re-drives a paused PR whose failures are fully excused, without a rerun or counter increment', async () => {
    const { watcher, autoMerger, broadcast, checkNow } = setup('filtered_pass');

    const res = await watcher.reattributePausedPR(PR_NUMBER, REPO);

    expect(res).toBe('redriven');
    expect(updateTestRequestRunState).toHaveBeenCalledWith(
      'run-latest',
      'passed',
    );
    expect(setPauseReason).toHaveBeenCalledWith(PR_NUMBER, REPO, null);
    expect(broadcast).toHaveBeenCalledWith({
      type: 'pr_pause_cleared',
      prNumber: PR_NUMBER,
      repo: REPO,
    });
    expect(checkNow).toHaveBeenCalledWith(PR_NUMBER, REPO);
    expect(autoMerger.attempt).toHaveBeenCalledWith(PR_NUMBER, REPO);
    expect(incrementFlakeRecoveryAttempts).not.toHaveBeenCalled();
  });

  it('leaves a PR paused when evidence only partially excuses its failures', async () => {
    const { watcher, autoMerger, checkNow } = setup('filtered_partial');

    const res = await watcher.reattributePausedPR(PR_NUMBER, REPO);

    expect(res).toBe('not_excused');
    expect(updateTestRequestRunState).not.toHaveBeenCalled();
    expect(setPauseReason).not.toHaveBeenCalled();
    expect(checkNow).not.toHaveBeenCalled();
    expect(autoMerger.attempt).not.toHaveBeenCalled();
    expect(incrementFlakeRecoveryAttempts).not.toHaveBeenCalled();
  });
});
