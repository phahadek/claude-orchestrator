/**
 * Tests for cap-escalated PR recovery:
 * - POST /prs/:n/approve clears stalled_reconcile_cap pause and re-enqueues
 * - POST /prs/:n/unpark clears cap-pause and re-enqueues pipeline
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../routes/tasks.js', () => ({
  emitTaskUpdated: vi.fn(),
}));

vi.mock('../db/queries.js', () => ({
  getPRs: vi.fn(),
  getPRByNumber: vi.fn(),
  updatePRState: vi.fn(),
  updateMergeState: vi.fn(),
  getTaskTitleFromCache: vi.fn().mockReturnValue(null),
  upsertPullRequest: vi.fn(),
  deletePR: vi.fn(),
  resetReviewIteration: vi.fn(),
  setPRReviewResult: vi.fn(),
  updatePRDraftStatus: vi.fn(),
  getSessionsByProject: vi.fn().mockReturnValue([]),
  markSessionDone: vi.fn(),
  clearTerminalPRFlags: vi.fn(),
  lookupSessionByBranch: vi.fn().mockReturnValue(null),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../config.js', () => ({
  getProjectById: vi.fn((id: string) => {
    if (id === 'proj-1') {
      return {
        id: 'proj-1',
        name: 'Test Project',
        projectDir: '/test',
        contextUrl: 'https://notion.so/ctx',
        boardId: 'board-1',
        githubRepo: 'owner/repo',
        gitMode: 'github',
        autoMergeEnabled: false,
      };
    }
    return undefined;
  }),
  getProjectByGithubRepo: vi.fn((repo: string) => {
    if (repo === 'owner/repo') {
      return {
        id: 'proj-1',
        name: 'Test Project',
        projectDir: '/test',
        contextUrl: 'https://notion.so/ctx',
        boardId: 'board-1',
        githubRepo: 'owner/repo',
        gitMode: 'github',
        autoMergeEnabled: false,
      };
    }
    return undefined;
  }),
}));

vi.mock('../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({ ci_check_name: [] }),
}));

vi.mock('../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi.fn().mockReturnValue(undefined),
}));

import * as queries from '../db/queries.js';
import * as auditLog from '../audit/AuditLog.js';
import { createPrsRouter } from '../routes/prs.js';
import type { GitHubClient } from '../github/GitHubClient.js';
import type { PRReviewService } from '../github/PRReviewService.js';
import type { SessionManager } from '../session/SessionManager.js';

const CAP_PAUSE_JSON = JSON.stringify({
  reason: 'stalled_reconcile_cap',
  source: 'review',
  severity: 'needs_attention',
  retry_strategy: 'manual_action',
});

function makeCapPRRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    pr_number: 42,
    pr_url: 'https://github.com/owner/repo/pull/42',
    task_id: 'task-123',
    session_id: 'sess-abc',
    review_session_id: null,
    repo: 'owner/repo',
    title: 'PR 42',
    body: null,
    head_branch: 'feature/x',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: null,
    review_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    synced_at: '2024-01-01T00:00:00Z',
    review_iteration: 0,
    head_sha: 'abc123',
    last_reviewed_sha: null,
    node_id: null,
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
    failing_checks: null,
    pending_push: 0,
    pause_reason: CAP_PAUSE_JSON,
    pre_review_stage: 'blocked_autofix',
    pause_reason_set_at: null,
    conflict_nudge_sha: null,
    ci_remediation_attempted_sha: null,
    autofix_shas: null,
    ...overrides,
  };
}

function makeGithub() {
  return {
    listOpenPRs: vi.fn().mockResolvedValue([]),
    fetchPR: vi.fn().mockResolvedValue({}),
    markPRReady: vi.fn().mockResolvedValue(undefined),
  } as unknown as GitHubClient;
}

function makeSessionManager() {
  return {
    sendOrResume: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as SessionManager;
}

function makePRReviewService() {
  return {
    reviewPR: vi.fn().mockResolvedValue({
      verdict: 'approved',
      summary: 'Looks good',
      dimensions: [],
      prNumber: 42,
      repo: 'owner/repo',
      reviewedAt: new Date().toISOString(),
    }),
  } as unknown as PRReviewService;
}

// ── POST /prs/:owner/:repoName/:prNumber/approve ──────────────────────────────

describe('POST /prs/:owner/:repoName/:prNumber/approve — cap-escalated PR', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls clearTerminalPRFlags when PR has stalled_reconcile_cap pause', async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(makeCapPRRow() as never);

    const runAutofixPipeline = vi
      .fn()
      .mockResolvedValue({ success: true, summary: 'done' });
    const reviewOrchestrator = { runAutofixPipeline };

    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createPrsRouter(
        makeGithub(),
        makePRReviewService(),
        makeSessionManager(),
        undefined,
        undefined,
        undefined,
        reviewOrchestrator,
      ),
    );

    await supertest(app).post('/api/prs/owner/repo/42/approve').expect(200);

    expect(queries.clearTerminalPRFlags).toHaveBeenCalledWith(42, 'owner/repo');
  });

  it('calls runAutofixPipeline with correct args when PR is cap-escalated', async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(
      makeCapPRRow({ task_id: 'task-abc' }) as never,
    );

    const runAutofixPipeline = vi
      .fn()
      .mockResolvedValue({ success: true, summary: 'done' });
    const reviewOrchestrator = { runAutofixPipeline };

    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createPrsRouter(
        makeGithub(),
        makePRReviewService(),
        makeSessionManager(),
        undefined,
        undefined,
        undefined,
        reviewOrchestrator,
      ),
    );

    await supertest(app).post('/api/prs/owner/repo/42/approve').expect(200);

    // Allow the void promise to settle
    await new Promise((r) => setTimeout(r, 20));

    expect(runAutofixPipeline).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'task-abc',
    );
  });

  it('does NOT call clearTerminalPRFlags when PR has no cap pause', async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(
      makeCapPRRow({ pause_reason: null }) as never,
    );

    const runAutofixPipeline = vi
      .fn()
      .mockResolvedValue({ success: true, summary: 'done' });
    const reviewOrchestrator = { runAutofixPipeline };

    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createPrsRouter(
        makeGithub(),
        makePRReviewService(),
        makeSessionManager(),
        undefined,
        undefined,
        undefined,
        reviewOrchestrator,
      ),
    );

    await supertest(app).post('/api/prs/owner/repo/42/approve').expect(200);

    expect(queries.clearTerminalPRFlags).not.toHaveBeenCalled();
    expect(runAutofixPipeline).not.toHaveBeenCalled();
  });
});

// ── POST /api/prs/:prNumber/unpark ────────────────────────────────────────────

describe('POST /prs/:prNumber/unpark', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when projectId is missing', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createPrsRouter(
        makeGithub(),
        makePRReviewService(),
        makeSessionManager(),
      ),
    );

    await supertest(app).post('/api/prs/42/unpark').expect(400);
  });

  it('returns 404 when PR is not found', async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(null as never);

    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createPrsRouter(
        makeGithub(),
        makePRReviewService(),
        makeSessionManager(),
      ),
    );

    await supertest(app)
      .post('/api/prs/42/unpark?projectId=proj-1')
      .expect(404);
  });

  it('calls clearTerminalPRFlags and returns ok', async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(makeCapPRRow() as never);

    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createPrsRouter(
        makeGithub(),
        makePRReviewService(),
        makeSessionManager(),
      ),
    );

    const res = await supertest(app)
      .post('/api/prs/42/unpark?projectId=proj-1')
      .expect(200);

    expect(res.body).toEqual({ ok: true });
    expect(queries.clearTerminalPRFlags).toHaveBeenCalledWith(42, 'owner/repo');
  });

  it('calls runAutofixPipeline with correct args', async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(
      makeCapPRRow({ task_id: 'task-xyz' }) as never,
    );

    const runAutofixPipeline = vi
      .fn()
      .mockResolvedValue({ success: true, summary: 'done' });
    const reviewOrchestrator = { runAutofixPipeline };

    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createPrsRouter(
        makeGithub(),
        makePRReviewService(),
        makeSessionManager(),
        undefined,
        undefined,
        undefined,
        reviewOrchestrator,
      ),
    );

    await supertest(app)
      .post('/api/prs/42/unpark?projectId=proj-1')
      .expect(200);

    await new Promise((r) => setTimeout(r, 20));

    expect(runAutofixPipeline).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'task-xyz',
    );
  });

  it('records a pr_unparked audit event', async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(
      makeCapPRRow({ task_id: 'task-xyz' }) as never,
    );

    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createPrsRouter(
        makeGithub(),
        makePRReviewService(),
        makeSessionManager(),
      ),
    );

    await supertest(app)
      .post('/api/prs/42/unpark?projectId=proj-1')
      .expect(200);

    expect(auditLog.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'pr_unparked',
        actor_type: 'human',
        task_id: 'task-xyz',
      }),
    );
  });
});
