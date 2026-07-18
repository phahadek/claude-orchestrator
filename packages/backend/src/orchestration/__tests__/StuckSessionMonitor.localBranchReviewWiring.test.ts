import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks (must come before imports of the modules under test) ──────────────

vi.mock('../../config.js', () => ({
  runtimeSettings: {
    session_hard_stop_window_seconds: 60,
    auto_review_concurrency: 1,
  },
  getProjectByGithubRepo: vi.fn(),
  getAllProjects: vi.fn(() => []),
  getProjectById: vi.fn((id: string) =>
    id === 'proj-1'
      ? {
          id: 'proj-1',
          name: 'Local Project',
          projectDir: '/repos/local',
          contextUrl: 'https://notion.so/ctx-local',
          boardId: 'board-local',
          gitMode: 'local-only',
        }
      : undefined,
  ),
}));

vi.mock('../../db/queries.js', () => ({
  // StuckSessionMonitor
  getPRBySessionId: vi.fn().mockReturnValue(null),
  setPauseReason: vi.fn(),
  insertPauseInterval: vi.fn(),
  closePauseInterval: vi.fn(),
  upsertStuckSessionTimer: vi.fn(),
  deleteStuckSessionTimer: vi.fn(),
  getAllStuckSessionTimers: vi.fn().mockReturnValue([]),
  getStuckResultSessionRows: vi.fn().mockReturnValue([]),
  markSessionDone: vi.fn(),
  markSessionIdle: vi.fn(),
  getSession: vi.fn(),
  getProjectRowById: vi.fn(),
  // localBranchSubmission
  getLocalBranchBySession: vi.fn().mockReturnValue(undefined),
  insertLocalBranch: vi.fn(),
  // ReviewOrchestrator
  setPRReviewResult: vi.fn(),
  getPRByNumber: vi.fn(),
  updatePRDraftStatus: vi.fn(),
  setLocalBranchPauseReason: vi.fn(),
  addAutofixSha: vi.fn(),
  consumeAutofixSha: vi.fn().mockReturnValue(false),
  deleteAllAutofixShasForPR: vi.fn(),
  getAllPendingReviewSyncs: vi.fn().mockReturnValue([]),
  insertPendingReviewSync: vi.fn(),
  deletePendingReviewSync: vi.fn(),
  hasTestResultForSha: vi.fn().mockReturnValue(false),
  upsertTestResult: vi.fn(),
  hasAnalyzeResultForSha: vi.fn().mockReturnValue(false),
  upsertAnalyzeResult: vi.fn(),
  getAnalyzeResult: vi.fn(),
  setPreReviewStage: vi.fn(),
  setLastReviewedSha: vi.fn(),
  enqueueFeedbackItem: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi.fn(),
}));

vi.mock('../localBranchHelpers.js', () => ({
  getCurrentBranch: vi.fn(),
  hasNonEmptyDiff: vi.fn(),
}));

vi.mock('../../routes/tasks.js', () => ({
  emitTaskUpdated: vi.fn(),
}));

vi.mock('../../session/autofix-runner.js', () => ({
  loadAutofixCommands: vi.fn().mockReturnValue([]),
  runAutofix: vi.fn().mockResolvedValue({ success: true, summary: 'no diff' }),
}));

vi.mock('../../session/filePollutionCheck.js', () => ({
  runFilePollutionCheck: vi
    .fn()
    .mockResolvedValue({ headSha: null, revertCommitSha: null }),
}));

vi.mock('../../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../verifyRunner.js', () => ({
  runVerifyAsGate: vi.fn().mockResolvedValue({ passed: true }),
}));

vi.mock('../../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    verify: [],
    autofix: [],
    ci_check_name: [],
    allowed_tools: [],
    bash_rules: [],
    bootstrap_script: '',
    test: [],
    test_timeout_sec: 60,
    test_max_rss_mb: 0,
    test_fail_fast: true,
  }),
}));

import {
  getStuckResultSessionRows,
  getProjectRowById,
  getSession,
  getLocalBranchBySession,
} from '../../db/queries.js';
import { getTaskBackend } from '../../tasks/TaskBackend.js';
import { getCurrentBranch, hasNonEmptyDiff } from '../localBranchHelpers.js';
import { StuckSessionMonitor } from '../StuckSessionMonitor.js';
import { ReviewOrchestrator } from '../../github/ReviewOrchestrator';
import type { PRReviewService } from '../../github/PRReviewService';

function makeMockSessionManager() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    isAlive: vi.fn().mockReturnValue(true),
    send: vi.fn(),
  });
}

function makeMockReviewService(): PRReviewService {
  return {
    reviewPR: vi.fn().mockResolvedValue({
      prNumber: 10,
      repo: 'local/feature/my-local-branch',
      verdict: 'approved',
      dimensions: [],
      summary: 'LGTM',
      reviewedAt: new Date().toISOString(),
    }),
  } as unknown as PRReviewService;
}

const stuckRow = {
  session_id: 'sess-local-1',
  task_id: 'task-1',
  task_url: 'https://notion.so/task',
  project_context_url: 'https://notion.so/ctx',
  project_id: 'proj-1',
  pr_url: null,
  worktree_path: '/worktree',
  session_type: 'standard',
  last_ts: Date.now(),
};

const localBranchRow = {
  id: 10,
  project_id: 'proj-1',
  session_id: 'sess-local-1',
  branch_name: 'feature/my-task',
  base_branch: 'dev',
  status: 'open',
  review_result: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const sessionRow = {
  session_id: 'sess-local-1',
  task_id: 'task-1',
  worktree_path: '/worktree',
};

describe('StuckSessionMonitor -> ReviewOrchestrator local-branch review wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTaskBackend).mockReturnValue({
      updateStatus: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  it('routes local_branch_submitted onto the sessionManager message bus so ReviewOrchestrator enqueues a review job (not just the WS-only broadcast)', async () => {
    vi.mocked(getStuckResultSessionRows).mockReturnValue([stuckRow] as never);
    vi.mocked(getProjectRowById).mockReturnValue({
      git_mode: 'local-only',
      base_branch: 'dev',
    } as never);
    vi.mocked(getCurrentBranch).mockResolvedValue('feature/my-task');
    vi.mocked(hasNonEmptyDiff).mockResolvedValue(true);
    // First call (submitLocalBranch's idempotency check) -> no row yet;
    // subsequent calls (ReviewOrchestrator.onMessage lookup) -> row exists.
    vi.mocked(getLocalBranchBySession)
      .mockReturnValueOnce(undefined as never)
      .mockReturnValue(localBranchRow as never);
    vi.mocked(getSession).mockReturnValue(sessionRow as never);

    const sessionManager = makeMockSessionManager();
    const wsBroadcast = vi.fn(); // stands in for server.ts's WS-only broadcast
    const monitor = new StuckSessionMonitor(
      sessionManager as never,
      wsBroadcast,
    );

    const reviewService = makeMockReviewService();
    new ReviewOrchestrator(reviewService, sessionManager as never, true);

    await monitor.scanForStuckSessions();
    // Let the fire-and-forget updateStatus().then(...) chain and
    // ReviewOrchestrator's async drain() settle.
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(reviewService.reviewPR)).toHaveBeenCalledOnce();
    const [workItem] = vi.mocked(reviewService.reviewPR).mock.calls[0];
    expect(workItem).toMatchObject({
      type: 'local_branch',
      localBranchId: 10,
      branchName: 'feature/my-task',
      baseBranch: 'dev',
    });
  });
});
