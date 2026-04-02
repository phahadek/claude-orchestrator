import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks (must come before imports of the modules under test) ──────────────

vi.mock('../db/queries.js', () => ({
  setPRReviewResult: vi.fn(),
}));

vi.mock('../config.js', () => ({
  config: {
    projects: [
      { id: 'proj-1', name: 'Project 1', githubRepo: 'owner/repo', projectDir: '/tmp', contextUrl: 'https://notion.so/ctx', boardId: 'board-1' },
    ],
  },
}));

import { ReviewOrchestrator } from './ReviewOrchestrator';
import { setPRReviewResult } from '../db/queries';
import type { PRReviewService } from './PRReviewService';
import type { ReviewJob } from './types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockSessionManager() {
  return new EventEmitter();
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
  } as unknown as PRReviewService;
}

const baseJob: ReviewJob = {
  prNumber: 1,
  repo: 'owner/repo',
  taskId: 'task-abc',
  taskUrl: 'https://notion.so/task',
  contextUrl: 'https://notion.so/ctx',
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

// ── pr_opened emitted in handleCleanExit ──────────────────────────────────────

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

// ── Timeout handling ──────────────────────────────────────────────────────────

describe('ReviewOrchestrator — timeout', () => {
  it('stores error verdict and broadcasts error event on timeout', async () => {
    vi.useFakeTimers();

    const sm = makeMockSessionManager();
    // reviewPR never resolves — simulates a hung review
    const rs = {
      reviewPR: vi.fn().mockReturnValue(new Promise(() => {})),
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
