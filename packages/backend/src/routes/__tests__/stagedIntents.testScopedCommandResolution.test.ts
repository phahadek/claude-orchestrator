/**
 * End-to-end coverage for resolveTestRequestExecutionInputs's test_scoped /
 * test_full_run_paths selection — exercised through routeStageTimeBlock's
 * mechanical test.request auto-grant (maybeAutoApproveTestRequest), which is
 * the only path that turns a resolved command list into the `commands`
 * argument admitTestRequest is called with.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const {
  mockGetProjectById,
  mockLoadOrchestratorConfig,
  mockComputeHash,
  mockGetChangedFiles,
  mockAdmitTestRequest,
} = vi.hoisted(() => ({
  mockGetProjectById: vi.fn(),
  mockLoadOrchestratorConfig: vi.fn(),
  mockComputeHash: vi.fn(),
  mockGetChangedFiles: vi.fn(),
  mockAdmitTestRequest: vi.fn(),
}));

vi.mock('../../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config')>();
  return { ...actual, getProjectById: mockGetProjectById };
});

vi.mock('../../session/orchestrator-config', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../session/orchestrator-config')>();
  return { ...actual, loadOrchestratorConfig: mockLoadOrchestratorConfig };
});

vi.mock('../../session/analyzeGating', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../session/analyzeGating')>();
  return { ...actual, computeWholeTreeContentHash: mockComputeHash };
});

vi.mock('../../session/autofix-runner', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../session/autofix-runner')>();
  return { ...actual, getChangedFiles: mockGetChangedFiles };
});

vi.mock('../../orchestration/testRequestLane', () => ({
  admitTestRequest: mockAdmitTestRequest,
}));

import { db } from '../../db/db';
import { stageIntent, routeStageTimeBlock } from '../stagedIntents';
import { insertSession, updateSessionWorktreePath } from '../../db/queries';
import { typedSetSetting } from '../../config/settings';

function setUpSession(sessionId: string) {
  insertSession({
    session_id: sessionId,
    task_id: 'task-1',
    task_url: null,
    project_context_url: null,
    status: 'running',
    started_at: Date.now(),
  });
  updateSessionWorktreePath(sessionId, '/tmp/wt');
}

function insertPRForSession(
  sessionId: string,
  prNumber: number,
  baseBranch: string | null,
) {
  db.prepare(
    `
    INSERT INTO pull_requests
      (pr_number, pr_url, repo, task_id, title, state, draft, review_result,
       review_at, created_at, updated_at, synced_at, session_id, base_branch)
    VALUES
      (@pr_number, @pr_url, @repo, @task_id, @title, @state, 0, NULL,
       NULL, @now, @now, @now, @session_id, @base_branch)
  `,
  ).run({
    pr_number: prNumber,
    pr_url: `https://github.com/org/repo/pull/${prNumber}`,
    repo: 'org/repo',
    task_id: 'task-1',
    title: 'test pr',
    state: 'open',
    now: new Date().toISOString(),
    session_id: sessionId,
    base_branch: baseBranch,
  });
}

function stageTestRequest(sessionId: string) {
  return stageIntent(
    'test.request',
    { taskId: 'task-1', reason: 'confirm the fix' },
    'proj-1',
    null,
    sessionId,
  );
}

function stubFreshAdmission(runId = 'run-1') {
  return {
    runId,
    status: 'running' as const,
    position: 0,
    queueDepth: 0,
    reused: false,
    result: Promise.resolve({
      runId,
      passed: true,
      output: 'ok',
      joined: false,
    }),
  };
}

beforeEach(() => {
  mockGetProjectById.mockReset();
  mockLoadOrchestratorConfig.mockReset();
  mockComputeHash.mockReset();
  mockGetChangedFiles.mockReset();
  mockAdmitTestRequest.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM pull_requests').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM session_test_request_cycles').run();
  db.prepare('DELETE FROM session_feedback_inbox').run();

  mockGetProjectById.mockReturnValue({
    id: 'proj-1',
    projectDir: '/proj',
    baseBranch: 'dev',
  });
  mockComputeHash.mockResolvedValue('hash-1');
  mockAdmitTestRequest.mockImplementation(() => stubFreshAdmission());
  typedSetSetting('test_request_cycle_limit', 3);
});

describe('resolveTestRequestExecutionInputs — test_scoped / test_full_run_paths', () => {
  it('a project without test_scoped configured always resolves to the full test: commands', async () => {
    mockLoadOrchestratorConfig.mockReturnValue({
      test: ['npm run test -w packages/backend'],
      test_scoped: [],
      test_full_run_paths: [],
      test_timeout_sec: 60,
      test_max_rss_mb: 0,
      test_fail_fast: true,
    });
    setUpSession('session-no-scoped');
    const intent = stageTestRequest('session-no-scoped');

    await routeStageTimeBlock(intent, undefined);

    expect(mockGetChangedFiles).not.toHaveBeenCalled();
    expect(mockAdmitTestRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: ['npm run test -w packages/backend'],
      }),
    );
  });

  it('a diff that does not touch test_full_run_paths resolves to the scoped command', async () => {
    mockLoadOrchestratorConfig.mockReturnValue({
      test: ['npm run test -w packages/backend'],
      test_scoped: ['npm run test:scoped -- {{changed_files}}'],
      test_full_run_paths: ['package-lock.json'],
      test_timeout_sec: 60,
      test_max_rss_mb: 0,
      test_fail_fast: true,
    });
    mockGetChangedFiles.mockResolvedValue(['packages/backend/src/foo.ts']);
    setUpSession('session-scoped');
    const intent = stageTestRequest('session-scoped');

    await routeStageTimeBlock(intent, undefined);

    expect(mockGetChangedFiles).toHaveBeenCalledWith('/tmp/wt', 'dev');
    expect(mockAdmitTestRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: ["npm run test:scoped -- 'packages/backend/src/foo.ts'"],
      }),
    );
  });

  it('a diff touching a test_full_run_paths glob resolves to the full test: command instead', async () => {
    mockLoadOrchestratorConfig.mockReturnValue({
      test: ['npm run test -w packages/backend'],
      test_scoped: ['npm run test:scoped -- {{changed_files}}'],
      test_full_run_paths: ['package-lock.json'],
      test_timeout_sec: 60,
      test_max_rss_mb: 0,
      test_fail_fast: true,
    });
    mockGetChangedFiles.mockResolvedValue(['package-lock.json']);
    setUpSession('session-full-run');
    const intent = stageTestRequest('session-full-run');

    await routeStageTimeBlock(intent, undefined);

    expect(mockGetChangedFiles).toHaveBeenCalledWith('/tmp/wt', 'dev');
    expect(mockAdmitTestRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: ['npm run test -w packages/backend'],
      }),
    );
  });

  it('falls back to the full test: commands when the scoped expansion leaves nothing to run (e.g. a deletion-only diff)', async () => {
    mockLoadOrchestratorConfig.mockReturnValue({
      test: ['npm run test -w packages/backend'],
      test_scoped: ['npm run test:scoped -- {{changed_files}}'],
      test_full_run_paths: ['package-lock.json'],
      test_timeout_sec: 60,
      test_max_rss_mb: 0,
      test_fail_fast: true,
    });
    // getChangedFiles already filters out paths no longer present in the
    // worktree (e.g. a deletion-only diff) — simulate that by resolving to [].
    mockGetChangedFiles.mockResolvedValue([]);
    setUpSession('session-empty-diff');
    const intent = stageTestRequest('session-empty-diff');

    await routeStageTimeBlock(intent, undefined);

    expect(mockGetChangedFiles).toHaveBeenCalledWith('/tmp/wt', 'dev');
    expect(mockAdmitTestRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: ['npm run test -w packages/backend'],
      }),
    );
  });
});

describe('resolveTestRequestExecutionInputs — base-branch scoping', () => {
  it("diffs against the requesting session's own PR base_branch, not the project's, for a two_tier PR", async () => {
    mockLoadOrchestratorConfig.mockReturnValue({
      test: ['npm run test -w packages/backend'],
      test_scoped: ['npm run test:scoped -- {{changed_files}}'],
      test_full_run_paths: ['package-lock.json'],
      test_timeout_sec: 60,
      test_max_rss_mb: 0,
      test_fail_fast: true,
    });
    mockGetChangedFiles.mockResolvedValue(['packages/backend/src/foo.ts']);
    setUpSession('session-pr-base');
    insertPRForSession('session-pr-base', 501, 'release/1.0');
    const intent = stageTestRequest('session-pr-base');

    await routeStageTimeBlock(intent, undefined);

    expect(mockGetChangedFiles).toHaveBeenCalledWith(
      '/tmp/wt',
      'release/1.0',
    );
  });

  it("falls back to the project's base branch when the session has no PR yet (pre-PR / flat-mode)", async () => {
    mockLoadOrchestratorConfig.mockReturnValue({
      test: ['npm run test -w packages/backend'],
      test_scoped: ['npm run test:scoped -- {{changed_files}}'],
      test_full_run_paths: ['package-lock.json'],
      test_timeout_sec: 60,
      test_max_rss_mb: 0,
      test_fail_fast: true,
    });
    mockGetChangedFiles.mockResolvedValue(['packages/backend/src/foo.ts']);
    setUpSession('session-no-pr');
    const intent = stageTestRequest('session-no-pr');

    await routeStageTimeBlock(intent, undefined);

    expect(mockGetChangedFiles).toHaveBeenCalledWith('/tmp/wt', 'dev');
  });
});
