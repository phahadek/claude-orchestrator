import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () => ({
  getAllOpenPRs: vi.fn().mockReturnValue([]),
  getApprovedOpenPRs: vi.fn().mockReturnValue([]),
  getApprovedLocalBranches: vi.fn().mockReturnValue([]),
  getPRByNumber: vi.fn().mockReturnValue(null),
  getRoutedCommentIds: vi.fn().mockReturnValue(new Set()),
  markCommentsRouted: vi.fn(),
  setPauseReason: vi.fn(),
  updateMergeState: vi.fn(),
  getSession: vi.fn().mockReturnValue(null),
  getSetting: vi.fn().mockReturnValue(undefined),
  updatePRState: vi.fn(),
  deleteAllAutofixShasForPR: vi.fn(),
  setHeadSha: vi.fn(),
  markLocalBranchMerged: vi.fn(),
  setLocalBranchPauseReason: vi.fn(),
}));

vi.mock('../config.js', () => ({
  GITHUB_TOKEN: 'test-token',
  GITHUB_REPO: 'owner/repo',
  getProjectByGithubRepo: vi.fn().mockReturnValue(null),
  getProjectById: vi.fn().mockReturnValue(null),
  runtimeSettings: {
    ci_poll_interval_seconds: 5,
    ci_poll_max_minutes: 1,
  },
}));

vi.mock('../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({ ci_check_name: [] }),
}));

vi.mock('../audit/AuditLog.js', () => ({ recordEvent: vi.fn() }));
vi.mock('../config/corporateMode.js', () => ({
  getCorporateMode: vi.fn().mockReturnValue({
    enabled: false,
    envLocked: false,
    gates: { requireHumanApproval: false },
  }),
}));
vi.mock('../routes/tasks.js', () => ({ emitTaskUpdated: vi.fn() }));
vi.mock('../tasks/TaskBackend.js', () => ({ getTaskBackend: vi.fn() }));
vi.mock('../orchestration/localMergeRunner.js', () => ({
  squashMergeLocal: vi.fn(),
}));
vi.mock('../orchestration/localBranchHelpers.js', () => ({
  detectMergeConflict: vi.fn(),
}));
vi.mock('../github/reviewUtils.js', () => ({
  formatMergeConflictFeedback: vi.fn().mockReturnValue('conflict feedback'),
  formatCIFailureFeedback: vi.fn().mockReturnValue('ci feedback'),
  shouldAutoReview: vi.fn().mockReturnValue(false),
  formatReviewFeedback: vi.fn().mockReturnValue('review feedback'),
  formatCoalescedHumanBatch: vi.fn().mockReturnValue('human feedback'),
}));

import { GitHubClient } from '../github/GitHubClient.js';
import { GitHubApiError, GitHubRateLimitError } from '../github/types.js';
import { PRMergeWatcher } from '../github/PRMergeWatcher.js';
import { ReviewerCommentsWatcher } from '../github/ReviewerCommentsWatcher.js';
import { AutoMerger } from '../github/AutoMerger.js';
import {
  getAllOpenPRs,
  getApprovedOpenPRs,
  getApprovedLocalBranches,
  getPRByNumber,
} from '../db/queries.js';
import { getProjectByGithubRepo } from '../config.js';
import type { PullRequestRow } from '../db/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const RESET_EPOCH = Math.floor(Date.now() / 1000) + 300; // 5 min from now

function makeRateLimitResponse() {
  return {
    ok: false,
    status: 403,
    headers: new Headers({
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(RESET_EPOCH),
      'x-ratelimit-used': '5000',
    }),
    text: () =>
      Promise.resolve(
        JSON.stringify({
          message:
            'API rate limit exceeded for user ID 83268694. Limit: 5000/hour.',
          documentation_url:
            'https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api#rate-limiting',
          status: '403',
        }),
      ),
  };
}

function makeOtherForbiddenResponse() {
  return {
    ok: false,
    status: 403,
    headers: new Headers({}),
    text: () =>
      Promise.resolve(
        JSON.stringify({ message: 'Must have admin rights to Repository.' }),
      ),
  };
}

function makePR(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: 42,
    pr_url: 'https://github.com/owner/repo/pull/42',
    task_id: null,
    session_id: null,
    repo: 'owner/repo',
    title: 'Test PR',
    body: null,
    head_branch: 'feature/test',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: null,
    review_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    synced_at: '2026-01-01T00:00:00Z',
    review_session_id: null,
    review_iteration: 0,
    head_sha: 'abc123',
    last_reviewed_sha: null,
    node_id: null,
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
    failing_checks: null,
    pending_push: 0,
    pause_reason: null,
    ...overrides,
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ── GitHubClient rate-limit detection ─────────────────────────────────────────

describe('GitHubClient rate-limit detection', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('throws GitHubRateLimitError on 403 with rate-limit message', async () => {
    fetchSpy.mockResolvedValueOnce(makeRateLimitResponse() as never);
    const client = new GitHubClient();
    await expect(client.listOpenPRs('owner/repo')).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    );
  });

  it('GitHubRateLimitError is also a GitHubApiError (inheritance)', async () => {
    fetchSpy.mockResolvedValueOnce(makeRateLimitResponse() as never);
    const client = new GitHubClient();
    try {
      await client.listOpenPRs('owner/repo');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubRateLimitError);
      expect(err).toBeInstanceOf(GitHubApiError);
    }
  });

  it('carries resetAt, limit, used from response headers', async () => {
    fetchSpy.mockResolvedValueOnce(makeRateLimitResponse() as never);
    const client = new GitHubClient();
    try {
      await client.listOpenPRs('owner/repo');
      expect.fail('should have thrown');
    } catch (err) {
      const rle = err as GitHubRateLimitError;
      expect(rle.resetAt).toBeInstanceOf(Date);
      expect(rle.resetAt.getTime()).toBe(RESET_EPOCH * 1000);
      expect(rle.limit).toBe(5000);
      expect(rle.used).toBe(5000);
    }
  });

  it('throws plain GitHubApiError (not GitHubRateLimitError) on non-rate-limit 403', async () => {
    fetchSpy.mockResolvedValueOnce(makeOtherForbiddenResponse() as never);
    const client = new GitHubClient();
    try {
      await client.listOpenPRs('owner/repo');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect(err).not.toBeInstanceOf(GitHubRateLimitError);
      expect((err as GitHubApiError).status).toBe(403);
    }
  });

  it('detects secondary rate limit message', async () => {
    const secondaryResponse = {
      ok: false,
      status: 403,
      headers: new Headers({
        'retry-after': '60',
        'x-ratelimit-limit': '0',
        'x-ratelimit-used': '0',
      }),
      text: () =>
        Promise.resolve(
          JSON.stringify({
            message:
              'You have exceeded a secondary rate limit and have been temporarily blocked from content creation.',
          }),
        ),
    };
    fetchSpy.mockResolvedValueOnce(secondaryResponse as never);
    const client = new GitHubClient();
    await expect(client.listOpenPRs('owner/repo')).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    );
  });
});

// ── PRMergeWatcher backoff ─────────────────────────────────────────────────────

describe('PRMergeWatcher backoff on rate-limit', () => {
  it('pauses GitHub API calls for the backoff window (5 min in the future)', async () => {
    const rateLimitErr = new GitHubRateLimitError(
      'API rate limit exceeded',
      new Date(Date.now() + 300_000),
      5000,
      5000,
    );
    const mockGitHub = {
      getPRState: vi.fn().mockRejectedValue(rateLimitErr),
    };
    const broadcast = vi.fn();
    const watcher = new PRMergeWatcher(
      mockGitHub as never,
      {} as never,
      undefined,
      broadcast,
    );

    vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);

    // First poll — hits rate limit
    await watcher.poll();
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'github_rate_limit_hit' }),
    );

    mockGitHub.getPRState.mockClear();

    // Second poll — should be skipped (within 5-min backoff window)
    await watcher.poll();
    expect(mockGitHub.getPRState).not.toHaveBeenCalled();
  });

  it('broadcasts github_rate_limit_hit only once per backoff window', async () => {
    const rateLimitErr = new GitHubRateLimitError(
      'API rate limit exceeded',
      new Date(Date.now() + 300_000),
      5000,
      5000,
    );
    const mockGitHub = {
      getPRState: vi.fn().mockRejectedValue(rateLimitErr),
    };
    const broadcast = vi.fn();
    const watcher = new PRMergeWatcher(
      mockGitHub as never,
      {} as never,
      undefined,
      broadcast,
    );

    vi.mocked(getAllOpenPRs).mockReturnValue([
      makePR({ pr_number: 1 }),
      makePR({ pr_number: 2 }),
    ]);

    await watcher.poll();

    const hitBroadcasts = broadcast.mock.calls.filter(
      (args) => (args[0] as { type: string }).type === 'github_rate_limit_hit',
    );
    expect(hitBroadcasts).toHaveLength(1);
  });

  it('clears pause and broadcasts github_rate_limit_cleared after reset window passes', async () => {
    const pastReset = new Date(Date.now() - 1000); // already expired
    const rateLimitErr = new GitHubRateLimitError(
      'API rate limit exceeded',
      pastReset,
      5000,
      5000,
    );
    const mockGitHub = {
      getPRState: vi
        .fn()
        .mockRejectedValueOnce(rateLimitErr)
        .mockResolvedValue({ state: 'open', headSha: 'abc123' }),
    };
    const broadcast = vi.fn();
    const watcher = new PRMergeWatcher(
      mockGitHub as never,
      {} as never,
      undefined,
      broadcast,
    );

    vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);

    // First poll — hits rate limit with pastReset
    await watcher.poll();

    // Second poll — resetAt is in the past, backoff clears
    await watcher.poll();

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'github_rate_limit_cleared' }),
    );
    expect(mockGitHub.getPRState).toHaveBeenCalledTimes(2);
  });
});

// ── ReviewerCommentsWatcher backoff ───────────────────────────────────────────

describe('ReviewerCommentsWatcher backoff on rate-limit', () => {
  it('pauses polling for the backoff window on rate-limit 403', async () => {
    const rateLimitErr = new GitHubRateLimitError(
      'API rate limit exceeded',
      new Date(Date.now() + 300_000),
      5000,
      5000,
    );
    const mockGitHub = {
      listPRReviews: vi.fn().mockRejectedValue(rateLimitErr),
      listPRReviewComments: vi.fn().mockResolvedValue([]),
      listPRIssueComments: vi.fn().mockResolvedValue([]),
    };
    const broadcast = vi.fn();
    const watcher = new ReviewerCommentsWatcher(
      mockGitHub as never,
      {} as never,
      broadcast,
    );

    vi.mocked(getAllOpenPRs).mockReturnValue([
      makePR({ session_id: 'sess-1', pause_reason: null }),
    ]);

    // First poll — hits rate limit
    await watcher.pollAll();
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'github_rate_limit_hit' }),
    );

    mockGitHub.listPRReviews.mockClear();

    // Second poll — paused
    await watcher.pollAll();
    expect(mockGitHub.listPRReviews).not.toHaveBeenCalled();
  });

  it('broadcasts github_rate_limit_cleared when backoff expires', async () => {
    const pastReset = new Date(Date.now() - 1000);
    const rateLimitErr = new GitHubRateLimitError(
      'API rate limit exceeded',
      pastReset,
      5000,
      5000,
    );
    const mockGitHub = {
      listPRReviews: vi
        .fn()
        .mockRejectedValueOnce(rateLimitErr)
        .mockResolvedValue([]),
      listPRReviewComments: vi.fn().mockResolvedValue([]),
      listPRIssueComments: vi.fn().mockResolvedValue([]),
    };
    const broadcast = vi.fn();
    const watcher = new ReviewerCommentsWatcher(
      mockGitHub as never,
      {} as never,
      broadcast,
    );

    vi.mocked(getAllOpenPRs).mockReturnValue([
      makePR({ session_id: 'sess-1', pause_reason: null }),
    ]);

    await watcher.pollAll();
    await watcher.pollAll();

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'github_rate_limit_cleared' }),
    );
  });
});

// ── AutoMerger backoff ────────────────────────────────────────────────────────

describe('AutoMerger backoff on rate-limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: getApprovedLocalBranches returns empty (not testing local branches here)
    vi.mocked(getApprovedLocalBranches).mockReturnValue([]);
  });

  it('skips GitHub API calls for the backoff window (5 min in the future)', async () => {
    const rateLimitErr = new GitHubRateLimitError(
      'API rate limit exceeded',
      new Date(Date.now() + 300_000),
      5000,
      5000,
    );
    const mockGitHub = {
      fetchPRStatusConditional: vi.fn().mockRejectedValue(rateLimitErr),
    };
    const broadcast = vi.fn();

    // Set up project so run() proceeds past the early-return guard
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/test',
      autoMergeEnabled: true,
    } as never);
    vi.mocked(getPRByNumber).mockReturnValue(
      makePR({ pause_reason: null, state: 'open' }),
    );
    vi.mocked(getApprovedOpenPRs).mockReturnValue([makePR()]);

    const watcher = new AutoMerger(mockGitHub as never, {} as never, broadcast);

    // First pollOnce — triggers attempt() → run() → hits rate limit
    await watcher.pollOnce();
    await flushMicrotasks(); // let run() complete

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'github_rate_limit_hit' }),
    );

    // Reset mocks to detect if getApprovedOpenPRs is called on second pollOnce
    vi.mocked(getApprovedOpenPRs).mockClear();

    // Second pollOnce — should skip entirely (pausedUntil is 5 min in the future)
    await watcher.pollOnce();
    expect(getApprovedOpenPRs).not.toHaveBeenCalled();
  });

  it('broadcasts github_rate_limit_cleared after reset window passes', async () => {
    const pastReset = new Date(Date.now() - 1000); // already expired
    const rateLimitErr = new GitHubRateLimitError(
      'API rate limit exceeded',
      pastReset,
      5000,
      5000,
    );
    const mockGitHub = {
      fetchPRStatusConditional: vi.fn().mockRejectedValue(rateLimitErr),
    };
    const broadcast = vi.fn();

    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/test',
      autoMergeEnabled: true,
    } as never);
    vi.mocked(getPRByNumber).mockReturnValue(
      makePR({ pause_reason: null, state: 'open' }),
    );
    vi.mocked(getApprovedOpenPRs).mockReturnValue([makePR()]);

    const watcher = new AutoMerger(mockGitHub as never, {} as never, broadcast);

    // First pollOnce — triggers run(), hits rate limit with pastReset
    await watcher.pollOnce();
    await flushMicrotasks();

    // Second pollOnce — pastReset already expired, backoff clears
    await watcher.pollOnce();

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'github_rate_limit_cleared' }),
    );
  });
});
