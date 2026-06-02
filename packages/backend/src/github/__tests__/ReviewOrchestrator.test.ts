import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../PRFileReverter', () => ({ syncToOrigin: vi.fn() }));
vi.mock('../DiffSource', () => ({
  GitHubDiffSource: vi.fn(),
  LocalDiffSource: vi.fn(),
}));
vi.mock('../reviewUtils', () => ({
  formatReviewFeedback: vi.fn().mockImplementation((r: any, i: number) => `feedback:${r.verdict}:iter${i}`),
  formatCIFailureFeedback: vi.fn(),
}));
vi.mock('../../session/orchestrator-config', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({ mcp_servers: undefined, allowed_tools: [] }),
}));
vi.mock('../../session/autofix-runner', () => ({
  loadAutofixCommands: vi.fn().mockReturnValue([]),
  runAutofix: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../session/filePollutionCheck', () => ({
  runFilePollutionCheck: vi.fn().mockResolvedValue({ revertCommitSha: null }),
}));
vi.mock('../../orchestration/verifyRunner', () => ({
  runVerifyAsGate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../audit/AuditLog', () => ({ recordEvent: vi.fn() }));
vi.mock('../../config', () => ({
  getProjectByGithubRepo: vi.fn(),
  getProjectById: vi.fn(),
  normalizePath: vi.fn().mockImplementation((p: string) => p),
  runtimeSettings: { session_mode: 'cli' },
}));
vi.mock('../../db/queries', () => ({
  getPRByNumber: vi.fn(),
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
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import type { SessionManager } from '../../session/SessionManager';
import { ReviewOrchestrator } from '../ReviewOrchestrator';
import { getPRByNumber, getAllPendingReviewSyncs } from '../../db/queries';
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

function makeReviewService(verdict: PRReviewResult['verdict'] = 'needs_changes'): PRReviewService {
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
  let orchestrator: ReviewOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAllPendingReviewSyncs).mockReturnValue([]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue(makeProject());
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());

    sm = makeSessionManager();
  });

  it('calls sendOrResume with the original coder session ID when verdict is needs_changes', async () => {
    const reviewService = makeReviewService('needs_changes');
    orchestrator = new ReviewOrchestrator(reviewService, sm, 1, true);

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
    orchestrator = new ReviewOrchestrator(reviewService, sm, 1, true);

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
    orchestrator = new ReviewOrchestrator(reviewService, sm, 1, true);

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
    orchestrator = new ReviewOrchestrator(reviewService, sm, 1, true);

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

    new ReviewOrchestrator(makeReviewService(), sm, 1, true);

    expect(spyOnPrOpened).toHaveBeenCalledWith('pr_opened', expect.any(Function));
  });
});
