/**
 * Integration test: POST /api/prs/ingest → review chain fires → verdict produced
 *
 * Wires a real ReviewOrchestrator to a real EventEmitter-based SessionManager.
 * When the ingest route emits pr_opened, the orchestrator queues the job,
 * runs reviewPR (mocked), persists the verdict, and emits pr_review_complete.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import express from 'express';
import supertest from 'supertest';

// ── Module mocks (must appear before imports) ─────────────────────────────────

vi.mock('../routes/tasks.js', () => ({ emitTaskUpdated: vi.fn() }));
vi.mock('../audit/AuditLog.js', () => ({ recordEvent: vi.fn() }));
vi.mock('../github/PRFileReverter.js', () => ({ syncToOrigin: vi.fn() }));
vi.mock('../github/DiffSource.js', () => ({
  GitHubDiffSource: vi.fn().mockImplementation(() => ({
    fetchDiff: vi.fn().mockResolvedValue({ diff: '', filesChanged: [] }),
  })),
  LocalDiffSource: vi.fn(),
}));
vi.mock('../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    verify: [],
    autofix: [],
    ci_check_name: [],
    allowed_tools: [],
    bash_rules: [],
    bootstrap_script: '',
    test: [],
    test_timeout_sec: 300,
    test_max_rss_mb: 0,
    test_fail_fast: true,
  }),
}));
vi.mock('../session/autofix-runner.js', () => ({
  loadAutofixCommands: vi.fn().mockReturnValue([]),
  runAutofix: vi.fn().mockResolvedValue({ success: true, summary: 'clean' }),
}));
vi.mock('../session/filePollutionCheck.js', () => ({
  runFilePollutionCheck: vi
    .fn()
    .mockResolvedValue({ headSha: null, revertCommitSha: null }),
}));
vi.mock('../orchestration/verifyRunner.js', () => ({
  runVerifyAsGate: vi.fn().mockResolvedValue({ passed: true }),
}));
vi.mock('../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi.fn().mockReturnValue(undefined),
}));

const REPO = 'owner/repo';
const PR_NUMBER = 99;
const NOTION_TASK_ID = '37822f91-52f3-810d-8a94-c8de372f2b4e';

const projectFixture = {
  id: 'proj-1',
  name: 'Test Project',
  projectDir: '/test',
  contextUrl: 'https://notion.so/ctx',
  boardId: 'board-1',
  githubRepo: REPO,
  gitMode: 'github',
  autoMergeEnabled: false,
};

vi.mock('../config.js', () => ({
  getProjectById: vi.fn(),
  getProjectByGithubRepo: vi.fn((repo: string) =>
    repo === REPO ? projectFixture : undefined,
  ),
  getAllProjects: vi.fn(() => [projectFixture]),
  runtimeSettings: { auto_review_concurrency: 1 },
  normalizePath: (p: string) => p,
}));

vi.mock('../db/queries.js', () => ({
  // ingest route
  getPRs: vi.fn().mockReturnValue([]),
  getPRByNumber: vi.fn().mockReturnValue(null),
  updatePRState: vi.fn(),
  updateMergeState: vi.fn(),
  getTaskTitleFromCache: vi.fn().mockReturnValue(null),
  upsertPullRequest: vi.fn().mockReturnValue(null),
  deletePR: vi.fn(),
  resetReviewIteration: vi.fn(),
  setPRReviewResult: vi.fn(),
  updatePRDraftStatus: vi.fn(),
  getSessionsByProject: vi.fn().mockReturnValue([]),
  lookupSessionByBranch: vi.fn().mockReturnValue(null),
  // ReviewOrchestrator
  getSetting: vi.fn().mockReturnValue(null),
  setPendingPush: vi.fn(),
  setPauseReason: vi.fn(),
  getLocalBranchBySession: vi.fn().mockReturnValue(null),
  setLocalBranchPauseReason: vi.fn(),
  getSession: vi.fn().mockReturnValue(undefined),
  addAutofixSha: vi.fn(),
  consumeAutofixSha: vi.fn().mockReturnValue(null),
  insertPendingReviewSync: vi.fn(),
  deletePendingReviewSync: vi.fn(),
  getAllPendingReviewSyncs: vi.fn().mockReturnValue([]),
  hasTestResultForSha: vi.fn().mockReturnValue(false),
  upsertTestResult: vi.fn(),
  setPreReviewStage: vi.fn(),
  setReviewSessionId: vi.fn(),
  incrementReviewIteration: vi.fn(),
  setLastReviewedSha: vi.fn(),
  setHeadSha: vi.fn(),
  getPRBySessionId: vi.fn().mockReturnValue(null),
  getPRByNotionTaskId: vi.fn().mockReturnValue(null),
  getEventsBySession: vi.fn().mockReturnValue([]),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { createPrsRouter } from '../routes/prs.js';
import { ReviewOrchestrator } from '../github/ReviewOrchestrator.js';
import * as queries from '../db/queries.js';
import type { GitHubClient } from '../github/GitHubClient.js';
import type {
  PRReviewService,
  PRReviewResult,
} from '../github/PRReviewService.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { PullRequest } from '../github/types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockGitHubPR: PullRequest = {
  id: PR_NUMBER,
  nodeId: 'PR_node_99',
  title: 'feat: orphaned PR',
  body: `## Notion Task\nhttps://www.notion.so/My-Task-37822f9152f3810d8a94c8de372f2b4e`,
  url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
  apiUrl: `https://api.github.com/repos/${REPO}/pulls/${PR_NUMBER}`,
  headBranch: 'feature/my-task-37822f9152f3810d8a94c8de372f2b4e',
  headSha: null,
  baseBranch: 'dev',
  state: 'open',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T01:00:00Z',
  mergeableState: 'clean',
  draft: false,
};

const prRowAfterIngest = {
  id: 1,
  pr_number: PR_NUMBER,
  pr_url: mockGitHubPR.url,
  task_id: NOTION_TASK_ID,
  session_id: null,
  repo: REPO,
  title: mockGitHubPR.title,
  body: mockGitHubPR.body,
  head_branch: mockGitHubPR.headBranch,
  base_branch: mockGitHubPR.baseBranch,
  state: 'open',
  draft: 0,
  review_result: null,
  review_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T01:00:00Z',
  synced_at: '2024-01-01T01:00:00Z',
  review_session_id: null,
  review_iteration: 0,
  head_sha: null,
  last_reviewed_sha: null,
  node_id: null,
  mergeable: null,
  merge_state: null,
  merge_state_checked_at: null,
  pending_push: 0,
  pause_reason: null,
  failing_checks: null,
};

// ── Mock SessionManager (real EventEmitter backbone) ─────────────────────────

class MockSessionManager extends EventEmitter {
  sendOrResume = vi.fn().mockResolvedValue(undefined);
  endSession = vi.fn();
  send = vi.fn();
  isAlive = vi.fn().mockReturnValue(false);
}

function makeMockGitHub(): GitHubClient {
  return {
    listOpenPRs: vi.fn().mockResolvedValue([]),
    getPRState: vi.fn().mockResolvedValue({ state: 'open', headSha: null }),
    fetchPR: vi.fn().mockResolvedValue(mockGitHubPR),
    fetchDiff: vi
      .fn()
      .mockResolvedValue({
        diff: 'diff --git a/foo.ts b/foo.ts',
        filesChanged: ['foo.ts'],
      }),
    mergePR: vi.fn(),
    markPRReady: vi.fn().mockResolvedValue(undefined),
    getMergeability: vi
      .fn()
      .mockResolvedValue({ mergeable: true, mergeableState: 'clean' }),
    getMergeabilityWithRetry: vi
      .fn()
      .mockResolvedValue({ mergeable: true, mergeableState: 'clean' }),
    getFailingChecks: vi.fn().mockResolvedValue([]),
    categorizeMergeability: vi.fn(),
  } as unknown as GitHubClient;
}

function makeApprovedResult(): PRReviewResult {
  return {
    prNumber: PR_NUMBER,
    repo: REPO,
    verdict: 'approved',
    dimensions: [],
    summary: 'Looks good',
    reviewedAt: new Date().toISOString(),
  };
}

function makeMockPRReviewService(): PRReviewService {
  return {
    reviewPR: vi.fn().mockResolvedValue(makeApprovedResult()),
  } as unknown as PRReviewService;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Start with no PR row (orphaned)
  vi.mocked(queries.getPRByNumber).mockReturnValue(null);
  vi.mocked(queries.lookupSessionByBranch).mockReturnValue(null);
  vi.mocked(queries.upsertPullRequest).mockReturnValue(null);
  vi.mocked(queries.getSetting).mockReturnValue(null);
  vi.mocked(queries.getSession).mockReturnValue(undefined);
});

// ── Integration test ──────────────────────────────────────────────────────────

describe('POST /api/prs/ingest — end-to-end review chain', () => {
  it('ingest → pr_opened → ReviewOrchestrator queues job → reviewPR called → verdict persisted', async () => {
    const sessionManager =
      new MockSessionManager() as unknown as SessionManager;
    const github = makeMockGitHub();
    const prReviewService = makeMockPRReviewService();

    // Wire up the real ReviewOrchestrator listening to the SessionManager
    new ReviewOrchestrator(prReviewService, sessionManager, true, github);

    // First call: existence check in ingest route returns null (orphan — not tracked yet).
    // Subsequent calls: ReviewOrchestrator iteration check etc. see the inserted row.
    vi.mocked(queries.getPRByNumber)
      .mockReturnValueOnce(null)
      .mockReturnValue(
        prRowAfterIngest as ReturnType<typeof queries.getPRByNumber>,
      );

    const app = express();
    app.use(express.json());
    app.use('/api', createPrsRouter(github, prReviewService, sessionManager));

    // Call the ingest route
    const res = await supertest(app)
      .post('/api/prs/ingest')
      .send({ repo: REPO, prNumber: PR_NUMBER });

    expect(res.status).toBe(201);
    expect(res.body.taskId).toBe(NOTION_TASK_ID);

    // Wait for the async review chain to complete
    await vi.waitFor(
      () => {
        expect(queries.setPRReviewResult).toHaveBeenCalledWith(
          PR_NUMBER,
          REPO,
          expect.stringContaining('approved'),
        );
      },
      { timeout: 5000 },
    );

    // Verify the review chain fired
    expect(prReviewService.reviewPR).toHaveBeenCalledOnce();
    const reviewCallArgs = vi.mocked(prReviewService.reviewPR).mock.calls[0];
    expect(reviewCallArgs[0]).toMatchObject({
      type: 'pr',
      prNumber: PR_NUMBER,
      repo: REPO,
    });
  });
});
