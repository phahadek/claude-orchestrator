/**
 * Stage-time mechanical auto-grant for test.request — routeStageTimeBlock's
 * maybeAutoApproveTestRequest. Unlike gate.accrete/seed.stage's own-payload
 * content match, this never trusts a session-asserted claim: it recomputes a
 * project-scoped whole-tree content hash off the requesting session's live
 * worktree. Also covers the per-session cycle-counter escalation, and the
 * decline-and-report path a structural failure (no test: commands, no
 * resolvable worktree, no content hash) now takes instead of stranding the
 * intent at `staged` where no disposition can ever resolve it.
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
  mockRunProjectTestRequest,
  mockGetTaskBackend,
} = vi.hoisted(() => ({
  mockGetProjectById: vi.fn(),
  mockLoadOrchestratorConfig: vi.fn(),
  mockComputeHash: vi.fn(),
  mockRunProjectTestRequest: vi.fn(),
  mockGetTaskBackend: vi.fn(),
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

vi.mock('../../orchestration/testRequestLane', () => ({
  runProjectTestRequest: mockRunProjectTestRequest,
}));

vi.mock('../../tasks/TaskBackend', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../tasks/TaskBackend')>();
  return { ...actual, getTaskBackend: mockGetTaskBackend };
});

import { db } from '../../db/db';
import {
  stageIntent,
  routeStageTimeBlock,
  commitGroupIntents,
} from '../stagedIntents';
import {
  insertSession,
  updateSessionWorktreePath,
  setStagedIntentGroup,
  transitionStagedIntent,
} from '../../db/queries';
import { typedSetSetting } from '../../config/settings';
import { logger } from '../../logger';

function setUpSession(sessionId: string, withWorktree = true) {
  insertSession({
    session_id: sessionId,
    task_id: 'task-1',
    task_url: null,
    project_context_url: null,
    status: 'running',
    started_at: Date.now(),
  });
  if (withWorktree) updateSessionWorktreePath(sessionId, '/tmp/wt');
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

function makeSessionManager() {
  return {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  } as unknown as import('../../session/SessionManager').SessionManager & {
    enqueueFeedback: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  mockGetProjectById.mockReset();
  mockLoadOrchestratorConfig.mockReset();
  mockComputeHash.mockReset();
  mockRunProjectTestRequest.mockReset();
  mockGetTaskBackend.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM session_test_request_cycles').run();
  db.prepare('DELETE FROM session_feedback_inbox').run();

  mockGetProjectById.mockReturnValue({ id: 'proj-1', projectDir: '/proj' });
  mockLoadOrchestratorConfig.mockReturnValue({
    test: ['npm test'],
    test_timeout_sec: 60,
    test_max_rss_mb: 0,
    test_fail_fast: true,
  });
  mockComputeHash.mockResolvedValue('hash-1');
  mockRunProjectTestRequest.mockResolvedValue({ passed: true, output: 'ok' });
  typedSetSetting('test_request_cycle_limit', 3);
});

describe('test.request stage-time refusal (stageIntent)', () => {
  it('refuses at stage time — before the row ever reaches `staged` — when the project has no test: commands configured', () => {
    mockLoadOrchestratorConfig.mockReturnValue({
      test: [],
      test_timeout_sec: 60,
      test_max_rss_mb: 0,
      test_fail_fast: true,
    });
    setUpSession('session-refuse');

    expect(() => stageTestRequest('session-refuse')).toThrow(
      /has no test: commands configured/,
    );
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM staged_intent').get() as {
        n: number;
      },
    ).toEqual({ n: 0 });
  });
});

describe('test.request stage-time auto-grant (routeStageTimeBlock)', () => {
  it('auto-transitions staged -> approved for a project with test: configured on a matching content-hash', async () => {
    setUpSession('session-1');
    const intent = stageTestRequest('session-1');
    expect(intent.state).toBe('staged');

    const checked = await routeStageTimeBlock(intent, undefined);

    expect(checked.state).toBe('approved');
    expect(mockComputeHash).toHaveBeenCalledWith('/tmp/wt');
  });

  it('a session exceeding the cycle limit is paused instead of further auto-running (and is not converted into a rejection)', async () => {
    setUpSession('session-3');

    for (let i = 0; i < 3; i++) {
      const intent = stageTestRequest('session-3');
      const checked = await routeStageTimeBlock(intent, undefined);
      expect(checked.state).toBe('approved');
    }

    // The 4th staged test.request within this session exceeds the limit of 3.
    const overLimit = stageTestRequest('session-3');
    const checkedOverLimit = await routeStageTimeBlock(overLimit, undefined);

    expect(checkedOverLimit.state).toBe('staged');

    const session = db
      .prepare('SELECT pause_reason FROM sessions WHERE session_id = ?')
      .get('session-3') as { pause_reason: string | null };
    expect(session.pause_reason).toBe('test_request_cycle_exceeded');
  });

  it('declines and reports — rather than stranding the intent at staged — when the originating session has no resolvable worktree', async () => {
    setUpSession('session-no-worktree', false);
    const intent = stageTestRequest('session-no-worktree');
    const sessionManager = makeSessionManager();
    const warnSpy = vi.spyOn(logger, 'warn');

    const checked = await routeStageTimeBlock(intent, sessionManager);

    expect(checked.state).toBe('rejected');
    expect(mockRunProjectTestRequest).not.toHaveBeenCalled();
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledWith(
      'session-no-worktree',
      'test_request',
      JSON.stringify({
        intentId: intent.id,
        passed: false,
        output:
          'test.request declined: originating session has no resolvable worktree',
      }),
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [warnMessage] = warnSpy.mock.calls[0];
    expect(warnMessage).toContain(intent.id);
    expect(warnMessage).toContain('no resolvable worktree');
    warnSpy.mockRestore();
  });

  it('declines and reports when the worktree content hash is unavailable', async () => {
    mockComputeHash.mockResolvedValue(null);
    setUpSession('session-no-hash');
    const intent = stageTestRequest('session-no-hash');
    const sessionManager = makeSessionManager();

    const checked = await routeStageTimeBlock(intent, sessionManager);

    expect(checked.state).toBe('rejected');
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledWith(
      'session-no-hash',
      'test_request',
      JSON.stringify({
        intentId: intent.id,
        passed: false,
        output: 'test.request declined: worktree content hash unavailable',
      }),
    );
  });

  it('declines and reports when the intent has no originating session', async () => {
    const intent = stageIntent(
      'test.request',
      { taskId: 'task-1', reason: 'confirm the fix' },
      'proj-1',
      null,
      null,
    );
    const sessionManager = makeSessionManager();

    const checked = await routeStageTimeBlock(intent, sessionManager);

    expect(checked.state).toBe('rejected');
    expect(sessionManager.enqueueFeedback).not.toHaveBeenCalled();
  });

  it("a structurally-declined test.request never appears among a project's active staged intents", async () => {
    setUpSession('session-no-worktree-2', false);
    const intent = stageTestRequest('session-no-worktree-2');
    const sessionManager = makeSessionManager();

    await routeStageTimeBlock(intent, sessionManager);

    const active = db
      .prepare(
        "SELECT id FROM staged_intent WHERE project_id = 'proj-1' AND state IN ('staged','approved')",
      )
      .all();
    expect(active).toEqual([]);
  });
});

describe('applyIntent defence-in-depth for a stray grouped test.request', () => {
  it('returns a typed "not operator-appliable" error instead of the generic unknown-kind throw', async () => {
    mockGetTaskBackend.mockReturnValue({ type: 'yaml' });
    setUpSession('session-group');
    const intent = stageTestRequest('session-group');
    // test.request refuses grouping at stage time; force one into a group
    // to exercise applyIntent's defence-in-depth directly, the way a stray
    // row from an unforeseen future path would reach the group-commit loop.
    setStagedIntentGroup(intent.id, 'group-stray-test-request');
    transitionStagedIntent(intent.id, 'approved');

    const result = await commitGroupIntents('group-stray-test-request', {
      override: false,
      reason: '',
      actorType: 'human',
    });

    expect(result.status).toBe(409);
    expect(String(result.body.error)).toContain('not operator-appliable');
    expect(String(result.body.error)).not.toContain('unknown intent kind');
  });
});
