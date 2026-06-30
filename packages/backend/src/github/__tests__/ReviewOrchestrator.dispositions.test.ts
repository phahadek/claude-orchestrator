import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../PRFileReverter', () => ({ syncToOrigin: vi.fn() }));
vi.mock('../DiffSource', () => ({
  GitHubDiffSource: vi.fn(),
  LocalDiffSource: vi.fn(),
}));
vi.mock('../reviewUtils', () => ({
  formatReviewFeedback: vi.fn().mockReturnValue('feedback'),
  formatCIFailureFeedback: vi.fn(),
}));
vi.mock('../../session/orchestrator-config', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    verify: [],
    autofix: [],
    ci_check_name: [],
    allowed_tools: [],
    bash_rules: [],
    bootstrap_script: '',
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
  runtimeSettings: { auto_review_concurrency: 1 },
}));
vi.mock('../../db/queries', () => ({
  getPRByNumber: vi.fn().mockReturnValue(null),
  getPRBySessionId: vi.fn().mockReturnValue(null),
  getSession: vi.fn().mockReturnValue(null),
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
  setPreReviewStage: vi.fn(),
  setLastReviewedSha: vi.fn(),
  hasTestResultForSha: vi.fn().mockReturnValue(false),
  upsertTestResult: vi.fn(),
  hasAnalyzeResultForSha: vi.fn().mockReturnValue(false),
  upsertAnalyzeResult: vi.fn(),
  getAnalyzeResult: vi.fn().mockReturnValue(null),
  enqueueFeedbackItem: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { ReviewOrchestrator } from '../ReviewOrchestrator';
import type { PRReviewService } from '../PRReviewService';
import type { DispositionsParsedPayload } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSessionManager() {
  const sm = new EventEmitter();
  return Object.assign(sm, {
    send: vi.fn(),
    sendOrResume: vi.fn().mockResolvedValue('session-id'),
    addToRevertLock: vi.fn(),
  });
}

function makeReviewService(): PRReviewService {
  return {
    reviewPR: vi.fn().mockResolvedValue({
      verdict: 'approved',
      summary: 'ok',
      dimensions: [],
    }),
  } as unknown as PRReviewService;
}

function makeGitHubClient(threadIdMap: Record<number, string | null> = {}) {
  return {
    findThreadByCommentId: vi
      .fn()
      .mockImplementation(
        async (commentId: number) => threadIdMap[commentId] ?? null,
      ),
    addPullRequestReviewThreadReply: vi.fn().mockResolvedValue(undefined),
    resolveReviewThread: vi.fn().mockResolvedValue(undefined),
  };
}

function makePayload(
  overrides: Partial<DispositionsParsedPayload> = {},
): DispositionsParsedPayload {
  return {
    sessionId: 'session-abc',
    prNumber: 42,
    repo: 'owner/repo',
    headSha: 'abc1234567',
    dispositions: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── addressed → reply + resolve ───────────────────────────────────────────────

describe('ReviewOrchestrator.handleDispositions — addressed', () => {
  it('posts reply "Addressed in <sha>" and resolves the thread for addressed disposition', async () => {
    const github = makeGitHubClient({ 101: 'PRRT_thread_abc' });
    const sm = makeSessionManager();
    const rs = makeReviewService();
    const orch = new ReviewOrchestrator(rs, sm as any, true, github as any);

    await orch.handleDispositions(
      makePayload({
        headSha: 'abc1234',
        dispositions: [{ comment_id: 101, disposition: 'addressed' }],
      }),
    );

    expect(github.addPullRequestReviewThreadReply).toHaveBeenCalledWith(
      'PRRT_thread_abc',
      'Addressed in abc1234',
    );
    expect(github.resolveReviewThread).toHaveBeenCalledWith('PRRT_thread_abc');
  });

  it('uses 7-char SHA prefix in the reply', async () => {
    const github = makeGitHubClient({ 200: 'PRRT_thread_xyz' });
    const sm = makeSessionManager();
    const rs = makeReviewService();
    const orch = new ReviewOrchestrator(rs, sm as any, true, github as any);

    await orch.handleDispositions(
      makePayload({
        headSha: 'deadbeef1234567890',
        dispositions: [{ comment_id: 200, disposition: 'addressed' }],
      }),
    );

    expect(github.addPullRequestReviewThreadReply).toHaveBeenCalledWith(
      'PRRT_thread_xyz',
      'Addressed in deadbee',
    );
    expect(github.resolveReviewThread).toHaveBeenCalledWith('PRRT_thread_xyz');
  });
});

// ── wont_fix → reply only ────────────────────────────────────────────────────

describe('ReviewOrchestrator.handleDispositions — wont_fix', () => {
  it('posts "Won\'t fix: <reason>" reply but does NOT resolve the thread', async () => {
    const github = makeGitHubClient({ 300: 'PRRT_thread_wf' });
    const sm = makeSessionManager();
    const rs = makeReviewService();
    const orch = new ReviewOrchestrator(rs, sm as any, true, github as any);

    await orch.handleDispositions(
      makePayload({
        dispositions: [
          {
            comment_id: 300,
            disposition: 'wont_fix',
            reason: 'intentional design',
          },
        ],
      }),
    );

    expect(github.addPullRequestReviewThreadReply).toHaveBeenCalledWith(
      'PRRT_thread_wf',
      "Won't fix: intentional design",
    );
    expect(github.resolveReviewThread).not.toHaveBeenCalled();
  });
});

// ── out_of_scope → reply only ────────────────────────────────────────────────

describe('ReviewOrchestrator.handleDispositions — out_of_scope', () => {
  it('posts "Out of scope for this PR: <reason>" reply but does NOT resolve the thread', async () => {
    const github = makeGitHubClient({ 400: 'PRRT_thread_oos' });
    const sm = makeSessionManager();
    const rs = makeReviewService();
    const orch = new ReviewOrchestrator(rs, sm as any, true, github as any);

    await orch.handleDispositions(
      makePayload({
        dispositions: [
          {
            comment_id: 400,
            disposition: 'out_of_scope',
            reason: 'different PR',
          },
        ],
      }),
    );

    expect(github.addPullRequestReviewThreadReply).toHaveBeenCalledWith(
      'PRRT_thread_oos',
      'Out of scope for this PR: different PR',
    );
    expect(github.resolveReviewThread).not.toHaveBeenCalled();
  });
});

// ── comment_id → thread node-id mapping ──────────────────────────────────────

describe('ReviewOrchestrator.handleDispositions — comment_id mapping', () => {
  it('calls findThreadByCommentId with the correct comment_id, prNumber and repo', async () => {
    const github = makeGitHubClient({ 999: 'PRRT_found' });
    const sm = makeSessionManager();
    const rs = makeReviewService();
    const orch = new ReviewOrchestrator(rs, sm as any, true, github as any);

    await orch.handleDispositions(
      makePayload({
        prNumber: 77,
        repo: 'myorg/myrepo',
        dispositions: [{ comment_id: 999, disposition: 'addressed' }],
      }),
    );

    expect(github.findThreadByCommentId).toHaveBeenCalledWith(
      999,
      77,
      'myorg/myrepo',
    );
  });

  it('skips a comment when findThreadByCommentId returns null (no matching thread)', async () => {
    const github = makeGitHubClient({ 123: null }); // null = not found
    const sm = makeSessionManager();
    const rs = makeReviewService();
    const orch = new ReviewOrchestrator(rs, sm as any, true, github as any);

    await orch.handleDispositions(
      makePayload({
        dispositions: [{ comment_id: 123, disposition: 'addressed' }],
      }),
    );

    expect(github.addPullRequestReviewThreadReply).not.toHaveBeenCalled();
    expect(github.resolveReviewThread).not.toHaveBeenCalled();
  });

  it('processes multiple dispositions independently, skipping those without a thread', async () => {
    const github = makeGitHubClient({ 1: 'PRRT_A', 3: 'PRRT_C' }); // 2 has no thread
    const sm = makeSessionManager();
    const rs = makeReviewService();
    const orch = new ReviewOrchestrator(rs, sm as any, true, github as any);

    await orch.handleDispositions(
      makePayload({
        dispositions: [
          { comment_id: 1, disposition: 'addressed' },
          { comment_id: 2, disposition: 'wont_fix', reason: 'n/a' },
          { comment_id: 3, disposition: 'out_of_scope', reason: 'different' },
        ],
      }),
    );

    expect(github.addPullRequestReviewThreadReply).toHaveBeenCalledTimes(2);
    expect(github.resolveReviewThread).toHaveBeenCalledWith('PRRT_A');
    expect(github.resolveReviewThread).toHaveBeenCalledTimes(1);
  });
});

// ── empty / no github client ─────────────────────────────────────────────────

describe('ReviewOrchestrator.handleDispositions — empty/disabled cases', () => {
  it('does nothing when dispositions array is empty', async () => {
    const github = makeGitHubClient();
    const sm = makeSessionManager();
    const rs = makeReviewService();
    const orch = new ReviewOrchestrator(rs, sm as any, true, github as any);

    await orch.handleDispositions(makePayload({ dispositions: [] }));

    expect(github.findThreadByCommentId).not.toHaveBeenCalled();
    expect(github.addPullRequestReviewThreadReply).not.toHaveBeenCalled();
  });

  it('does nothing when github client is not configured', async () => {
    const sm = makeSessionManager();
    const rs = makeReviewService();
    const orch = new ReviewOrchestrator(rs, sm as any, true, undefined);

    await expect(
      orch.handleDispositions(
        makePayload({
          dispositions: [{ comment_id: 1, disposition: 'addressed' }],
        }),
      ),
    ).resolves.not.toThrow();
  });

  it('continues processing remaining dispositions when one GitHub call fails', async () => {
    const github = makeGitHubClient({ 10: 'PRRT_10', 20: 'PRRT_20' });
    vi.mocked(github.addPullRequestReviewThreadReply)
      .mockRejectedValueOnce(new Error('API error'))
      .mockResolvedValue(undefined);

    const sm = makeSessionManager();
    const rs = makeReviewService();
    const orch = new ReviewOrchestrator(rs, sm as any, true, github as any);

    await expect(
      orch.handleDispositions(
        makePayload({
          dispositions: [
            { comment_id: 10, disposition: 'addressed' },
            { comment_id: 20, disposition: 'wont_fix', reason: 'by design' },
          ],
        }),
      ),
    ).resolves.not.toThrow();

    // Second disposition should still be processed despite first failing
    expect(github.addPullRequestReviewThreadReply).toHaveBeenCalledTimes(2);
  });
});

// ── dispositions_parsed event triggers handleDispositions ─────────────────────

describe('ReviewOrchestrator — dispositions_parsed event wiring', () => {
  it('calls handleDispositions when sessionManager emits dispositions_parsed', async () => {
    const github = makeGitHubClient({ 55: 'PRRT_55' });
    const sm = makeSessionManager();
    const rs = makeReviewService();
    const orch = new ReviewOrchestrator(rs, sm as any, true, github as any);

    const payload: DispositionsParsedPayload = {
      sessionId: 'session-xyz',
      prNumber: 10,
      repo: 'owner/repo',
      headSha: 'sha9999',
      dispositions: [{ comment_id: 55, disposition: 'addressed' }],
    };

    sm.emit('dispositions_parsed', payload);
    await new Promise((r) => setTimeout(r, 30));

    expect(github.findThreadByCommentId).toHaveBeenCalledWith(
      55,
      10,
      'owner/repo',
    );
    expect(github.addPullRequestReviewThreadReply).toHaveBeenCalledWith(
      'PRRT_55',
      'Addressed in sha9999',
    );
    expect(github.resolveReviewThread).toHaveBeenCalledWith('PRRT_55');
  });
});
