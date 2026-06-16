import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../PRFileReverter', () => ({ syncToOrigin: vi.fn() }));
vi.mock('../DiffSource', () => ({
  GitHubDiffSource: vi.fn(),
  LocalDiffSource: vi.fn(),
}));
vi.mock('../reviewUtils', () => ({
  formatReviewFeedback: vi
    .fn()
    .mockImplementation(
      (r: any, i: number) => `feedback:${r.verdict}:iter${i}`,
    ),
  formatCIFailureFeedback: vi.fn(),
}));
vi.mock('../../session/orchestrator-config', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    mcp_servers: undefined,
    allowed_tools: [],
    verify: [],
    autofix: [],
    analyze: [],
    test: [],
    ci_check_name: [],
    bash_rules: [],
    bootstrap_script: '',
    test_timeout_sec: 300,
    test_max_rss_mb: 0,
    test_fail_fast: true,
    analyze_timeout_sec: 300,
    analyze_max_rss_mb: 0,
    analyze_fail_fast: true,
  }),
}));
vi.mock('../../session/autofix-runner', () => ({
  loadAutofixCommands: vi.fn().mockReturnValue([]),
  runAutofix: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../session/filePollutionCheck', () => ({
  runFilePollutionCheck: vi.fn().mockResolvedValue({ revertCommitSha: null }),
}));
vi.mock('../../session/test-runner', () => ({
  runTestCommands: vi.fn().mockResolvedValue({ passed: true, output: '' }),
}));
vi.mock('../../orchestration/verifyRunner', () => ({
  runVerifyAsGate: vi.fn().mockResolvedValue({ passed: true }),
}));
vi.mock('../../audit/AuditLog', () => ({ recordEvent: vi.fn() }));
vi.mock('../../config', () => ({
  getProjectByGithubRepo: vi.fn(),
  getProjectById: vi.fn(),
  normalizePath: vi.fn().mockImplementation((p: string) => p),
  runtimeSettings: { session_mode: 'cli', auto_review_concurrency: 1 },
}));
vi.mock('../../db/queries', () => ({
  getPRByNumber: vi.fn(),
  getPRBySessionId: vi.fn(),
  getSession: vi.fn(),
  getLocalBranchBySession: vi.fn().mockReturnValue(null),
  setPRReviewResult: vi.fn(),
  getSetting: vi.fn().mockReturnValue(null),
  setPendingPush: vi.fn(),
  setPauseReason: vi.fn(),
  addAutofixSha: vi.fn(),
  consumeAutofixSha: vi.fn().mockReturnValue(null),
  insertPendingReviewSync: vi.fn(),
  deletePendingReviewSync: vi.fn(),
  getAllPendingReviewSyncs: vi.fn().mockReturnValue([]),
  getEventsBySession: vi.fn().mockReturnValue([]),
  setLocalBranchPauseReason: vi.fn(),
  setPreReviewStage: vi.fn(),
  setLastReviewedSha: vi.fn(),
  hasTestResultForSha: vi.fn().mockReturnValue(false),
  upsertTestResult: vi.fn(),
  hasAnalyzeResultForSha: vi.fn().mockReturnValue(false),
  upsertAnalyzeResult: vi.fn(),
  getAnalyzeResult: vi.fn().mockReturnValue(null),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import type { SessionManager } from '../../session/SessionManager';
import { ReviewOrchestrator } from '../ReviewOrchestrator';
import {
  getPRByNumber,
  getPRBySessionId,
  getSession,
  getAllPendingReviewSyncs,
} from '../../db/queries';
import { getProjectByGithubRepo } from '../../config';
import { formatReviewFeedback } from '../reviewUtils';
import type { PRReviewService, PRReviewResult } from '../PRReviewService';
import type { ReviewJob } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const CODER_SESSION_ID = 'coder-session-original-abc';
const PR_NUMBER = 42;
const REPO = 'org/repo';

function makeSessionManager(): SessionManager {
  const sm = new EventEmitter() as unknown as SessionManager;
  (sm as any).sendOrResume = vi.fn().mockResolvedValue(CODER_SESSION_ID);
  return sm;
}

function makeReviewService(
  verdict: PRReviewResult['verdict'] = 'needs_changes',
): PRReviewService {
  return {
    reviewPR: vi.fn().mockResolvedValue({
      verdict,
      summary: 'Please address comments',
      dimensions: [],
    }),
  } as unknown as PRReviewService;
}

function makePRRow(sessionId = CODER_SESSION_ID) {
  return {
    pr_number: PR_NUMBER,
    repo: REPO,
    session_id: sessionId,
    review_session_id: 'review-session-id',
    review_iteration: 0,
    state: 'open',
    draft: 0,
    task_id: 'task-1',
  } as any;
}

function makeProject() {
  return {
    id: 'project-1',
    projectDir: '/project',
    baseBranch: 'dev',
    contextUrl: 'https://notion.so/project',
  } as any;
}

function makeReviewJob(): ReviewJob {
  return {
    prNumber: PR_NUMBER,
    repo: REPO,
    sessionId: 'review-session-id',
    taskId: 'task-1',
    contextUrl: 'https://notion.so/project',
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ReviewOrchestrator — needs_changes verdict routing', () => {
  let sm: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAllPendingReviewSyncs).mockReturnValue([]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue(makeProject());
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());

    sm = makeSessionManager();
  });

  it('calls sendOrResume with the original coder session ID when verdict is needs_changes', async () => {
    const reviewService = makeReviewService('needs_changes');
    new ReviewOrchestrator(reviewService, sm, true);

    // Trigger the review via pr_opened event (the normal code flow).
    sm.emit('pr_opened', makeReviewJob());

    // Wait for async review processing to complete.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // sendOrResume must have been called with the ORIGINAL coder session ID.
    expect((sm as any).sendOrResume).toHaveBeenCalledWith(
      CODER_SESSION_ID,
      expect.any(String),
    );
  });

  it('passes the formatted feedback to sendOrResume', async () => {
    const reviewService = makeReviewService('needs_changes');
    new ReviewOrchestrator(reviewService, sm, true);

    sm.emit('pr_opened', makeReviewJob());
    await new Promise((resolve) => setTimeout(resolve, 20));

    const sendOrResumeCall = vi.mocked((sm as any).sendOrResume).mock.calls[0];
    const [calledSessionId, calledText] = sendOrResumeCall;
    expect(calledSessionId).toBe(CODER_SESSION_ID);
    // formatReviewFeedback was called and its return value was passed.
    expect(vi.mocked(formatReviewFeedback)).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'needs_changes' }),
      0,
    );
    expect(calledText).toBe('feedback:needs_changes:iter0');
  });

  it('does NOT call sendOrResume when verdict is approved', async () => {
    const reviewService = makeReviewService('approved');
    new ReviewOrchestrator(reviewService, sm, true);

    sm.emit('pr_opened', makeReviewJob());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((sm as any).sendOrResume).not.toHaveBeenCalled();
  });

  it('synthetic: dead coder session gets feedback recorded under original session ID (PR #158 reproducer)', async () => {
    // Build fixture: coder session is dead (not in live map), PR linked to it.
    // Route a needs_changes verdict through the orchestrator.
    // Assert sendOrResume is called with the original session ID — the
    // structural fix ensures the actual SessionManager.send() call will then
    // record the event under that same ID (covered by SessionManager.test.ts).
    const reviewService = makeReviewService('needs_changes');
    new ReviewOrchestrator(reviewService, sm, true);

    sm.emit('pr_opened', makeReviewJob());
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The original coder session ID must be used — not a new UUID.
    const [routedSessionId] = vi.mocked((sm as any).sendOrResume).mock.calls[0];
    expect(routedSessionId).toBe(CODER_SESSION_ID);
    // Ensure it's not a UUID generated from scratch (which would be 36 chars, all hex+dashes).
    expect(routedSessionId).toBe(CODER_SESSION_ID);
  });
});

describe('ReviewOrchestrator — pr_opened subscription', () => {
  it('subscribes to sessionManager pr_opened event via constructor', () => {
    vi.clearAllMocks();
    vi.mocked(getAllPendingReviewSyncs).mockReturnValue([]);

    const sm = makeSessionManager();
    const spyOnPrOpened = vi.spyOn(sm, 'on');

    new ReviewOrchestrator(makeReviewService(), sm, true);

    expect(spyOnPrOpened).toHaveBeenCalledWith(
      'pr_opened',
      expect.any(Function),
    );
  });
});

// ── session_ended re-review trigger ──────────────────────────────────────────

function makeStandardSession(sessionId = CODER_SESSION_ID) {
  return {
    session_id: sessionId,
    session_type: 'standard',
    task_url: 'https://notion.so/task-1',
    worktree_path: null,
    task_id: 'task-1',
    project_id: 'project-1',
    status: 'idle',
  } as any;
}

function makePRRowWithVerdict(
  verdict: string,
  reviewIteration = 0,
  sessionId = CODER_SESSION_ID,
) {
  return {
    ...makePRRow(sessionId),
    review_iteration: reviewIteration,
    review_result: JSON.stringify({ verdict, summary: 'test', dimensions: [] }),
  } as any;
}

describe('ReviewOrchestrator — session_ended re-review trigger', () => {
  let sm: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAllPendingReviewSyncs).mockReturnValue([]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue(makeProject());
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    vi.mocked(getPRBySessionId).mockReturnValue(null);
    vi.mocked(getSession).mockReturnValue(undefined);
    sm = makeSessionManager();
  });

  it('subscribes to session_ended via the message event handler', () => {
    const spyOn = vi.spyOn(sm, 'on');
    new ReviewOrchestrator(makeReviewService(), sm, true);
    expect(spyOn).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('fires re-review when standard session ends with needs_changes verdict below cap', async () => {
    vi.mocked(getSession).mockReturnValue(makeStandardSession());
    vi.mocked(getPRBySessionId).mockReturnValue(
      makePRRowWithVerdict('needs_changes', 0),
    );
    vi.mocked(getPRByNumber).mockReturnValue(
      makePRRowWithVerdict('needs_changes', 0),
    );

    const reviewService = makeReviewService('needs_changes');
    new ReviewOrchestrator(reviewService, sm, true);

    sm.emit('message', {
      type: 'session_ended',
      sessionId: CODER_SESSION_ID,
      status: 'idle',
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(vi.mocked(reviewService.reviewPR)).toHaveBeenCalled();
  });

  it('doc-only fix: re-review fires when session ends without head_sha advance after needs_changes (PR #668 regression)', async () => {
    const prRow = {
      ...makePRRowWithVerdict('needs_changes', 0),
      head_sha: 'abc123',
      last_reviewed_sha: 'abc123',
    };
    vi.mocked(getSession).mockReturnValue(makeStandardSession());
    vi.mocked(getPRBySessionId).mockReturnValue(prRow);
    vi.mocked(getPRByNumber).mockReturnValue(prRow);

    const reviewService = makeReviewService('needs_changes');
    new ReviewOrchestrator(reviewService, sm, true);

    sm.emit('message', {
      type: 'session_ended',
      sessionId: CODER_SESSION_ID,
      status: 'idle',
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(vi.mocked(reviewService.reviewPR)).toHaveBeenCalled();
  });

  it('does NOT fire re-review when review_iteration >= cap', async () => {
    vi.mocked(getSession).mockReturnValue(makeStandardSession());
    vi.mocked(getPRBySessionId).mockReturnValue(
      makePRRowWithVerdict('needs_changes', 3),
    );

    const reviewService = makeReviewService('needs_changes');
    new ReviewOrchestrator(reviewService, sm, true);

    sm.emit('message', {
      type: 'session_ended',
      sessionId: CODER_SESSION_ID,
      status: 'idle',
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(vi.mocked(reviewService.reviewPR)).not.toHaveBeenCalled();
  });

  it('does NOT fire re-review when there is no PR paired with the session', async () => {
    vi.mocked(getSession).mockReturnValue(makeStandardSession());
    vi.mocked(getPRBySessionId).mockReturnValue(null);

    const reviewService = makeReviewService('needs_changes');
    new ReviewOrchestrator(reviewService, sm, true);

    sm.emit('message', {
      type: 'session_ended',
      sessionId: CODER_SESSION_ID,
      status: 'idle',
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(vi.mocked(reviewService.reviewPR)).not.toHaveBeenCalled();
  });

  it('does NOT fire re-review when PR has no review result yet', async () => {
    vi.mocked(getSession).mockReturnValue(makeStandardSession());
    vi.mocked(getPRBySessionId).mockReturnValue({
      ...makePRRow(),
      review_result: null,
    } as any);

    const reviewService = makeReviewService('needs_changes');
    new ReviewOrchestrator(reviewService, sm, true);

    sm.emit('message', {
      type: 'session_ended',
      sessionId: CODER_SESSION_ID,
      status: 'idle',
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(vi.mocked(reviewService.reviewPR)).not.toHaveBeenCalled();
  });

  it('does NOT fire re-review when verdict is approved', async () => {
    vi.mocked(getSession).mockReturnValue(makeStandardSession());
    vi.mocked(getPRBySessionId).mockReturnValue(
      makePRRowWithVerdict('approved', 0),
    );

    const reviewService = makeReviewService('approved');
    new ReviewOrchestrator(reviewService, sm, true);

    sm.emit('message', {
      type: 'session_ended',
      sessionId: CODER_SESSION_ID,
      status: 'idle',
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(vi.mocked(reviewService.reviewPR)).not.toHaveBeenCalled();
  });

  it('does NOT fire re-review when a review session ends (session_type !== standard)', async () => {
    vi.mocked(getSession).mockReturnValue({
      ...makeStandardSession(),
      session_type: 'review',
    });
    vi.mocked(getPRBySessionId).mockReturnValue(
      makePRRowWithVerdict('needs_changes', 0),
    );

    const reviewService = makeReviewService('needs_changes');
    new ReviewOrchestrator(reviewService, sm, true);

    sm.emit('message', {
      type: 'session_ended',
      sessionId: CODER_SESSION_ID,
      status: 'idle',
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(vi.mocked(reviewService.reviewPR)).not.toHaveBeenCalled();
  });

  it('does NOT fire re-review when session is not found in DB', async () => {
    vi.mocked(getSession).mockReturnValue(undefined);
    vi.mocked(getPRBySessionId).mockReturnValue(
      makePRRowWithVerdict('needs_changes', 0),
    );

    const reviewService = makeReviewService('needs_changes');
    new ReviewOrchestrator(reviewService, sm, true);

    sm.emit('message', {
      type: 'session_ended',
      sessionId: CODER_SESSION_ID,
      status: 'idle',
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(vi.mocked(reviewService.reviewPR)).not.toHaveBeenCalled();
  });

  it('idempotency: does NOT enqueue a second review when one is already queued for the same PR', async () => {
    vi.mocked(getSession).mockReturnValue(makeStandardSession());
    const prRow = makePRRowWithVerdict('needs_changes', 0);
    vi.mocked(getPRBySessionId).mockReturnValue(prRow);
    vi.mocked(getPRByNumber).mockReturnValue(prRow);

    const reviewService = makeReviewService('needs_changes');
    const orchestrator = new ReviewOrchestrator(reviewService, sm, true);

    // Simulate push_detected having enqueued a review already via ReviewOrchestrator
    const job: ReviewJob = {
      prNumber: PR_NUMBER,
      repo: REPO,
      taskId: 'task-1',
      taskUrl: 'https://notion.so/task-1',
      contextUrl: 'https://notion.so/project',
    };
    orchestrator.enqueueReview(job);

    // session_ended fires for the same PR — should NOT enqueue a second review
    sm.emit('message', {
      type: 'session_ended',
      sessionId: CODER_SESSION_ID,
      status: 'idle',
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    // reviewPR should only be called once (from the first enqueue)
    expect(vi.mocked(reviewService.reviewPR)).toHaveBeenCalledTimes(1);
  });
});
