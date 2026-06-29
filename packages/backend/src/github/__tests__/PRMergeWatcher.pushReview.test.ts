import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

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
  setLastReviewedSha: vi.fn(),
  setPRReviewResult: vi.fn(),
  setPendingPush: vi.fn(),
  getTestResult: vi.fn().mockReturnValue(null),
  markSessionDone: vi.fn(),
  setPreReviewStage: vi.fn(),
  clearTerminalPRFlags: vi.fn(),
}));
vi.mock('../../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));
vi.mock('../reviewUtils', () => ({
  formatCIFailureFeedback: vi.fn(),
  shouldAutoReview: vi.fn().mockReturnValue(true),
  formatReviewFeedback: vi.fn().mockReturnValue('feedback'),
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
import type { GitHubClient } from '../GitHubClient';
import type { SessionManager } from '../../session/SessionManager';
import type { PRReviewService, PRReviewResult } from '../PRReviewService';
import type { ReviewOrchestrator } from '../ReviewOrchestrator';
import { getProjectByGithubRepo } from '../../config';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PR_NUMBER = 42;
const REPO = 'org/repo';
const SESSION_ID = 'coder-session-abc';
const REVIEW_SESSION_ID = 'review-session-xyz';
const HEAD_SHA = 'abc1234567890';

function makeGithubClient(): GitHubClient {
  return {
    fetchPR: vi
      .fn()
      .mockResolvedValue({ headSha: HEAD_SHA, number: PR_NUMBER }),
    categorizeMergeability: vi.fn(),
    listOpenPRStates: vi.fn(),
    markPRReady: vi.fn(),
  } as unknown as GitHubClient;
}

function makeSessionManager(): SessionManager {
  const ee = new EventEmitter() as unknown as SessionManager;
  (ee as any).sendOrResume = vi.fn().mockResolvedValue('review-session-id');
  (ee as any).on = ee.on.bind(ee);
  (ee as any).off = ee.off.bind(ee);
  return ee;
}

function makeReviewService(): PRReviewService {
  return {
    reReviewPR: vi.fn().mockResolvedValue({
      verdict: 'needs_changes',
      summary: 'Please fix',
      dimensions: [],
      prNumber: PR_NUMBER,
      repo: REPO,
      reviewedAt: new Date().toISOString(),
    } as PRReviewResult),
  } as unknown as PRReviewService;
}

function makeReviewOrchestrator(): ReviewOrchestrator {
  return {
    runAutofixPipeline: vi.fn().mockResolvedValue(undefined),
    runTestPipeline: vi.fn().mockResolvedValue(undefined),
    consumeAutofixSha: vi.fn().mockReturnValue(false),
    isReviewInFlight: vi.fn().mockReturnValue(false),
    enqueueReview: vi.fn(),
  } as unknown as ReviewOrchestrator;
}

function makePRRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    pr_number: PR_NUMBER,
    repo: REPO,
    session_id: SESSION_ID,
    review_session_id: REVIEW_SESSION_ID,
    review_iteration: 0,
    state: 'open',
    draft: 0,
    task_id: 'task-1',
    head_sha: HEAD_SHA,
    last_reviewed_sha: null,
    pause_reason: null,
    review_result: null,
    ...overrides,
  } as any;
}

function makeProject() {
  return {
    id: 'project-abc',
    projectDir: '/repo',
    contextUrl: 'https://notion.so/project-abc',
    baseBranch: 'dev',
    githubRepo: REPO,
    test: [],
  } as any;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PRMergeWatcher push re-review — project id forwarding', () => {
  let github: GitHubClient;
  let sessions: SessionManager;
  let reviewService: PRReviewService;
  let reviewOrchestrator: ReviewOrchestrator;
  let watcher: PRMergeWatcher;
  let broadcast: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    github = makeGithubClient();
    sessions = makeSessionManager();
    reviewService = makeReviewService();
    reviewOrchestrator = makeReviewOrchestrator();
    broadcast = vi.fn();

    watcher = new PRMergeWatcher(github, sessions, undefined, broadcast);
    watcher.setPRReviewService(reviewService);
    watcher.setReviewOrchestrator(reviewOrchestrator);

    vi.mocked(getProjectByGithubRepo).mockReturnValue(makeProject());
  });

  it('calls reReviewPR with resolved project.id and project.contextUrl', async () => {
    const project = makeProject();
    vi.mocked(getProjectByGithubRepo).mockReturnValue(project);

    await watcher.handlePushDetected(makePRRow());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(reviewService.reReviewPR).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      project.id,
      project.contextUrl,
    );
  });

  it('does NOT call reReviewPR when no project resolves for the repo', async () => {
    // First call (line ~770) returns project for test pipeline check,
    // second call (line ~828) returns undefined to simulate the broken state.
    vi.mocked(getProjectByGithubRepo)
      .mockReturnValueOnce(makeProject()) // test pipeline check
      .mockReturnValueOnce(undefined); // project guard before reReviewPR

    await watcher.handlePushDetected(makePRRow());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(reviewService.reReviewPR).not.toHaveBeenCalled();
  });

  it('does NOT call reReviewPR with empty string when project is missing', async () => {
    vi.mocked(getProjectByGithubRepo).mockReturnValue(undefined);

    await watcher.handlePushDetected(makePRRow());
    await new Promise((resolve) => setTimeout(resolve, 20));

    const reReviewCalls = vi.mocked(reviewService.reReviewPR).mock.calls;
    const emptyIdCalls = reReviewCalls.filter(
      ([, , projectId]) => projectId === '',
    );
    expect(emptyIdCalls).toHaveLength(0);
    expect(reviewService.reReviewPR).not.toHaveBeenCalled();
  });
});
