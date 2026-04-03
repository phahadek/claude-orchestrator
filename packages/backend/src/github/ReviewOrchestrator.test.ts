import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks (must come before imports of the modules under test) ──────────────

vi.mock('../db/queries.js', () => ({
  setPRReviewResult: vi.fn(),
  getPRByNumber: vi.fn(),
  getPRBySessionId: vi.fn(),
  getSetting: vi.fn().mockReturnValue(undefined),
  incrementReviewIteration: vi.fn(),
  setLastReviewedSha: vi.fn(),
  setHeadSha: vi.fn(),
  updatePRDraftStatus: vi.fn(),
}));

vi.mock('../config.js', () => ({
  config: {
    projects: [
      { id: 'proj-1', name: 'Project 1', githubRepo: 'owner/repo', projectDir: '/tmp', contextUrl: 'https://notion.so/ctx', boardId: 'board-1' },
    ],
  },
}));

import { ReviewOrchestrator } from './ReviewOrchestrator';
import { setPRReviewResult, getPRByNumber, getPRBySessionId, incrementReviewIteration, setLastReviewedSha, setHeadSha, updatePRDraftStatus } from '../db/queries';
import type { PRReviewService } from './PRReviewService';
import type { GitHubClient } from './GitHubClient';
import type { PullRequest } from './types';
import type { ReviewJob } from './types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const baseFreshPR: PullRequest = {
  nodeId: 'node-1',
  id: 1,
  title: 'feat: test',
  body: null,
  url: 'https://github.com/owner/repo/pull/1',
  apiUrl: 'https://api.github.com/repos/owner/repo/pulls/1',
  headBranch: 'feature/test',
  headSha: 'sha-abc',
  baseBranch: 'dev',
  state: 'open',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  mergeableState: null,
  draft: false,
};

function makeMockGitHubClient(fetchPRResolveWith?: Partial<PullRequest>): GitHubClient {
  return {
    markPRReady: vi.fn().mockResolvedValue(undefined),
    fetchPR: vi.fn().mockResolvedValue({ ...baseFreshPR, ...fetchPRResolveWith }),
  } as unknown as GitHubClient;
}

function makeMockNotionClient() {
  return {
    updateStatus: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockSessionManager() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    send: vi.fn(),
  });
}

function makeMockReviewService(resolveWith?: object): PRReviewService {
  const defaultResult = {
    prNumber: 1,
    repo: 'owner/repo',
    verdict: 'approved',
    dimensions: [],
    summary: 'All good.',
    reviewedAt: new Date().toISOString(),
  };
  return {
    reviewPR: vi.fn().mockResolvedValue(resolveWith ?? defaultResult),
    sendReReview: vi.fn().mockResolvedValue({ ...defaultResult, summary: 'Fixed.' }),
    reReviewPR: vi.fn().mockResolvedValue(resolveWith ?? defaultResult),
  } as unknown as PRReviewService;
}

const baseJob: ReviewJob = {
  prNumber: 1,
  repo: 'owner/repo',
  taskId: 'task-abc',
  taskUrl: 'https://notion.so/task',
  contextUrl: 'https://notion.so/ctx',
};

const basePRRow = {
  id: 1,
  pr_number: 1,
  pr_url: 'https://github.com/owner/repo/pull/1',
  notion_task_id: 'task-abc',
  session_id: 'coding-session-id',
  repo: 'owner/repo',
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
  review_session_id: 'review-session-id',
  review_iteration: 0,
  head_sha: 'sha-abc',
  last_reviewed_sha: null,
  node_id: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Disabled orchestrator ─────────────────────────────────────────────────────

describe('ReviewOrchestrator — disabled', () => {
  it('does not enqueue when enabled === false', async () => {
    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), makeMockNotionClient(), 1, false);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 20));

    expect(vi.mocked(rs.reviewPR)).not.toHaveBeenCalled();
  });

  it('does not respond to push_detected when disabled', async () => {
    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), makeMockNotionClient(), 1, false);

    sm.emit('push_detected', { sessionId: 'coding-session-id' });
    await new Promise((r) => setTimeout(r, 20));

    expect(vi.mocked(rs.reReviewPR)).not.toHaveBeenCalled();
  });
});

// ── Missing taskId ────────────────────────────────────────────────────────────

describe('ReviewOrchestrator — missing taskId', () => {
  it('does not enqueue when job.taskId is empty', async () => {
    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), makeMockNotionClient(), 1, true);

    sm.emit('pr_opened', { ...baseJob, taskId: '' });
    await new Promise((r) => setTimeout(r, 20));

    expect(vi.mocked(rs.reviewPR)).not.toHaveBeenCalled();
  });
});

// ── Concurrency ───────────────────────────────────────────────────────────────

describe('ReviewOrchestrator — concurrency', () => {
  it('respects maxConcurrency=1 (second job waits for first to complete)', async () => {
    const sm = makeMockSessionManager();

    let resolveFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let firstResolve!: () => void;
    const firstComplete = new Promise<void>((resolve) => {
      firstResolve = resolve;
    });

    const callOrder: number[] = [];
    const rs = {
      reviewPR: vi.fn()
        .mockImplementationOnce(async () => {
          callOrder.push(1);
          resolveFirst();
          await firstComplete;
          return { prNumber: 1, repo: 'owner/repo', verdict: 'approved', dimensions: [], summary: 'ok', reviewedAt: '' };
        })
        .mockImplementationOnce(async () => {
          callOrder.push(2);
          return { prNumber: 2, repo: 'owner/repo', verdict: 'approved', dimensions: [], summary: 'ok', reviewedAt: '' };
        }),
      sendReReview: vi.fn(),
      reReviewPR: vi.fn(),
    } as unknown as PRReviewService;

    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), makeMockNotionClient(), 1, true);

    sm.emit('pr_opened', { ...baseJob, prNumber: 1 });
    sm.emit('pr_opened', { ...baseJob, prNumber: 2 });

    // Wait for first job to start
    await firstStarted;
    // Second job should not have started yet
    expect(callOrder).toEqual([1]);

    // Let first complete
    firstResolve();
    await new Promise((r) => setTimeout(r, 30));

    // Now second should have run
    expect(callOrder).toEqual([1, 2]);
  });
});

// ── pr_review_complete broadcast ──────────────────────────────────────────────

describe('ReviewOrchestrator — pr_review_complete broadcast', () => {
  it('broadcasts pr_review_complete after review completes', async () => {
    const sm = makeMockSessionManager();
    const rs = makeMockReviewService({
      prNumber: 1,
      repo: 'owner/repo',
      verdict: 'approved',
      dimensions: [],
      summary: 'Looks good.',
      reviewedAt: new Date().toISOString(),
    });

    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), makeMockNotionClient(), 1, true);

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'pr_review_complete',
      prNumber: 1,
      repo: 'owner/repo',
      verdict: 'approved',
      summary: 'Looks good.',
    });
  });
});

// ── Feedback routing ──────────────────────────────────────────────────────────

describe('ReviewOrchestrator — feedback routing on needs_changes', () => {
  it('sends feedback to coding session when verdict is needs_changes', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService({
      prNumber: 1,
      repo: 'owner/repo',
      verdict: 'needs_changes',
      dimensions: [{ name: 'Diff vs Context spec', passed: false, notes: 'Missing export.' }],
      summary: 'One dimension failed.',
      reviewedAt: new Date().toISOString(),
    });

    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), makeMockNotionClient(), 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(sm.send)).toHaveBeenCalledOnce();
    const [sessionId, message] = vi.mocked(sm.send).mock.calls[0];
    expect(sessionId).toBe('coding-session-id');
    expect(message).toContain('Review Feedback');
    expect(message).toContain('Needs changes');
    expect(message).toContain('Missing export.');
  });

  it('does not send feedback when verdict is approved', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService({
      prNumber: 1,
      repo: 'owner/repo',
      verdict: 'approved',
      dimensions: [],
      summary: 'All good.',
      reviewedAt: new Date().toISOString(),
    });

    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), makeMockNotionClient(), 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(sm.send)).not.toHaveBeenCalled();
  });
});

// ── Push detection and re-review ──────────────────────────────────────────────

describe('ReviewOrchestrator — push_detected triggers re-review', () => {
  it('calls reReviewPR on push_detected', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue(basePRRow as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();

    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), makeMockNotionClient(), 1, true);

    sm.emit('push_detected', { sessionId: 'coding-session-id' });
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(rs.reReviewPR)).toHaveBeenCalledWith(1, 'owner/repo');
  });

  it('emits review_verdict after re-review completes', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue(basePRRow as any);

    const sm = makeMockSessionManager();
    const rs = {
      reviewPR: vi.fn(),
      sendReReview: vi.fn(),
      reReviewPR: vi.fn().mockResolvedValue({
        prNumber: 1,
        repo: 'owner/repo',
        verdict: 'approved',
        dimensions: [],
        summary: 'Fixed.',
        reviewedAt: new Date().toISOString(),
      }),
    } as unknown as PRReviewService;

    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), makeMockNotionClient(), 1, true);

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    sm.emit('push_detected', { sessionId: 'coding-session-id' });
    await new Promise((r) => setTimeout(r, 30));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'review_verdict',
      prNumber: 1,
      repo: 'owner/repo',
      verdict: 'approved',
      iteration: 1,
    });
  });

  it('sends feedback to coding session when re-review verdict is needs_changes', async () => {
    // Use review_iteration: 1 so orchestrator calculates iteration = 2
    vi.mocked(getPRBySessionId).mockReturnValue({ ...basePRRow, review_iteration: 1 } as any);

    const sm = makeMockSessionManager();
    const rs = {
      reviewPR: vi.fn(),
      sendReReview: vi.fn(),
      reReviewPR: vi.fn().mockResolvedValue({
        prNumber: 1,
        repo: 'owner/repo',
        verdict: 'needs_changes',
        dimensions: [{ name: 'Diff vs Context spec', passed: false, notes: 'Still missing.' }],
        summary: 'Still failing.',
        reviewedAt: new Date().toISOString(),
      }),
    } as unknown as PRReviewService;

    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), makeMockNotionClient(), 1, true);

    sm.emit('push_detected', { sessionId: 'coding-session-id' });
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(sm.send)).toHaveBeenCalledOnce();
    const [sessionId, message] = vi.mocked(sm.send).mock.calls[0];
    expect(sessionId).toBe('coding-session-id');
    expect(message).toContain('Iteration 2');
  });

  it('ignores push_detected when PR has no review_session_id', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue({ ...basePRRow, review_session_id: null } as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();

    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), makeMockNotionClient(), 1, true);

    sm.emit('push_detected', { sessionId: 'coding-session-id' });
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(rs.reReviewPR)).not.toHaveBeenCalled();
  });

  it('skips re-review when headSha === lastReviewedSha (no new commits since last review)', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue({
      ...basePRRow,
      head_sha: 'same-sha',
      last_reviewed_sha: 'same-sha',
    } as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    // fetchPR returns the same SHA as last_reviewed_sha — no new commits
    const gc = makeMockGitHubClient({ headSha: 'same-sha' });
    new ReviewOrchestrator(rs, sm as any, gc, makeMockNotionClient(), 1, true);

    sm.emit('push_detected', { sessionId: 'coding-session-id' });
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(rs.reReviewPR)).not.toHaveBeenCalled();
  });

  it('calls setLastReviewedSha with the fresh head SHA after a successful re-review', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue({ ...basePRRow, head_sha: 'sha-abc', last_reviewed_sha: null } as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), makeMockNotionClient(), 1, true);

    sm.emit('push_detected', { sessionId: 'coding-session-id' });
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(setLastReviewedSha)).toHaveBeenCalledWith(1, 'owner/repo', 'sha-abc');
  });

  it('calls fetchPR with correct repo and PR number on push_detected', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue(basePRRow as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    const gc = makeMockGitHubClient();
    new ReviewOrchestrator(rs, sm as any, gc, makeMockNotionClient(), 1, true);

    sm.emit('push_detected', { sessionId: 'coding-session-id' });
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(gc.fetchPR)).toHaveBeenCalledWith('owner/repo', 1);
  });

  it('triggers re-review when DB has null head_sha but GitHub returns a new SHA', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue({ ...basePRRow, head_sha: null, last_reviewed_sha: null } as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    // GitHub returns a fresh SHA even though DB had null
    const gc = makeMockGitHubClient({ headSha: 'fresh-sha' });
    new ReviewOrchestrator(rs, sm as any, gc, makeMockNotionClient(), 1, true);

    sm.emit('push_detected', { sessionId: 'coding-session-id' });
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(rs.reReviewPR)).toHaveBeenCalledOnce();
  });

  it('calls setHeadSha when fresh GitHub SHA differs from DB value', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue({ ...basePRRow, head_sha: 'old-sha', last_reviewed_sha: null } as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    const gc = makeMockGitHubClient({ headSha: 'new-sha' });
    new ReviewOrchestrator(rs, sm as any, gc, makeMockNotionClient(), 1, true);

    sm.emit('push_detected', { sessionId: 'coding-session-id' });
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(setHeadSha)).toHaveBeenCalledWith(1, 'owner/repo', 'new-sha');
  });

  it('does not call setHeadSha when fresh SHA matches DB value', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue({ ...basePRRow, head_sha: 'sha-abc', last_reviewed_sha: null } as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    // fetchPR returns same SHA as DB
    const gc = makeMockGitHubClient({ headSha: 'sha-abc' });
    new ReviewOrchestrator(rs, sm as any, gc, makeMockNotionClient(), 1, true);

    sm.emit('push_detected', { sessionId: 'coding-session-id' });
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(setHeadSha)).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent push_detected for the same coding session', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue(basePRRow as any);

    let resolveReview!: () => void;
    const reviewStarted = new Promise<void>((r) => { resolveReview = r; });
    let completeReview!: () => void;
    const reviewDone = new Promise<void>((r) => { completeReview = r; });

    const rs = {
      reviewPR: vi.fn(),
      sendReReview: vi.fn(),
      reReviewPR: vi.fn().mockImplementationOnce(async () => {
        resolveReview();
        await reviewDone;
        return { prNumber: 1, repo: 'owner/repo', verdict: 'approved', dimensions: [], summary: 'ok', reviewedAt: '' };
      }),
    } as unknown as PRReviewService;

    const sm = makeMockSessionManager();
    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), makeMockNotionClient(), 1, true);

    // Fire two push_detected in quick succession
    sm.emit('push_detected', { sessionId: 'coding-session-id' });
    sm.emit('push_detected', { sessionId: 'coding-session-id' });

    await reviewStarted;
    // Only one reReviewPR should have been called
    expect(vi.mocked(rs.reReviewPR)).toHaveBeenCalledTimes(1);

    completeReview();
    await new Promise((r) => setTimeout(r, 20));
  });
});

// ── Iteration cap escalation ──────────────────────────────────────────────────

describe('ReviewOrchestrator — iteration cap escalation', () => {
  it('emits review_escalated and skips review when iteration cap is hit', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({ ...basePRRow, review_iteration: 3 } as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();

    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), makeMockNotionClient(), 1, true);

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(rs.reviewPR)).not.toHaveBeenCalled();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'review_escalated',
      prNumber: 1,
      repo: 'owner/repo',
    });
  });

  it('does not escalate when iteration is below cap', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({ ...basePRRow, review_iteration: 2 } as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();

    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), makeMockNotionClient(), 1, true);

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(rs.reviewPR)).toHaveBeenCalledOnce();
    expect(messages.find((m: any) => m.type === 'review_escalated')).toBeUndefined();
  });
});

// ── Incomplete verdict handling ───────────────────────────────────────────────

describe('ReviewOrchestrator — incomplete verdict', () => {
  it('broadcasts review_incomplete and does NOT call sendFeedbackToCodingSession when verdict is incomplete', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService({
      prNumber: 1,
      repo: 'owner/repo',
      verdict: 'incomplete',
      dimensions: [],
      summary: 'Could not assess the PR.',
      reviewedAt: new Date().toISOString(),
    });

    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), 1, true);

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    // Must NOT send feedback to coding session
    expect(vi.mocked(sm.send)).not.toHaveBeenCalled();

    // Must broadcast review_incomplete
    const incompleteMsg = messages.find((m: any) => m.type === 'review_incomplete');
    expect(incompleteMsg).toBeDefined();
    expect(incompleteMsg).toMatchObject({
      type: 'review_incomplete',
      prNumber: 1,
      repo: 'owner/repo',
    });
  });

  it('broadcasts review_incomplete on re-review incomplete verdict and does NOT send feedback', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue(basePRRow as any);

    const sm = makeMockSessionManager();
    const rs = {
      reviewPR: vi.fn(),
      sendReReview: vi.fn(),
      reReviewPR: vi.fn().mockResolvedValue({
        prNumber: 1,
        repo: 'owner/repo',
        verdict: 'incomplete',
        dimensions: [],
        summary: 'Reviewer could not assess.',
        reviewedAt: new Date().toISOString(),
      }),
    } as unknown as PRReviewService;

    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), 1, true);

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    sm.emit('push_detected', { sessionId: 'coding-session-id' });
    await new Promise((r) => setTimeout(r, 30));

    // Must NOT send feedback to coding session
    expect(vi.mocked(sm.send)).not.toHaveBeenCalled();

    // Must broadcast review_incomplete
    const incompleteMsg = messages.find((m: any) => m.type === 'review_incomplete');
    expect(incompleteMsg).toBeDefined();
    expect(incompleteMsg).toMatchObject({
      type: 'review_incomplete',
      prNumber: 1,
      repo: 'owner/repo',
    });
  });
});

// ── Timeout handling ──────────────────────────────────────────────────────────

describe('ReviewOrchestrator — timeout', () => {
  it('stores error verdict and broadcasts error event on timeout', async () => {
    vi.useFakeTimers();

    const sm = makeMockSessionManager();
    // reviewPR never resolves — simulates a hung review
    const rs = {
      reviewPR: vi.fn().mockReturnValue(new Promise(() => {})),
      sendReReview: vi.fn(),
    } as unknown as PRReviewService;

    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), makeMockNotionClient(), 1, true);

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    sm.emit('pr_opened', baseJob);

    // Advance past the 120s timeout
    await vi.advanceTimersByTimeAsync(121_000);

    expect(vi.mocked(setPRReviewResult)).toHaveBeenCalledOnce();
    const [prNum, repo, resultJson] = vi.mocked(setPRReviewResult).mock.calls[0];
    expect(prNum).toBe(1);
    expect(repo).toBe('owner/repo');
    const stored = JSON.parse(resultJson as string) as { verdict: string; summary: string; dimensions: unknown };
    expect(stored.verdict).toBe('error');
    expect(stored.summary).toContain('timed out');
    expect(Array.isArray(stored.dimensions)).toBe(true);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'pr_review_complete',
      verdict: 'error',
    });

    vi.useRealTimers();
  });

  it('stores error verdict with dimensions: [] when executeReview catches a non-timeout error', async () => {
    const sm = makeMockSessionManager();
    const rs = {
      reviewPR: vi.fn().mockRejectedValue(new Error('GitHub API unreachable')),
      sendReReview: vi.fn(),
    } as unknown as PRReviewService;

    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), makeMockNotionClient(), 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(setPRReviewResult)).toHaveBeenCalledOnce();
    const [, , resultJson] = vi.mocked(setPRReviewResult).mock.calls[0];
    const stored = JSON.parse(resultJson as string) as { verdict: string; dimensions: unknown };
    expect(stored.verdict).toBe('error');
    expect(Array.isArray(stored.dimensions)).toBe(true);
  });

  it('stores error verdict with dimensions: [] when re-review times out', async () => {
    vi.useFakeTimers();
    vi.mocked(getPRBySessionId).mockReturnValue(basePRRow as any);

    const sm = makeMockSessionManager();
    const rs = {
      reviewPR: vi.fn(),
      sendReReview: vi.fn(),
      reReviewPR: vi.fn().mockReturnValue(new Promise(() => {})),
    } as unknown as PRReviewService;

    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), makeMockNotionClient(), 1, true);

    sm.emit('push_detected', { sessionId: 'coding-session-id' });

    await vi.advanceTimersByTimeAsync(121_000);

    expect(vi.mocked(setPRReviewResult)).toHaveBeenCalledOnce();
    const [, , resultJson] = vi.mocked(setPRReviewResult).mock.calls[0];
    const stored = JSON.parse(resultJson as string) as { verdict: string; dimensions: unknown };
    expect(stored.verdict).toBe('error');
    expect(Array.isArray(stored.dimensions)).toBe(true);

    vi.useRealTimers();
  });
});

// ── Merge conflict dimension routing ─────────────────────────────────────────

describe('ReviewOrchestrator — merge conflict causes needs_changes', () => {
  it('routes feedback to coding session when all AI dims pass but conflict dim fails', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService({
      prNumber: 1,
      repo: 'owner/repo',
      verdict: 'needs_changes',
      dimensions: [
        { name: 'Title and description vs task Summary', passed: true, notes: 'ok' },
        { name: 'Diff vs Context spec', passed: true, notes: 'ok' },
        { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'ok' },
        { name: 'Changed files vs Files/paths affected list', passed: true, notes: 'ok' },
        { name: 'Merge conflicts', passed: false, notes: 'PR has merge conflicts with base branch. Rebase and resolve before re-review.' },
      ],
      summary: 'Merge conflicts detected.',
      reviewedAt: new Date().toISOString(),
    });

    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(sm.send)).toHaveBeenCalledOnce();
    const [sessionId, message] = vi.mocked(sm.send).mock.calls[0];
    expect(sessionId).toBe('coding-session-id');
    expect(message).toContain('Merge conflicts');
  });
});

// ── Draft PR transition ───────────────────────────────────────────────────────
// Draft transition (markPRReady) is now handled inside PRReviewService.handleApprovedVerdict()
// which is called from reviewPR(). The orchestrator derives the draftTransitioned flag from
// the pre-review prRow to include draft: false in the broadcast when applicable.

describe('ReviewOrchestrator — draft PR transition on approved verdict', () => {
  it('broadcasts draft: false when approved verdict on a draft PR (transition delegated to PRReviewService)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({ ...basePRRow, draft: 1 } as any);

    const sm = makeMockSessionManager();
    const gc = makeMockGitHubClient();
    const rs = makeMockReviewService({
      prNumber: 1,
      repo: 'owner/repo',
      verdict: 'approved',
      dimensions: [],
      summary: 'All good.',
      reviewedAt: new Date().toISOString(),
    });

    new ReviewOrchestrator(rs, sm as any, gc, makeMockNotionClient(), 1, true);

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    // markPRReady is no longer called by the orchestrator — it is handled by
    // PRReviewService.handleApprovedVerdict() inside reviewPR(). The orchestrator
    // reads the pre-review draft status and includes draft: false in the broadcast.
    expect(vi.mocked(gc.markPRReady)).not.toHaveBeenCalled();
    expect(messages[0]).toMatchObject({
      type: 'pr_review_complete',
      verdict: 'approved',
      draft: false,
    });
  });

  it('does not include draft: false in broadcast when approved verdict on a non-draft PR', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({ ...basePRRow, draft: 0 } as any);

    const sm = makeMockSessionManager();
    const gc = makeMockGitHubClient();
    const rs = makeMockReviewService({
      prNumber: 1,
      repo: 'owner/repo',
      verdict: 'approved',
      dimensions: [],
      summary: 'All good.',
      reviewedAt: new Date().toISOString(),
    });

    new ReviewOrchestrator(rs, sm as any, gc, makeMockNotionClient(), 1, true);

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(gc.markPRReady)).not.toHaveBeenCalled();
    expect(vi.mocked(updatePRDraftStatus)).not.toHaveBeenCalled();
    // Non-draft: draft: false should not be in the broadcast
    expect((messages[0] as any).draft).toBeUndefined();
  });
});

// ── AC: Break 4 — auto findings routing on needs_changes ─────────────────────
// Required by task: Wire ReviewOrchestrator into server event flow
// Verifies that after a review with needs_changes, the orchestrator routes
// formatted findings to the originating coding session via sessionManager.send().

describe('Break 4 (AC) — auto findings routing: sessionManager.send() called on needs_changes', () => {
  it('calls sessionManager.send() with formatted findings when verdict is needs_changes', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService({
      prNumber: 1,
      repo: 'owner/repo',
      verdict: 'needs_changes',
      dimensions: [{ name: 'Diff vs Acceptance Criteria', passed: false, notes: 'Unit tests missing.' }],
      summary: 'Please add tests.',
      reviewedAt: new Date().toISOString(),
    });

    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), makeMockNotionClient(), 1, true);
    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(sm.send)).toHaveBeenCalledOnce();
    const [sessionId, message] = vi.mocked(sm.send).mock.calls[0];
    expect(sessionId).toBe('coding-session-id');
    expect(message).toContain('Review Feedback');
    expect(message).toContain('Unit tests missing.');
    expect(message).toContain('Please add tests.');
  });
});

// ── AC: Break 5 — re-review trigger on push ──────────────────────────────────
// Required by task: Wire ReviewOrchestrator into server event flow
// Verifies that push_detected increments review_iteration and sends re-review,
// and that the orchestrator escalates when the cap is exceeded.

describe('Break 5 (AC) — re-review trigger: re-review called on push_detected', () => {
  it('calls reReviewPR on push_detected', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue(basePRRow as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), makeMockNotionClient(), 1, true);

    sm.emit('push_detected', { sessionId: 'coding-session-id' });
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(rs.reReviewPR)).toHaveBeenCalledWith(1, 'owner/repo');
  });

  it('emits review_escalated when review_iteration exceeds max_review_iterations', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({ ...basePRRow, review_iteration: 3 } as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), makeMockNotionClient(), 1, true);

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(rs.reviewPR)).not.toHaveBeenCalled();
    const escalated = messages.find((m: any) => m.type === 'review_escalated');
    expect(escalated).toBeDefined();
    expect(escalated).toMatchObject({ type: 'review_escalated', prNumber: 1, repo: 'owner/repo' });
  });
});

// ── Notion status update on approved verdict ──────────────────────────────────
// Notion updateStatus is now delegated to PRReviewService.handleApprovedVerdict().
// The orchestrator no longer calls notionClient directly — see PRReviewService.test.ts.

describe('ReviewOrchestrator — Notion status update on approved verdict', () => {
  it('does NOT call notionClient.updateStatus directly when verdict is approved (delegated to PRReviewService)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({ ...basePRRow, draft: 0 } as any);

    const sm = makeMockSessionManager();
    const nc = makeMockNotionClient();
    const rs = makeMockReviewService({
      prNumber: 1,
      repo: 'owner/repo',
      verdict: 'approved',
      dimensions: [],
      summary: 'All good.',
      reviewedAt: new Date().toISOString(),
    });

    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), nc, 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    // The orchestrator no longer calls notionClient.updateStatus — this is now
    // handled inside PRReviewService.handleApprovedVerdict() called from reviewPR().
    expect(vi.mocked(nc.updateStatus)).not.toHaveBeenCalled();
  });

  it('does NOT call notionClient.updateStatus when verdict is not approved', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({ ...basePRRow, draft: 0 } as any);

    const sm = makeMockSessionManager();
    const nc = makeMockNotionClient();
    const rs = makeMockReviewService({
      prNumber: 1,
      repo: 'owner/repo',
      verdict: 'needs_changes',
      dimensions: [],
      summary: 'Please fix.',
      reviewedAt: new Date().toISOString(),
    });

    new ReviewOrchestrator(rs, sm as any, makeMockGitHubClient(), nc, 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(nc.updateStatus)).not.toHaveBeenCalled();
  });
});
