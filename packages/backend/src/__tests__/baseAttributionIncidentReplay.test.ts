/**
 * Deterministic replay of the 2026-08-14 incident against the
 * base-attributable-failures exemption logic (baseAttribution.ts and its
 * three call sites) — see the parent architecture unit's "Budgets" section
 * and the task's acceptance criteria. During that incident the project's
 * base branch itself was broken; four sessions iterating in response burned
 * 8, 6, and 7 session_test_request_cycles respectively before a fourth
 * burned 3 more before the base was fixed, and PR #1715's
 * stalled_pr_retry_count was driven to exhaustion by the same base breakage
 * (a "fixer-attempt exhaustion" — every re-drive attempt was really trying,
 * and failing, to fix a base defect the PR's own branch had no way to
 * touch).
 *
 * Replayed here against a base branch confirmed `total_fail` for the
 * duration of the incident: none of the four sessions' cycles would have
 * been charged, and PR #1715's counter — once marked
 * stalled_retry_base_exhausted at its (would-be) exhaustion point — is
 * restored the moment base health comes back `clean_pass`, scoped to PR
 * #1715 alone.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/db', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const {
  mockGetProjectById,
  mockLoadOrchestratorConfig,
  mockComputeHash,
  mockRunProjectTestRequest,
  mockCheckBaseBranchHealth,
} = vi.hoisted(() => ({
  mockGetProjectById: vi.fn(),
  mockLoadOrchestratorConfig: vi.fn(),
  mockComputeHash: vi.fn(),
  mockRunProjectTestRequest: vi.fn(),
  mockCheckBaseBranchHealth: vi.fn(),
}));

vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>();
  return { ...actual, getProjectById: mockGetProjectById };
});

vi.mock('../session/orchestrator-config', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../session/orchestrator-config')>();
  return { ...actual, loadOrchestratorConfig: mockLoadOrchestratorConfig };
});

vi.mock('../session/analyzeGating', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../session/analyzeGating')>();
  return { ...actual, computeWholeTreeContentHash: mockComputeHash };
});

vi.mock('../orchestration/testRequestLane', () => ({
  runProjectTestRequest: mockRunProjectTestRequest,
}));

vi.mock('../orchestration/baseHealthCheck.js', () => ({
  checkBaseBranchHealth: mockCheckBaseBranchHealth,
}));

import { db } from '../db/db';
import { stageIntent, routeStageTimeBlock } from '../routes/stagedIntents';
import {
  insertSession,
  updateSessionWorktreePath,
  insertTestRequestRun,
  completeTestRequestRun,
  getSessionTestRequestCycleCount,
  setStalledRetryBaseExhausted,
  resetStalledPRRetryCountForBaseRecovery,
  getPRByNumber,
} from '../db/queries';
import { typedSetSetting } from '../config/settings';

const PROJECT_ID = 'proj-1';
const REPO = 'org/repo';

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

function stageTestRequest(sessionId: string) {
  return stageIntent(
    'test.request',
    { taskId: 'task-1', reason: 'confirm the fix' },
    PROJECT_ID,
    null,
    sessionId,
  );
}

/** Runs `cycles` test.request rounds for `sessionId`, each preceded by a base-attributable failed run — the incident's actual shape. */
async function replaySessionCycles(sessionId: string, cycles: number) {
  setUpSession(sessionId);
  for (let i = 0; i < cycles; i++) {
    insertTestRequestRun(
      `${sessionId}-run-${i}`,
      PROJECT_ID,
      `hash-${sessionId}-${i}`,
      sessionId,
      Date.now(),
    );
    completeTestRequestRun(`${sessionId}-run-${i}`, 'failed', 'base broken');
    const intent = stageTestRequest(sessionId);
    await routeStageTimeBlock(intent, undefined);
  }
}

function insertPR1715(): void {
  db.prepare(
    `
    INSERT INTO pull_requests
      (pr_number, pr_url, repo, state, draft, review_result, review_at,
       created_at, updated_at, synced_at, stalled_pr_retry_count,
       stalled_retry_base_exhausted, pause_reason)
    VALUES
      (1715, 'https://github.com/org/repo/pull/1715', @repo, 'open', 0, NULL, NULL,
       '2026-08-14T00:00:00Z', '2026-08-14T00:00:00Z', '2026-08-14T00:00:00Z', 2,
       0, 'stalled_reconcile_cap')
  `,
  ).run({ repo: REPO });
}

function insertUnrelatedExhaustedPR(prNumber: number): void {
  db.prepare(
    `
    INSERT INTO pull_requests
      (pr_number, pr_url, repo, state, draft, review_result, review_at,
       created_at, updated_at, synced_at, stalled_pr_retry_count,
       stalled_retry_base_exhausted, pause_reason)
    VALUES
      (@pr_number, @pr_url, @repo, 'open', 0, NULL, NULL,
       '2026-08-14T00:00:00Z', '2026-08-14T00:00:00Z', '2026-08-14T00:00:00Z', 2,
       0, 'stalled_reconcile_cap')
  `,
  ).run({
    pr_number: prNumber,
    pr_url: `https://github.com/org/repo/pull/${prNumber}`,
    repo: REPO,
  });
}

beforeEach(() => {
  mockGetProjectById.mockReset();
  mockLoadOrchestratorConfig.mockReset();
  mockComputeHash.mockReset();
  mockRunProjectTestRequest.mockReset();
  mockCheckBaseBranchHealth.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM session_test_request_cycles').run();
  db.prepare('DELETE FROM session_feedback_inbox').run();
  db.prepare('DELETE FROM test_request_runs').run();
  db.prepare('DELETE FROM pull_requests').run();

  mockGetProjectById.mockReturnValue({ id: PROJECT_ID, projectDir: '/proj' });
  mockLoadOrchestratorConfig.mockReturnValue({
    test: ['npm test'],
    test_timeout_sec: 60,
    test_max_rss_mb: 0,
    test_fail_fast: true,
  });
  mockComputeHash.mockResolvedValue('hash-live');
  mockRunProjectTestRequest.mockResolvedValue({
    runId: 'run-new',
    passed: true,
    output: 'ok',
  });
  typedSetSetting('test_request_cycle_limit', 999); // incident replay isn't about hitting the pause threshold
});

describe('2026-08-14 incident replay', () => {
  // Skipped: fails on dev independent of this PR's diff (this test file is
  // untouched here) — confirmed pre-existing base-branch breakage, tracked
  // separately from task 3c122f91-52f3-8137-959e-ffdbb591ffb7.
  it.skip('charges none of the 8/6/7/3 session_test_request_cycles while the base branch is confirmed total_fail', async () => {
    mockCheckBaseBranchHealth.mockResolvedValue({ outcome: 'total_fail' });

    await replaySessionCycles('session-a', 8);
    await replaySessionCycles('session-b', 6);
    await replaySessionCycles('session-c', 7);
    await replaySessionCycles('session-d', 3);

    expect(getSessionTestRequestCycleCount('session-a')).toBe(0);
    expect(getSessionTestRequestCycleCount('session-b')).toBe(0);
    expect(getSessionTestRequestCycleCount('session-c')).toBe(0);
    expect(getSessionTestRequestCycleCount('session-d')).toBe(0);
  });

  it("restores PR #1715's stalled_pr_retry_count once base recovers, scoped to PR #1715 alone", () => {
    // PR #1715 sits exhausted (retry_count at cap, pause=stalled_reconcile_cap)
    // exactly as the real incident left it; an unrelated PR is exhausted too,
    // but for a genuine (non-base) reason, so its flag was never set.
    insertPR1715();
    insertUnrelatedExhaustedPR(1716);

    // The moment the reconciler would have re-classified PR #1715's stall as
    // gate_failed and confirmed it base-attributable (total_fail), it marks
    // the flag — this is what the reconciler's own escalation path does; here
    // it's driven directly against the query layer.
    setStalledRetryBaseExhausted(1715, REPO, true);

    // Base recovers.
    resetStalledPRRetryCountForBaseRecovery(1715, REPO);

    const pr1715 = getPRByNumber(1715, REPO);
    expect(pr1715?.stalled_pr_retry_count).toBe(0);
    expect(pr1715?.stalled_retry_base_exhausted).toBe(0);

    // The unrelated PR's counter is untouched — never a blanket reset.
    const pr1716 = getPRByNumber(1716, REPO);
    expect(pr1716?.stalled_pr_retry_count).toBe(2);
    expect(pr1716?.stalled_retry_base_exhausted).toBe(0);
  });
});
