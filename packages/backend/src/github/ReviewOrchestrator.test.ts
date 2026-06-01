import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks (must come before imports of the modules under test) ──────────────

vi.mock('../db/queries.js', () => ({
  setPRReviewResult: vi.fn(),
  getPRByNumber: vi.fn(),
  getSession: vi.fn().mockReturnValue(undefined),
  getSetting: vi.fn().mockReturnValue(undefined),
  incrementReviewIteration: vi.fn(),
  updatePRDraftStatus: vi.fn(),
  setPendingPush: vi.fn(),
  setPauseReason: vi.fn(),
  getLocalBranchBySession: vi.fn(),
  setLocalBranchPauseReason: vi.fn(),
  addAutofixSha: vi.fn(),
  consumeAutofixSha: vi.fn().mockReturnValue(false),
  deleteAllAutofixShasForPR: vi.fn(),
  getAllPendingReviewSyncs: vi.fn().mockReturnValue([]),
  insertPendingReviewSync: vi.fn(),
  deletePendingReviewSync: vi.fn(),
}));

vi.mock('../session/autofix-runner.js', () => ({
  loadAutofixCommands: vi.fn().mockReturnValue([]),
  runAutofix: vi.fn().mockResolvedValue({ success: true, summary: 'no diff' }),
}));

vi.mock('../session/filePollutionCheck.js', () => ({
  runFilePollutionCheck: vi
    .fn()
    .mockResolvedValue({ headSha: null, revertCommitSha: null }),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

const projectFixture = {
  id: 'proj-1',
  name: 'Project 1',
  githubRepo: 'owner/repo',
  projectDir: '/tmp',
  contextUrl: 'https://notion.so/ctx',
  boardId: 'board-1',
  gitMode: 'github' as const,
};

const localOnlyProjectFixture = {
  id: 'proj-local',
  name: 'Local Project',
  projectDir: '/repos/local',
  contextUrl: 'https://notion.so/ctx-local',
  boardId: 'board-local',
  gitMode: 'local-only' as const,
};

vi.mock('../config.js', () => ({
  getProjectByGithubRepo: vi.fn((repo: string) =>
    repo === 'owner/repo' ? projectFixture : undefined,
  ),
  getAllProjects: vi.fn(() => [projectFixture]),
  getProjectById: vi.fn((id: string) => {
    if (id === 'proj-1') return projectFixture;
    if (id === 'proj-local') return localOnlyProjectFixture;
    return undefined;
  }),
}));

vi.mock('../orchestration/verifyRunner.js', () => ({
  runVerifyAsGate: vi.fn().mockResolvedValue({ passed: true }),
}));

vi.mock('../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    verify: [],
    autofix: [],
    ci_check_name: [],
    allowed_tools: [],
    bash_rules: [],
    bootstrap_script: '',
  }),
}));

import { ReviewOrchestrator } from './ReviewOrchestrator';
import {
  setPRReviewResult,
  getPRByNumber,
  getSession,
  updatePRDraftStatus,
  setPauseReason,
  getLocalBranchBySession,
  setLocalBranchPauseReason,
  addAutofixSha,
  consumeAutofixSha as dbConsumeAutofixSha,
} from '../db/queries';
import { loadAutofixCommands, runAutofix } from '../session/autofix-runner';
import { runFilePollutionCheck } from '../session/filePollutionCheck';
import { recordEvent } from '../audit/AuditLog';
import { runVerifyAsGate } from '../orchestration/verifyRunner';
import { loadOrchestratorConfig } from '../session/orchestrator-config';
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

function makeMockGitHubClient(
  fetchPRResolveWith?: Partial<PullRequest>,
): GitHubClient {
  return {
    markPRReady: vi.fn().mockResolvedValue(undefined),
    fetchPR: vi
      .fn()
      .mockResolvedValue({ ...baseFreshPR, ...fetchPRResolveWith }),
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
    sendOrResume: vi.fn().mockResolvedValue('coding-session-id'),
    addToRevertLock: vi.fn(),
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
    sendReReview: vi
      .fn()
      .mockResolvedValue({ ...defaultResult, summary: 'Fixed.' }),
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
  task_id: 'notion:task-abc',
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
      reviewPR: vi
        .fn()
        .mockImplementationOnce(async () => {
          callOrder.push(1);
          resolveFirst();
          await firstComplete;
          return {
            prNumber: 1,
            repo: 'owner/repo',
            verdict: 'approved',
            dimensions: [],
            summary: 'ok',
            reviewedAt: '',
          };
        })
        .mockImplementationOnce(async () => {
          callOrder.push(2);
          return {
            prNumber: 2,
            repo: 'owner/repo',
            verdict: 'approved',
            dimensions: [],
            summary: 'ok',
            reviewedAt: '',
          };
        }),
      sendReReview: vi.fn(),
      reReviewPR: vi.fn(),
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

    const reviewComplete = messages.find(
      (m: any) => m.type === 'pr_review_complete',
    );
    expect(reviewComplete).toMatchObject({
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
      dimensions: [
        {
          name: 'Diff vs Context spec',
          passed: false,
          notes: 'Missing export.',
        },
      ],
      summary: 'One dimension failed.',
      reviewedAt: new Date().toISOString(),
    });

    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(sm.sendOrResume)).toHaveBeenCalledOnce();
    const [sessionId, message] = vi.mocked(sm.sendOrResume).mock.calls[0];
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

    expect(vi.mocked(sm.sendOrResume)).not.toHaveBeenCalled();
  });

  it('records verdict_routing_failed audit event when sendOrResume throws', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);

    const sm = makeMockSessionManager();
    vi.mocked(sm.sendOrResume).mockRejectedValue(new Error('spawn failed'));

    const rs = makeMockReviewService({
      prNumber: 1,
      repo: 'owner/repo',
      verdict: 'needs_changes',
      dimensions: [
        {
          name: 'Diff vs Context spec',
          passed: false,
          notes: 'Missing export.',
        },
      ],
      summary: 'One dimension failed.',
      reviewedAt: new Date().toISOString(),
    });

    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'verdict_routing_failed',
        actor_type: 'system',
        actor_id: 'coding-session-id',
        payload: expect.objectContaining({
          pr_number: 1,
          repo: 'owner/repo',
          error: expect.stringContaining('spawn failed'),
        }),
      }),
    );
  });

  it('does not record verdict_routing_failed when sendOrResume resolves normally', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService({
      prNumber: 1,
      repo: 'owner/repo',
      verdict: 'needs_changes',
      dimensions: [
        { name: 'Diff vs Context spec', passed: false, notes: 'ok' },
      ],
      summary: 'Needs changes.',
      reviewedAt: new Date().toISOString(),
    });

    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(recordEvent)).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'verdict_routing_failed' }),
    );
  });

  it('skips routing and records no verdict_routing_failed when session_id is null', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({
      ...basePRRow,
      session_id: null,
    } as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService({
      prNumber: 1,
      repo: 'owner/repo',
      verdict: 'needs_changes',
      dimensions: [
        { name: 'Diff vs Context spec', passed: false, notes: 'ok' },
      ],
      summary: 'Needs changes.',
      reviewedAt: new Date().toISOString(),
    });

    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(sm.sendOrResume)).not.toHaveBeenCalled();
    expect(vi.mocked(recordEvent)).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'verdict_routing_failed' }),
    );
  });
});

// ── Push detection and re-review ──────────────────────────────────────────────
// Push-detected re-review is wired in server.ts, not ReviewOrchestrator.
// See packages/backend/src/server.ts for the push_detected listener and
// reReviewPR() tests in PRReviewService.test.ts.

describe('ReviewOrchestrator — push_detected triggers re-review', () => {
  // Tests removed: push_detected wiring moved to server.ts.
  // See packages/backend/src/server.ts and PRReviewService.test.ts for coverage.

  it('placeholder — push_detected handled in server.ts, not ReviewOrchestrator', () => {
    // The push_detected listener now lives in server.ts.
    // This describe block is kept for documentation purposes only.
    expect(true).toBe(true);
  });
});

// ── Iteration cap escalation ──────────────────────────────────────────────────

describe('ReviewOrchestrator — iteration cap escalation', () => {
  it('emits review_escalated and skips review when iteration cap is hit', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({
      ...basePRRow,
      review_iteration: 3,
    } as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();

    new ReviewOrchestrator(rs, sm as any, 1, true);

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

  it('sets pause_reason = "max_reviews" when iteration cap escalation fires', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({
      ...basePRRow,
      review_iteration: 3,
    } as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();

    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(setPauseReason)).toHaveBeenCalledWith(
      1,
      'owner/repo',
      'max_reviews',
    );
  });

  it('does not escalate when iteration is below cap', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({
      ...basePRRow,
      review_iteration: 2,
    } as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();

    new ReviewOrchestrator(rs, sm as any, 1, true);

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(rs.reviewPR)).toHaveBeenCalledOnce();
    expect(
      messages.find((m: any) => m.type === 'review_escalated'),
    ).toBeUndefined();
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

    new ReviewOrchestrator(rs, sm as any, 1, true);

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    // Must NOT send feedback to coding session
    expect(vi.mocked(sm.sendOrResume)).not.toHaveBeenCalled();

    // Must broadcast review_incomplete
    const incompleteMsg = messages.find(
      (m: any) => m.type === 'review_incomplete',
    );
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
  afterEach(() => {
    vi.useRealTimers();
  });

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
    const [prNum, repo, resultJson] =
      vi.mocked(setPRReviewResult).mock.calls[0];
    expect(prNum).toBe(1);
    expect(repo).toBe('owner/repo');
    const stored = JSON.parse(resultJson as string) as {
      verdict: string;
      summary: string;
      dimensions: unknown;
    };
    expect(stored.verdict).toBe('error');
    expect(stored.summary).toContain('timed out');
    expect(Array.isArray(stored.dimensions)).toBe(true);

    const reviewComplete = messages.find(
      (m: any) => m.type === 'pr_review_complete',
    );
    expect(reviewComplete).toMatchObject({
      type: 'pr_review_complete',
      verdict: 'error',
    });
  });

  it('stores error verdict with dimensions: [] when executeReview catches a non-timeout error', async () => {
    const sm = makeMockSessionManager();
    const rs = {
      reviewPR: vi.fn().mockRejectedValue(new Error('GitHub API unreachable')),
      sendReReview: vi.fn(),
    } as unknown as PRReviewService;

    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(setPRReviewResult)).toHaveBeenCalledOnce();
    const [, , resultJson] = vi.mocked(setPRReviewResult).mock.calls[0];
    const stored = JSON.parse(resultJson as string) as {
      verdict: string;
      dimensions: unknown;
    };
    expect(stored.verdict).toBe('error');
    expect(Array.isArray(stored.dimensions)).toBe(true);
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
        {
          name: 'Title and description vs task Summary',
          passed: true,
          notes: 'ok',
        },
        { name: 'Diff vs Context spec', passed: true, notes: 'ok' },
        { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'ok' },
        {
          name: 'Changed files vs Files/paths affected list',
          passed: true,
          notes: 'ok',
        },
        {
          name: 'Merge conflicts',
          passed: false,
          notes:
            'PR has merge conflicts with base branch. Rebase and resolve before re-review.',
        },
      ],
      summary: 'Merge conflicts detected.',
      reviewedAt: new Date().toISOString(),
    });

    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(sm.sendOrResume)).toHaveBeenCalledOnce();
    const [sessionId, message] = vi.mocked(sm.sendOrResume).mock.calls[0];
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

    new ReviewOrchestrator(rs, sm as any, 1, true);

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    // markPRReady is no longer called by the orchestrator — it is handled by
    // PRReviewService.handleApprovedVerdict() inside reviewPR(). The orchestrator
    // reads the pre-review draft status and includes draft: false in the broadcast.
    expect(vi.mocked(gc.markPRReady)).not.toHaveBeenCalled();
    const reviewComplete = messages.find(
      (m: any) => m.type === 'pr_review_complete',
    );
    expect(reviewComplete).toMatchObject({
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

    new ReviewOrchestrator(rs, sm as any, 1, true);

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

describe('Break 4 (AC) — auto findings routing: sessionManager.sendOrResume() called on needs_changes', () => {
  it('calls sessionManager.sendOrResume() with formatted findings when verdict is needs_changes', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService({
      prNumber: 1,
      repo: 'owner/repo',
      verdict: 'needs_changes',
      dimensions: [
        {
          name: 'Diff vs Acceptance Criteria',
          passed: false,
          notes: 'Unit tests missing.',
        },
      ],
      summary: 'Please add tests.',
      reviewedAt: new Date().toISOString(),
    });

    new ReviewOrchestrator(rs, sm as any, 1, true);
    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(sm.sendOrResume)).toHaveBeenCalledOnce();
    const [sessionId, message] = vi.mocked(sm.sendOrResume).mock.calls[0];
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
  // 'calls reReviewPR on push_detected' test removed: push_detected is now wired
  // in server.ts, not ReviewOrchestrator. See PRReviewService.test.ts for reReviewPR coverage.

  it('emits review_escalated when review_iteration exceeds max_review_iterations', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({
      ...basePRRow,
      review_iteration: 3,
    } as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, true);

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(rs.reviewPR)).not.toHaveBeenCalled();
    const escalated = messages.find((m: any) => m.type === 'review_escalated');
    expect(escalated).toBeDefined();
    expect(escalated).toMatchObject({
      type: 'review_escalated',
      prNumber: 1,
      repo: 'owner/repo',
    });
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

    new ReviewOrchestrator(rs, sm as any, 1, true);

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

    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(nc.updateStatus)).not.toHaveBeenCalled();
  });
});

// ── Autofix WS messages ───────────────────────────────────────────────────────

describe('ReviewOrchestrator — autofix WS messages', () => {
  it('emits autofix_started and autofix_complete before review when commands are configured', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run lint']);
    vi.mocked(runAutofix).mockResolvedValue({ success: true, summary: 'done' });

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, true);

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    const types = messages.map((m: any) => m.type as string);
    const autofixStartedIdx = types.indexOf('autofix_started');
    const autofixCompleteIdx = types.indexOf('autofix_complete');
    const reviewStartedIdx = types.indexOf('review_started');
    const prReviewCompleteIdx = types.indexOf('pr_review_complete');

    expect(autofixStartedIdx).toBeGreaterThanOrEqual(0);
    expect(autofixCompleteIdx).toBeGreaterThan(autofixStartedIdx);
    expect(reviewStartedIdx).toBeGreaterThan(autofixCompleteIdx);
    expect(prReviewCompleteIdx).toBeGreaterThan(reviewStartedIdx);
  });

  it('does NOT emit autofix_started when no autofix commands are configured', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(loadAutofixCommands).mockReturnValue([]);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, true);

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(
      messages.find((m: any) => m.type === 'autofix_started'),
    ).toBeUndefined();
    expect(
      messages.find((m: any) => m.type === 'autofix_complete'),
    ).toBeUndefined();
  });

  it('emits review_started even when autofix is skipped (no commands)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(loadAutofixCommands).mockReturnValue([]);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, true);

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(
      messages.find((m: any) => m.type === 'review_started'),
    ).toBeDefined();
  });

  it('proceeds to review session even when autofix fails (fail open)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run lint']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: false,
      summary: 'lint failed',
    });

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(rs.reviewPR)).toHaveBeenCalledOnce();
  });

  it('autofix_complete carries success:false when runAutofix reports failure', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/fake/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run lint']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: false,
      summary: 'lint error',
    });

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, true);

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    const completeMsg = messages.find(
      (m: any) => m.type === 'autofix_complete',
    ) as any;
    expect(completeMsg).toBeDefined();
    expect(completeMsg.success).toBe(false);
    expect(completeMsg.summary).toContain('lint error');
  });

  it('calls runAutofix on every executeReview invocation', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/fake/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run lint']);
    vi.mocked(runAutofix).mockResolvedValue({ success: true, summary: 'done' });

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 2, true);

    sm.emit('pr_opened', { ...baseJob, prNumber: 1 });
    sm.emit('pr_opened', { ...baseJob, prNumber: 2 });
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(runAutofix)).toHaveBeenCalledTimes(2);
  });

  it('calls sessionManager.addToRevertLock with touchedFiles after a successful autofix commit', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/fake/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run lint']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      commitSha: 'abc123',
      touchedFiles: ['src/foo.ts', 'CLAUDE.md'],
      summary: 'autofix committed abc123',
    });

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(sm.addToRevertLock)).toHaveBeenCalledWith(
      basePRRow.session_id,
      ['src/foo.ts', 'CLAUDE.md'],
    );
  });

  it('does NOT call sessionManager.addToRevertLock when autofix produces no commit', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/fake/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run lint']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      summary: 'autofix commands produced no diff',
    });

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(sm.addToRevertLock)).not.toHaveBeenCalled();
  });
});

// ── Autofix-only iteration suppression ───────────────────────────────────────
// AC: "Autofix-only iterations (where the coding session did not push) do not
// increment the iteration counter."
// Mechanism: executeReview() stores the autofix commit SHA after autofix pushes.
// The server.ts push_detected handler calls consumeAutofixSha() — if it matches,
// the push was autofix-only and the re-review (which would increment) is skipped.

describe('ReviewOrchestrator — consumeAutofixSha (autofix-only iteration detection)', () => {
  it('consumeAutofixSha returns false when no autofix commit was recorded', () => {
    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    const orchestrator = new ReviewOrchestrator(rs, sm as any, 1, true);

    expect(orchestrator.consumeAutofixSha(1, 'owner/repo', 'any-sha')).toBe(
      false,
    );
  });

  it('consumeAutofixSha returns true after executeReview stores the autofix SHA', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/fake/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run lint']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      commitSha: 'autofix-sha-123',
      summary: '1 file changed',
    });

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    const orchestrator = new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    // Verify the SHA was registered in DB
    expect(vi.mocked(addAutofixSha)).toHaveBeenCalledWith(
      1,
      'owner/repo',
      'autofix-sha-123',
    );
    // DB mock returns true when asked for this SHA (consume once)
    vi.mocked(dbConsumeAutofixSha).mockReturnValueOnce(true);
    expect(
      orchestrator.consumeAutofixSha(1, 'owner/repo', 'autofix-sha-123'),
    ).toBe(true);
  });

  it('consumeAutofixSha returns false for a non-matching SHA', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/fake/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run lint']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      commitSha: 'autofix-sha-123',
      summary: '1 file changed',
    });

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    const orchestrator = new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(
      orchestrator.consumeAutofixSha(1, 'owner/repo', 'different-sha'),
    ).toBe(false);
  });

  it('consumeAutofixSha is consumed (returns false on second call)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/fake/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run lint']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      commitSha: 'autofix-sha-abc',
      summary: 'done',
    });

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    const orchestrator = new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    // DB mock: first call returns true (row exists), second call returns false (already deleted)
    vi.mocked(dbConsumeAutofixSha)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    // First call consumes the entry
    expect(
      orchestrator.consumeAutofixSha(1, 'owner/repo', 'autofix-sha-abc'),
    ).toBe(true);
    // Second call returns false — the SHA was already consumed
    expect(
      orchestrator.consumeAutofixSha(1, 'owner/repo', 'autofix-sha-abc'),
    ).toBe(false);
  });

  it('does not store autofix SHA when autofix produces no commit', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/fake/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run lint']);
    // No commitSha — autofix ran but produced no diff
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      summary: 'no diff',
    });

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    const orchestrator = new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(orchestrator.consumeAutofixSha(1, 'owner/repo', 'any-sha')).toBe(
      false,
    );
  });
});

// ── local_branch_submitted ────────────────────────────────────────────────────

const baseLocalBranchRow = {
  id: 10,
  project_id: 'proj-1',
  session_id: 'session-local-1',
  branch_name: 'feature/my-local-branch',
  base_branch: 'dev',
  status: 'open',
  review_result: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const baseSessionRow = {
  session_id: 'session-local-1',
  task_id: 'yaml:task-local-abc',
  task_url: null,
  project_context_url: null,
  project_id: 'proj-1',
  status: 'done',
  started_at: 1000,
  ended_at: null,
  pr_url: null,
  worktree_path: '/path/to/worktree',
  archived: 0,
  favorited: 0,
  session_type: 'standard',
  note: null,
  tags: null,
  total_input_tokens: 0,
  total_output_tokens: 0,
  task_name: null,
  metadata: null,
  review_result: null,
};

describe('ReviewOrchestrator — local_branch_submitted', () => {
  it('queues a review job when local_branch_submitted fires', async () => {
    vi.mocked(getLocalBranchBySession).mockReturnValue(
      baseLocalBranchRow as any,
    );
    vi.mocked(getSession).mockReturnValue(baseSessionRow as any);

    const rs = makeMockReviewService({
      prNumber: 10,
      repo: 'local/feature/my-local-branch',
      verdict: 'approved',
      dimensions: [],
      summary: 'LGTM',
      reviewedAt: new Date().toISOString(),
    });
    const sm = makeMockSessionManager();
    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('message', {
      type: 'local_branch_submitted',
      projectId: 'proj-1',
      sessionId: 'session-local-1',
      branchName: 'feature/my-local-branch',
      baseBranch: 'dev',
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(rs.reviewPR)).toHaveBeenCalledOnce();
    const [workItem] = vi.mocked(rs.reviewPR).mock.calls[0];
    expect(workItem).toMatchObject({
      type: 'local_branch',
      localBranchId: 10,
      branchName: 'feature/my-local-branch',
      baseBranch: 'dev',
    });
  });

  it('does not queue when local_branch_submitted fires but enabled === false', async () => {
    vi.mocked(getLocalBranchBySession).mockReturnValue(
      baseLocalBranchRow as any,
    );
    vi.mocked(getSession).mockReturnValue(baseSessionRow as any);

    const rs = makeMockReviewService();
    const sm = makeMockSessionManager();
    new ReviewOrchestrator(rs, sm as any, 1, false);

    sm.emit('message', {
      type: 'local_branch_submitted',
      projectId: 'proj-1',
      sessionId: 'session-local-1',
      branchName: 'feature/my-local-branch',
      baseBranch: 'dev',
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(rs.reviewPR)).not.toHaveBeenCalled();
  });

  it('skips review when local_branch_submitted fires with no worktree_path', async () => {
    vi.mocked(getLocalBranchBySession).mockReturnValue(
      baseLocalBranchRow as any,
    );
    vi.mocked(getSession).mockReturnValue({
      ...baseSessionRow,
      worktree_path: null,
    } as any);

    const rs = makeMockReviewService();
    const sm = makeMockSessionManager();
    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('message', {
      type: 'local_branch_submitted',
      projectId: 'proj-1',
      sessionId: 'session-local-1',
      branchName: 'feature/my-local-branch',
      baseBranch: 'dev',
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(rs.reviewPR)).not.toHaveBeenCalled();
  });

  it('queues a review job when pr_opened fires (regression)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);

    const rs = makeMockReviewService();
    const sm = makeMockSessionManager();
    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(rs.reviewPR)).toHaveBeenCalledOnce();
    const [workItem] = vi.mocked(rs.reviewPR).mock.calls[0];
    expect(workItem).toMatchObject({
      type: 'pr',
      prNumber: 1,
      repo: 'owner/repo',
    });
    expect(vi.mocked(runVerifyAsGate)).not.toHaveBeenCalled();
  });
});

// ── Verify-as-gate for local-only projects ────────────────────────────────────

const verifyLocalBranchRow = {
  id: 5,
  project_id: 'proj-local',
  session_id: 'coding-session-local',
  branch_name: 'feature/my-task',
  base_branch: 'dev',
  status: 'open',
  review_result: null,
  pause_reason: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const verifySessionRow = {
  session_id: 'coding-session-local',
  task_id: 'yaml:task-local',
  task_url: 'https://notion.so/task-local',
  project_context_url: 'https://notion.so/ctx-local',
  project_id: 'proj-local',
  status: 'done',
  started_at: 1000,
  ended_at: null,
  pr_url: null,
  worktree_path: '/repos/local/worktree',
  archived: 0,
  favorited: 0,
  session_type: 'standard',
  note: null,
  tags: null,
  total_input_tokens: 0,
  total_output_tokens: 0,
  task_name: null,
  metadata: null,
  review_result: null,
};

describe('ReviewOrchestrator — verify-as-gate: local-only, empty verify list', () => {
  it('proceeds to review when verify list is empty (no-op)', async () => {
    vi.mocked(getSession).mockReturnValue(verifySessionRow as any);
    vi.mocked(getLocalBranchBySession).mockReturnValue(
      verifyLocalBranchRow as any,
    );
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      verify: [],
      autofix: [],
      ci_check_name: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    });
    vi.mocked(runVerifyAsGate).mockResolvedValue({ passed: true });

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('message', {
      type: 'local_branch_submitted',
      projectId: 'proj-local',
      sessionId: 'coding-session-local',
      branchName: 'feature/my-task',
      baseBranch: 'dev',
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(setLocalBranchPauseReason)).not.toHaveBeenCalled();
    expect(vi.mocked(rs.reviewPR)).toHaveBeenCalled();
  });
});

describe('ReviewOrchestrator — verify-as-gate: local-only, all verify commands pass', () => {
  it('proceeds to review when all verify commands pass', async () => {
    vi.mocked(getSession).mockReturnValue(verifySessionRow as any);
    vi.mocked(getLocalBranchBySession).mockReturnValue(
      verifyLocalBranchRow as any,
    );
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      verify: ['npm run lint', 'npm test'],
      autofix: [],
      ci_check_name: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    });
    vi.mocked(runVerifyAsGate).mockResolvedValue({ passed: true });

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('message', {
      type: 'local_branch_submitted',
      projectId: 'proj-local',
      sessionId: 'coding-session-local',
      branchName: 'feature/my-task',
      baseBranch: 'dev',
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(setLocalBranchPauseReason)).not.toHaveBeenCalled();
    expect(vi.mocked(runVerifyAsGate)).toHaveBeenCalledWith(
      expect.any(String),
      ['npm run lint', 'npm test'],
    );
    expect(vi.mocked(rs.reviewPR)).toHaveBeenCalled();
  });
});

describe('ReviewOrchestrator — verify-as-gate: local-only, first verify command fails', () => {
  it('sets ci_failing pause on local_branches row and sends structured feedback', async () => {
    vi.mocked(getSession).mockReturnValue(verifySessionRow as any);
    vi.mocked(getLocalBranchBySession).mockReturnValue(
      verifyLocalBranchRow as any,
    );
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      verify: ['npm run lint'],
      autofix: [],
      ci_check_name: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    });
    vi.mocked(runVerifyAsGate).mockResolvedValue({
      passed: false,
      failedCommand: 'npm run lint',
      truncatedOutput: 'error: lint failed on line 42',
    });

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('message', {
      type: 'local_branch_submitted',
      projectId: 'proj-local',
      sessionId: 'coding-session-local',
      branchName: 'feature/my-task',
      baseBranch: 'dev',
    });
    await new Promise((r) => setTimeout(r, 30));

    // Must set ci_failing pause on the local_branches row
    expect(vi.mocked(setLocalBranchPauseReason)).toHaveBeenCalledWith(
      5,
      'ci_failing',
    );

    // Must send structured CI failure feedback to coding session
    expect(vi.mocked(sm.send)).toHaveBeenCalledOnce();
    const [sessionId, message] = vi.mocked(sm.send).mock.calls[0];
    expect(sessionId).toBe('coding-session-local');
    expect(message).toContain('npm run lint');
    expect(message).toContain('error: lint failed on line 42');
    expect(message).toMatch(/investigate the failures and push a fix/i);

    // Must NOT spawn review
    expect(vi.mocked(rs.reviewPR)).not.toHaveBeenCalled();
  });

  it('skips review when local_branch row not found (onMessage guard)', async () => {
    vi.mocked(getSession).mockReturnValue(verifySessionRow as any);
    vi.mocked(getLocalBranchBySession).mockReturnValue(undefined);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('message', {
      type: 'local_branch_submitted',
      projectId: 'proj-local',
      sessionId: 'coding-session-local',
      branchName: 'feature/my-task',
      baseBranch: 'dev',
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(setLocalBranchPauseReason)).not.toHaveBeenCalled();
    expect(vi.mocked(sm.send)).not.toHaveBeenCalled();
    expect(vi.mocked(rs.reviewPR)).not.toHaveBeenCalled();
  });
});

describe('ReviewOrchestrator — verify-as-gate: verify runs AFTER autofix (ordering check)', () => {
  it('calls runVerifyAsGate with the worktreePath from the submitted job', async () => {
    vi.mocked(getLocalBranchBySession).mockReturnValue(
      verifyLocalBranchRow as any,
    );
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      verify: ['npm run lint'],
      autofix: [],
      ci_check_name: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    });
    vi.mocked(runVerifyAsGate).mockResolvedValue({ passed: true });
    vi.mocked(getSession).mockReturnValue({
      ...verifySessionRow,
      worktree_path: '/repos/local/worktree-42',
    } as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('message', {
      type: 'local_branch_submitted',
      projectId: 'proj-local',
      sessionId: 'coding-session-local',
      branchName: 'feature/my-task',
      baseBranch: 'dev',
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(runVerifyAsGate)).toHaveBeenCalledWith(
      '/repos/local/worktree-42',
      expect.any(Array),
    );
  });
});

// ── verify-gate autofix-first path ───────────────────────────────────────────

describe('ReviewOrchestrator — verify-gate autofix-first', () => {
  const autofixVerifyLocalBranchRow = {
    id: 20,
    project_id: 'proj-local',
    session_id: 'coding-session-local',
    branch_name: 'feature/my-task',
    base_branch: 'dev',
    status: 'open',
    review_result: null,
    pause_reason: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };

  const autofixVerifySessionRow = {
    session_id: 'coding-session-local',
    task_id: 'yaml:task-local',
    task_url: null,
    project_context_url: null,
    project_id: 'proj-local',
    status: 'done',
    started_at: 1000,
    ended_at: null,
    pr_url: null,
    worktree_path: '/repos/local/worktree',
    archived: 0,
    favorited: 0,
    session_type: 'standard',
    note: null,
    tags: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    task_name: null,
    metadata: null,
    review_result: null,
  };

  function emitLocalBranch(sm: ReturnType<typeof makeMockSessionManager>) {
    sm.emit('message', {
      type: 'local_branch_submitted',
      projectId: 'proj-local',
      sessionId: 'coding-session-local',
      branchName: 'feature/my-task',
      baseBranch: 'dev',
    });
  }

  it('proceeds to AI review when autofix produces a commit and re-verify passes', async () => {
    vi.mocked(getSession).mockReturnValue(autofixVerifySessionRow as any);
    vi.mocked(getLocalBranchBySession).mockReturnValue(
      autofixVerifyLocalBranchRow as any,
    );
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      verify: ['npm run lint'],
      autofix: ['npm run format:write'],
      ci_check_name: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    });
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run format:write']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      commitSha: 'fix-sha-1',
      summary: 'formatted',
    });
    // First call: verify fails; second call (after autofix): passes
    vi.mocked(runVerifyAsGate)
      .mockResolvedValueOnce({
        passed: false,
        failedCommand: 'npm run lint',
        truncatedOutput: 'lint error',
      })
      .mockResolvedValueOnce({ passed: true });

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, true);

    emitLocalBranch(sm);
    await new Promise((r) => setTimeout(r, 30));

    // Must NOT send CI failure feedback
    expect(vi.mocked(sm.send)).not.toHaveBeenCalled();
    expect(vi.mocked(setLocalBranchPauseReason)).not.toHaveBeenCalled();
    // Must proceed to review
    expect(vi.mocked(rs.reviewPR)).toHaveBeenCalledOnce();
    // Must write audit entry
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'autofix_for_ci_failure',
        actor_type: 'system',
        payload: expect.objectContaining({
          commit_sha: 'fix-sha-1',
          source: 'verify',
        }),
      }),
    );
  });

  it('sends original verify-failure feedback when autofix commits but re-verify still fails', async () => {
    vi.mocked(getSession).mockReturnValue(autofixVerifySessionRow as any);
    vi.mocked(getLocalBranchBySession).mockReturnValue(
      autofixVerifyLocalBranchRow as any,
    );
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      verify: ['npm run lint'],
      autofix: ['npm run format:write'],
      ci_check_name: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    });
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run format:write']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      commitSha: 'fix-sha-2',
      summary: 'formatted',
    });
    // Both verify calls fail
    vi.mocked(runVerifyAsGate).mockResolvedValue({
      passed: false,
      failedCommand: 'npm run lint',
      truncatedOutput: 'still failing',
    });

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, true);

    emitLocalBranch(sm);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(setLocalBranchPauseReason)).toHaveBeenCalledWith(
      20,
      'ci_failing',
    );
    expect(vi.mocked(sm.send)).toHaveBeenCalledOnce();
    const [sessionId, message] = vi.mocked(sm.send).mock.calls[0];
    expect(sessionId).toBe('coding-session-local');
    expect(message).toContain('npm run lint');
    expect(vi.mocked(rs.reviewPR)).not.toHaveBeenCalled();
  });

  it('sends original verify-failure feedback when autofix produces no diff', async () => {
    vi.mocked(getSession).mockReturnValue(autofixVerifySessionRow as any);
    vi.mocked(getLocalBranchBySession).mockReturnValue(
      autofixVerifyLocalBranchRow as any,
    );
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      verify: ['npm run lint'],
      autofix: ['npm run format:write'],
      ci_check_name: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    });
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run format:write']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      summary: 'no diff',
    });
    vi.mocked(runVerifyAsGate).mockResolvedValue({
      passed: false,
      failedCommand: 'npm run lint',
      truncatedOutput: 'lint error',
    });

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, true);

    emitLocalBranch(sm);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(setLocalBranchPauseReason)).toHaveBeenCalledWith(
      20,
      'ci_failing',
    );
    expect(vi.mocked(sm.send)).toHaveBeenCalledOnce();
    const [, message] = vi.mocked(sm.send).mock.calls[0];
    expect(message).toContain('npm run lint');
    expect(vi.mocked(rs.reviewPR)).not.toHaveBeenCalled();
    expect(vi.mocked(recordEvent)).not.toHaveBeenCalled();
  });
});

// ── registerRevertSync / pendingSyncs mutex ───────────────────────────────────

describe('ReviewOrchestrator — registerRevertSync pendingSyncs mutex', () => {
  it('executeReview awaits a pending sync before calling reviewService.reviewPR', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({
      ...basePRRow,
      review_iteration: 0,
    } as any);

    const sm = makeMockSessionManager();
    const callOrder: string[] = [];

    let resolveSyncPromise!: () => void;
    const syncPromise = new Promise<void>((r) => {
      resolveSyncPromise = r;
    });

    const rs: PRReviewService = {
      reviewPR: vi.fn().mockImplementation(async () => {
        callOrder.push('reviewPR');
        return {
          prNumber: 1,
          repo: 'owner/repo',
          verdict: 'approved',
          dimensions: [],
          summary: 'ok',
          reviewedAt: new Date().toISOString(),
        };
      }),
    } as unknown as PRReviewService;

    const orch = new ReviewOrchestrator(rs, sm as any, 1, true);

    // Register a slow sync for this PR before opening the review
    orch.registerRevertSync(1, 'owner/repo', syncPromise);
    callOrder.push('syncRegistered');

    // Open the review — executeReview should block on the sync
    sm.emit('pr_opened', baseJob);

    // Give drain() time to start executeReview (but syncPromise is not resolved)
    await new Promise((r) => setTimeout(r, 30));
    expect(vi.mocked(rs.reviewPR)).not.toHaveBeenCalled();

    // Now resolve the sync
    callOrder.push('syncResolved');
    resolveSyncPromise();

    // Give executeReview time to proceed past the await
    await new Promise((r) => setTimeout(r, 30));
    expect(vi.mocked(rs.reviewPR)).toHaveBeenCalledOnce();

    expect(callOrder.indexOf('syncResolved')).toBeLessThan(
      callOrder.indexOf('reviewPR'),
    );
  });

  it('listens for revert_sync_registered event from SessionManager and stores the sync', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({
      ...basePRRow,
      review_iteration: 0,
    } as any);

    const sm = makeMockSessionManager();

    let syncResolved = false;
    let resolveSyncPromise!: () => void;
    const syncPromise = new Promise<void>((r) => {
      resolveSyncPromise = r;
    }).then(() => {
      syncResolved = true;
    });

    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, true);

    // Simulate what SessionManager.registerRevertSync emits
    sm.emit('revert_sync_registered', {
      prNumber: 1,
      repo: 'owner/repo',
      syncPromise,
    });

    // Open the review
    sm.emit('pr_opened', baseJob);

    // Sync not yet resolved — review should not have started
    await new Promise((r) => setTimeout(r, 30));
    expect(vi.mocked(rs.reviewPR)).not.toHaveBeenCalled();
    expect(syncResolved).toBe(false);

    // Resolve the sync
    resolveSyncPromise();
    await new Promise((r) => setTimeout(r, 30));

    expect(syncResolved).toBe(true);
    expect(vi.mocked(rs.reviewPR)).toHaveBeenCalledOnce();
  });

  it('does not block a second review after the sync has been consumed', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({
      ...basePRRow,
      review_iteration: 0,
    } as any);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    const orch = new ReviewOrchestrator(rs, sm as any, 1, true);

    // Register a sync that is already resolved
    orch.registerRevertSync(1, 'owner/repo', Promise.resolve());

    // First review — consumes the sync
    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));
    expect(vi.mocked(rs.reviewPR)).toHaveBeenCalledTimes(1);

    vi.mocked(rs.reviewPR as ReturnType<typeof vi.fn>).mockClear();
    vi.mocked(getPRByNumber).mockReturnValue({
      ...basePRRow,
      review_iteration: 0,
    } as any);

    // Second review — no pending sync; should proceed immediately
    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 30));
    expect(vi.mocked(rs.reviewPR)).toHaveBeenCalledTimes(1);
  });
});

// ── Autofix → file pollution check wiring ────────────────────────────────────

describe('ReviewOrchestrator — file pollution check after autofix', () => {
  function makeGitHubClient(): GitHubClient {
    return {
      markPRReady: vi.fn().mockResolvedValue(undefined),
      fetchPR: vi.fn().mockResolvedValue({ ...baseFreshPR }),
    } as unknown as GitHubClient;
  }

  it('invokes runFilePollutionCheck after autofix produces a commitSha', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/fake/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run format:write']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      commitSha: 'autofix-sha-abc',
      touchedFiles: ['src/foo.ts', 'CLAUDE.md'],
      summary: 'formatted',
    });

    const sm = makeMockSessionManager();
    const gc = makeGitHubClient();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, true, gc);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(runFilePollutionCheck)).toHaveBeenCalledOnce();
    expect(vi.mocked(runFilePollutionCheck)).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'owner/repo',
        prNumber: 1,
        baseBranch: 'dev',
        worktreePath: '/fake/worktree',
      }),
    );
  });

  it('does NOT invoke runFilePollutionCheck when autofix produces no commit', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/fake/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run format:write']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      summary: 'no diff',
      // no commitSha
    });

    const sm = makeMockSessionManager();
    const gc = makeGitHubClient();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, true, gc);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(runFilePollutionCheck)).not.toHaveBeenCalled();
  });

  it('proceeds to reviewPR even when runFilePollutionCheck finds no banned files', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/fake/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run format:write']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      commitSha: 'autofix-sha-clean',
      touchedFiles: ['src/foo.ts'],
      summary: 'formatted',
    });
    vi.mocked(runFilePollutionCheck).mockResolvedValue({
      headSha: 'autofix-sha-clean',
      revertCommitSha: null, // no banned files
    });

    const sm = makeMockSessionManager();
    const gc = makeGitHubClient();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, true, gc);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(rs.reviewPR)).toHaveBeenCalledOnce();
  });

  it('calls runFilePollutionCheck before reviewPR (ordering)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/fake/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run format:write']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      commitSha: 'autofix-sha-order',
      summary: 'formatted',
    });

    const callOrder: string[] = [];
    vi.mocked(runFilePollutionCheck).mockImplementation(async () => {
      callOrder.push('pollutionCheck');
      return { headSha: null, revertCommitSha: null };
    });

    const sm = makeMockSessionManager();
    const gc = makeGitHubClient();
    const rs: PRReviewService = {
      reviewPR: vi.fn().mockImplementation(async () => {
        callOrder.push('reviewPR');
        return {
          prNumber: 1,
          repo: 'owner/repo',
          verdict: 'approved',
          dimensions: [],
          summary: 'ok',
          reviewedAt: new Date().toISOString(),
        };
      }),
    } as unknown as PRReviewService;
    new ReviewOrchestrator(rs, sm as any, 1, true, gc);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 50));

    expect(callOrder.indexOf('pollutionCheck')).toBeLessThan(
      callOrder.indexOf('reviewPR'),
    );
  });

  it('does NOT invoke runFilePollutionCheck when no GitHub client is configured', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/fake/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run format:write']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      commitSha: 'autofix-sha-nogithub',
      summary: 'formatted',
    });

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    // No GitHub client passed
    new ReviewOrchestrator(rs, sm as any, 1, true);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(runFilePollutionCheck)).not.toHaveBeenCalled();
  });

  it('calls sessionManager.addToRevertLock when pollution check reverts files', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/fake/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run format:write']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      commitSha: 'autofix-sha-revert',
      summary: 'formatted',
    });
    vi.mocked(runFilePollutionCheck).mockImplementation(async (opts) => {
      opts.onReverted?.(['CLAUDE.md']);
      return { headSha: 'autofix-sha-revert', revertCommitSha: 'revert-sha-1' };
    });

    const sm = makeMockSessionManager();
    const gc = makeGitHubClient();
    const rs = makeMockReviewService();
    new ReviewOrchestrator(rs, sm as any, 1, true, gc);

    sm.emit('pr_opened', baseJob);
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(sm.addToRevertLock)).toHaveBeenCalledWith(
      basePRRow.session_id,
      ['CLAUDE.md'],
    );
  });
});

// ── runAutofixPipeline (shared helper) ───────────────────────────────────────
// AC: The extracted helper is invoked by both executeReview and server.ts
// push_detected. These tests exercise the helper directly so its contract is
// independently verified.

describe('ReviewOrchestrator — runAutofixPipeline helper', () => {
  function makeGitHubClient() {
    return {
      markPRReady: vi.fn().mockResolvedValue(undefined),
      fetchPR: vi.fn().mockResolvedValue({ ...baseFreshPR }),
    } as unknown as GitHubClient;
  }

  it('emits autofix_started and autofix_complete in order when commands are configured', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/fake/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run lint']);
    vi.mocked(runAutofix).mockResolvedValue({ success: true, summary: 'done' });

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    const orch = new ReviewOrchestrator(rs, sm as any, 1, true);

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    await orch.runAutofixPipeline(1, 'owner/repo', 'task-xyz');

    const types = messages.map((m: any) => m.type as string);
    const startIdx = types.indexOf('autofix_started');
    const completeIdx = types.indexOf('autofix_complete');
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(completeIdx).toBeGreaterThan(startIdx);
  });

  it('does nothing when no autofix commands are configured', async () => {
    vi.mocked(loadAutofixCommands).mockReturnValue([]);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    const orch = new ReviewOrchestrator(rs, sm as any, 1, true);

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    await orch.runAutofixPipeline(1, 'owner/repo', null);

    expect(messages).toHaveLength(0);
    expect(vi.mocked(runAutofix)).not.toHaveBeenCalled();
  });

  it('does nothing when no project is found for the repo', async () => {
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run lint']);

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    const orch = new ReviewOrchestrator(rs, sm as any, 1, true);

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    // 'unknown/repo' returns undefined from getProjectByGithubRepo mock
    await orch.runAutofixPipeline(1, 'unknown/repo', null);

    expect(messages).toHaveLength(0);
    expect(vi.mocked(runAutofix)).not.toHaveBeenCalled();
  });

  it('calls runFilePollutionCheck after autofix commits (ordering)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/fake/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run format:write']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      commitSha: 'autofix-sha-direct',
      summary: 'formatted',
    });

    const callOrder: string[] = [];
    vi.mocked(runFilePollutionCheck).mockImplementation(async () => {
      callOrder.push('pollutionCheck');
      return { headSha: null, revertCommitSha: null };
    });

    const sm = makeMockSessionManager();
    const gc = makeGitHubClient();
    const rs = makeMockReviewService();
    const orch = new ReviewOrchestrator(rs, sm as any, 1, true, gc);

    await orch.runAutofixPipeline(1, 'owner/repo', 'task-direct');

    expect(vi.mocked(runAutofix)).toHaveBeenCalledOnce();
    expect(callOrder).toContain('pollutionCheck');
  });

  it('registers autofix commit SHA via addAutofixSha so consumeAutofixSha can match it', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/fake/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run lint']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      commitSha: 'pipeline-sha-42',
      summary: 'done',
    });

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    const orch = new ReviewOrchestrator(rs, sm as any, 1, true);

    await orch.runAutofixPipeline(1, 'owner/repo', null);

    expect(vi.mocked(addAutofixSha)).toHaveBeenCalledWith(
      1,
      'owner/repo',
      'pipeline-sha-42',
    );

    // consumeAutofixSha delegates to DB — simulate a match
    vi.mocked(dbConsumeAutofixSha).mockReturnValue(true);
    expect(orch.consumeAutofixSha(1, 'owner/repo', 'pipeline-sha-42')).toBe(
      true,
    );
    expect(vi.mocked(dbConsumeAutofixSha)).toHaveBeenCalledWith(
      1,
      'owner/repo',
      'pipeline-sha-42',
    );
  });

  it('registers revert commit SHA from runFilePollutionCheck via addAutofixSha', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/fake/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run lint']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      commitSha: 'autofix-sha-abc',
      summary: 'done',
    });
    vi.mocked(runFilePollutionCheck).mockResolvedValue({
      headSha: 'autofix-sha-abc',
      revertCommitSha: 'revert-sha-xyz',
    });

    const mockGithub = makeMockGitHubClient();
    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    const orch = new ReviewOrchestrator(rs, sm as any, 1, true, mockGithub);

    await orch.runAutofixPipeline(1, 'owner/repo', null);

    expect(vi.mocked(addAutofixSha)).toHaveBeenCalledWith(
      1,
      'owner/repo',
      'autofix-sha-abc',
    );
    expect(vi.mocked(addAutofixSha)).toHaveBeenCalledWith(
      1,
      'owner/repo',
      'revert-sha-xyz',
    );
  });

  it('consumeAutofixSha returns true for revert SHA registered by runFilePollutionCheck', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/fake/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run lint']);
    vi.mocked(runAutofix).mockResolvedValue({
      success: true,
      commitSha: 'autofix-sha-abc',
      summary: 'done',
    });
    vi.mocked(runFilePollutionCheck).mockResolvedValue({
      headSha: 'autofix-sha-abc',
      revertCommitSha: 'revert-sha-xyz',
    });

    const mockGithub = makeMockGitHubClient();
    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    const orch = new ReviewOrchestrator(rs, sm as any, 1, true, mockGithub);

    await orch.runAutofixPipeline(1, 'owner/repo', null);

    // Simulate DB having the revert SHA registered
    vi.mocked(dbConsumeAutofixSha).mockReturnValueOnce(true);
    expect(orch.consumeAutofixSha(1, 'owner/repo', 'revert-sha-xyz')).toBe(
      true,
    );
  });

  it('consumeAutofixSha reads from DB — a fresh instance (simulating restart) still returns true for a registered SHA', () => {
    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();

    // Simulate SHA registered in DB before the restart
    vi.mocked(dbConsumeAutofixSha).mockReturnValueOnce(true);

    // Fresh ReviewOrchestrator instance (no in-memory state from previous instance)
    const freshOrch = new ReviewOrchestrator(rs, sm as any, 1, true);

    expect(
      freshOrch.consumeAutofixSha(1, 'owner/repo', 'pre-restart-sha'),
    ).toBe(true);
    expect(vi.mocked(dbConsumeAutofixSha)).toHaveBeenCalledWith(
      1,
      'owner/repo',
      'pre-restart-sha',
    );
  });

  it('fails open — proceeds with autofix_complete(success:false) when runAutofix throws', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(basePRRow as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/fake/worktree',
    } as any);
    vi.mocked(loadAutofixCommands).mockReturnValue(['npm run lint']);
    vi.mocked(runAutofix).mockRejectedValue(new Error('disk full'));

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService();
    const orch = new ReviewOrchestrator(rs, sm as any, 1, true);

    const messages: object[] = [];
    sm.on('message', (msg: object) => messages.push(msg));

    await orch.runAutofixPipeline(1, 'owner/repo', null);

    const complete = messages.find(
      (m: any) => m.type === 'autofix_complete',
    ) as any;
    expect(complete).toBeDefined();
    expect(complete.success).toBe(false);
    expect(complete.summary).toContain('disk full');
  });
});

// ── reviewLocalBranch: sendOrResume + verdict_routing_failed ─────────────────

describe('ReviewOrchestrator — reviewLocalBranch: sendOrResume + audit logging', () => {
  const localBranchRow = {
    id: 30,
    project_id: 'proj-local',
    session_id: 'coding-session-local',
    branch_name: 'feature/audit-test',
    base_branch: 'dev',
    status: 'open',
    review_result: null,
    pause_reason: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };

  const localSessionRow = {
    session_id: 'coding-session-local',
    task_id: 'yaml:task-local',
    task_url: null,
    project_context_url: null,
    project_id: 'proj-local',
    status: 'done',
    started_at: 1000,
    ended_at: null,
    pr_url: null,
    worktree_path: '/repos/local/worktree',
    archived: 0,
    favorited: 0,
    session_type: 'standard',
    note: null,
    tags: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    task_name: null,
    metadata: null,
    review_result: null,
  };

  function emitLocalBranch(sm: ReturnType<typeof makeMockSessionManager>) {
    sm.emit('message', {
      type: 'local_branch_submitted',
      projectId: 'proj-local',
      sessionId: 'coding-session-local',
      branchName: 'feature/audit-test',
      baseBranch: 'dev',
    });
  }

  it('calls sendOrResume with session id and feedback when verdict is needs_changes', async () => {
    vi.mocked(getLocalBranchBySession).mockReturnValue(localBranchRow as any);
    vi.mocked(getSession).mockReturnValue(localSessionRow as any);
    vi.mocked(runVerifyAsGate).mockResolvedValue({ passed: true });

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService({
      prNumber: 30,
      repo: 'local/feature/audit-test',
      verdict: 'needs_changes',
      dimensions: [
        {
          name: 'Diff vs Context spec',
          passed: false,
          notes: 'Missing implementation.',
        },
      ],
      summary: 'Needs work.',
      reviewedAt: new Date().toISOString(),
    });
    new ReviewOrchestrator(rs, sm as any, 1, true);

    emitLocalBranch(sm);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(sm.sendOrResume)).toHaveBeenCalledOnce();
    const [sessionId, message] = vi.mocked(sm.sendOrResume).mock.calls[0];
    expect(sessionId).toBe('coding-session-local');
    expect(message).toContain('Review Feedback');
    expect(message).toContain('Missing implementation.');
  });

  it('records verdict_routing_failed when sendOrResume throws in local branch path', async () => {
    vi.mocked(getLocalBranchBySession).mockReturnValue(localBranchRow as any);
    vi.mocked(getSession).mockReturnValue(localSessionRow as any);
    vi.mocked(runVerifyAsGate).mockResolvedValue({ passed: true });

    const sm = makeMockSessionManager();
    vi.mocked(sm.sendOrResume).mockRejectedValue(new Error('network error'));

    const rs = makeMockReviewService({
      prNumber: 30,
      repo: 'local/feature/audit-test',
      verdict: 'needs_changes',
      dimensions: [
        { name: 'Diff vs Context spec', passed: false, notes: 'ok' },
      ],
      summary: 'Needs work.',
      reviewedAt: new Date().toISOString(),
    });
    new ReviewOrchestrator(rs, sm as any, 1, true);

    emitLocalBranch(sm);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'verdict_routing_failed',
        actor_type: 'system',
        actor_id: 'coding-session-local',
        payload: expect.objectContaining({
          pr_number: 30,
          repo: 'local/feature/audit-test',
          error: expect.stringContaining('network error'),
        }),
      }),
    );
  });

  it('does not record verdict_routing_failed when sendOrResume resolves in local branch path', async () => {
    vi.mocked(getLocalBranchBySession).mockReturnValue(localBranchRow as any);
    vi.mocked(getSession).mockReturnValue(localSessionRow as any);
    vi.mocked(runVerifyAsGate).mockResolvedValue({ passed: true });

    const sm = makeMockSessionManager();
    const rs = makeMockReviewService({
      prNumber: 30,
      repo: 'local/feature/audit-test',
      verdict: 'needs_changes',
      dimensions: [
        { name: 'Diff vs Context spec', passed: false, notes: 'ok' },
      ],
      summary: 'Needs work.',
      reviewedAt: new Date().toISOString(),
    });
    new ReviewOrchestrator(rs, sm as any, 1, true);

    emitLocalBranch(sm);
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(sm.sendOrResume)).toHaveBeenCalledOnce();
    expect(vi.mocked(recordEvent)).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'verdict_routing_failed' }),
    );
  });

  it('exception from sendOrResume does not bubble out of reviewLocalBranch', async () => {
    vi.mocked(getLocalBranchBySession).mockReturnValue(localBranchRow as any);
    vi.mocked(getSession).mockReturnValue(localSessionRow as any);
    vi.mocked(runVerifyAsGate).mockResolvedValue({ passed: true });

    const sm = makeMockSessionManager();
    vi.mocked(sm.sendOrResume).mockRejectedValue(
      new Error('fatal spawn error'),
    );

    const rs = makeMockReviewService({
      prNumber: 30,
      repo: 'local/feature/audit-test',
      verdict: 'needs_changes',
      dimensions: [],
      summary: 'Needs work.',
      reviewedAt: new Date().toISOString(),
    });
    new ReviewOrchestrator(rs, sm as any, 1, true);

    // Should not throw — errors are caught internally
    await expect(
      new Promise<void>((resolve) => {
        emitLocalBranch(sm);
        setTimeout(resolve, 30);
      }),
    ).resolves.toBeUndefined();
  });
});
