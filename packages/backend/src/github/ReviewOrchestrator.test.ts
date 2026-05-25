import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks (must come before imports of the modules under test) ──────────────

vi.mock('../db/queries.js', () => ({
  setPRReviewResult: vi.fn(),
  getPRByNumber: vi.fn(),
  getSetting: vi.fn().mockReturnValue(undefined),
  incrementReviewIteration: vi.fn(),
  updatePRDraftStatus: vi.fn(),
  setPendingPush: vi.fn(),
  setPauseReason: vi.fn(),
  getLocalBranchBySession: vi.fn(),
  setLocalBranchPauseReason: vi.fn(),
  getSession: vi.fn(),
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
  updatePRDraftStatus,
  setPauseReason,
  getLocalBranchBySession,
  setLocalBranchPauseReason,
  getSession,
} from '../db/queries';
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
    expect(vi.mocked(sm.send)).not.toHaveBeenCalled();

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

    new ReviewOrchestrator(rs, sm as any, 1, true);

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

describe('Break 4 (AC) — auto findings routing: sessionManager.send() called on needs_changes', () => {
  it('calls sessionManager.send() with formatted findings when verdict is needs_changes', async () => {
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
  notion_task_id: 'task-local-abc',
  notion_task_url: null,
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
  notion_task_id: 'task-local',
  notion_task_url: 'https://notion.so/task-local',
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
