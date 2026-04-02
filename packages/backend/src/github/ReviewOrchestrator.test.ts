import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks (must come before imports of the modules under test) ──────────────

vi.mock('../db/queries.js', () => ({
  setPRReviewResult: vi.fn(),
  getPRByNumber: vi.fn(),
  getPRBySessionId: vi.fn(),
  getSetting: vi.fn().mockReturnValue(undefined),
  incrementReviewIteration: vi.fn(),
}));

vi.mock('../config.js', () => ({
  config: {
    projects: [
      { id: 'proj-1', name: 'Project 1', githubRepo: 'owner/repo', projectDir: '/tmp', contextUrl: 'https://notion.so/ctx', boardId: 'board-1' },
    ],
  },
}));

import { ReviewOrchestrator } from './ReviewOrchestrator';
import { setPRReviewResult, getPRByNumber, getPRBySessionId, incrementReviewIteration } from '../db/queries';
import type { PRReviewService } from './PRReviewService';
import type { ReviewJob } from './types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockSessionManager() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    send: vi.fn(),
  });
}

function makeMockReviewService(resolveWith?: object): PRReviewService {
  return {
    reviewPR: vi.fn().mockResolvedValue(
      resolveWith ?? {
        prNumber: 1,
        repo: 'owner/repo',
        verdict: 'approved',
        dimensions: [],
        summary: 'All good.',
        reviewedAt: new Date().toISOString(),
      },
    ),
    sendReReview: vi.fn().mockResolvedValue({
      prNumber: 1,
      repo: 'owner/repo',
      verdict: 'approved',
      dimensions: [],
      summary: 'Fixed.',
      reviewedAt: new Date().toISOString(),
    }),
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
  head_sha: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Disabled orchestrator ─────────────────────────────────────────────────────

describe('ReviewOrchestrator — disabled', () => {
  it('does not enqueue when enabled === false', async () => {
    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, false);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 20));

    expect(vi.mocked(rs.reviewPR)).not.toHaveBeenCalled();
  });

  it('does not respond to push_detected when disabled', async () => {
    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, false);

    sm.emit('push_detected', { sessionId: 'coding-session-id' });
    await new Promise((r) => setTimeout(r, 20));

    expect(vi.mocked(rs.sendReReview)).not.toHaveBeenCalled();
  });
});

// ── Missing taskId ────────────────────────────────────────────────────────────

describe('ReviewOrchestrator — missing taskId', () => {
  it('does not enqueue when job.taskId is empty', async () => {
    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, true);

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
    } as unknown as PRReviewService;

    new ReviewOrchestrator(rs, sm as any, 1, true);

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

    new ReviewOrchestrator(rs, sm as any, 1, true);

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

    new ReviewOrchestrator(rs, sm as any, 1, true);

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

    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(sm.send)).not.toHaveBeenCalled();
  });
});

// ── Push detection and re-review ──────────────────────────────────────────────

describe('ReviewOrchestrator — push_detected triggers re-review', () => {
  it('calls sendReReview and increments iteration on push_detected', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue(basePRRow as any);
    vi.mocked(incrementReviewIteration).mockReturnValue(1);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();

    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('push_detected', { sessionId: 'coding-session-id' });
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(incrementReviewIteration)).toHaveBeenCalledWith(1, 'owner/repo');
    expect(vi.mocked(rs.sendReReview)).toHaveBeenCalledWith(
      'review-session-id', 1, 'owner/repo', 1, 3,
    );
  });

  it('emits review_verdict after re-review completes', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue(basePRRow as any);
    vi.mocked(incrementReviewIteration).mockReturnValue(1);

    const sm = makeMockSessionManager();
    const rs = {
      reviewPR: vi.fn(),
      sendReReview: vi.fn().mockResolvedValue({
        prNumber: 1,
        repo: 'owner/repo',
        verdict: 'approved',
        dimensions: [],
        summary: 'Fixed.',
        reviewedAt: new Date().toISOString(),
      }),
    } as unknown as PRReviewService;

    new ReviewOrchestrator(rs, sm as any, 1, true);

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
    vi.mocked(getPRBySessionId).mockReturnValue(basePRRow as any);
    vi.mocked(incrementReviewIteration).mockReturnValue(2);

    const sm = makeMockSessionManager();
    const rs = {
      reviewPR: vi.fn(),
      sendReReview: vi.fn().mockResolvedValue({
        prNumber: 1,
        repo: 'owner/repo',
        verdict: 'needs_changes',
        dimensions: [{ name: 'Diff vs Context spec', passed: false, notes: 'Still missing.' }],
        summary: 'Still failing.',
        reviewedAt: new Date().toISOString(),
      }),
    } as unknown as PRReviewService;

    new ReviewOrchestrator(rs, sm as any, 1, true);

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

    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('push_detected', { sessionId: 'coding-session-id' });
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(rs.sendReReview)).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent push_detected for the same coding session', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue(basePRRow as any);
    vi.mocked(incrementReviewIteration).mockReturnValue(1);

    let resolveReview!: () => void;
    const reviewStarted = new Promise<void>((r) => { resolveReview = r; });
    let completeReview!: () => void;
    const reviewDone = new Promise<void>((r) => { completeReview = r; });

    const rs = {
      reviewPR: vi.fn(),
      sendReReview: vi.fn().mockImplementationOnce(async () => {
        resolveReview();
        await reviewDone;
        return { prNumber: 1, repo: 'owner/repo', verdict: 'approved', dimensions: [], summary: 'ok', reviewedAt: '' };
      }),
    } as unknown as PRReviewService;

    const sm = makeMockSessionManager();
    new ReviewOrchestrator(rs, sm as any, 1, true);

    // Fire two push_detected in quick succession
    sm.emit('push_detected', { sessionId: 'coding-session-id' });
    sm.emit('push_detected', { sessionId: 'coding-session-id' });

    await reviewStarted;
    // Only one sendReReview should have been called
    expect(vi.mocked(rs.sendReReview)).toHaveBeenCalledTimes(1);

    completeReview();
    await new Promise((r) => setTimeout(r, 20));
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

    new ReviewOrchestrator(rs, sm as any, 1, true);

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    sm.emit('pr_opened', baseJob);

    // Advance past the 120s timeout
    await vi.advanceTimersByTimeAsync(121_000);

    expect(vi.mocked(setPRReviewResult)).toHaveBeenCalledOnce();
    const [prNum, repo, resultJson] = vi.mocked(setPRReviewResult).mock.calls[0];
    expect(prNum).toBe(1);
    expect(repo).toBe('owner/repo');
    const stored = JSON.parse(resultJson as string) as { verdict: string; summary: string };
    expect(stored.verdict).toBe('error');
    expect(stored.summary).toContain('timed out');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'pr_review_complete',
      verdict: 'error',
    });

    vi.useRealTimers();
  });
});
