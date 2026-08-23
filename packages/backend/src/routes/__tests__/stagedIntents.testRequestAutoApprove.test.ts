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
  mockAdmitTestRequest,
  mockGetTaskBackend,
} = vi.hoisted(() => ({
  mockGetProjectById: vi.fn(),
  mockLoadOrchestratorConfig: vi.fn(),
  mockComputeHash: vi.fn(),
  mockAdmitTestRequest: vi.fn(),
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
  admitTestRequest: mockAdmitTestRequest,
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
  getSessionTestRequestCycleCount,
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

/** Default admitTestRequest stub: every call admits fresh (never reused), immediately running. */
function stubFreshAdmission(runId = 'run-preview') {
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
  mockAdmitTestRequest.mockReset();
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
  mockAdmitTestRequest.mockImplementation(() => stubFreshAdmission());
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

  it('a session exceeding the cycle limit keeps auto-approving and records the crossing durably instead of pausing', async () => {
    setUpSession('session-3');

    for (let i = 0; i < 3; i++) {
      const intent = stageTestRequest('session-3');
      const checked = await routeStageTimeBlock(intent, undefined);
      expect(checked.state).toBe('approved');
    }

    // The 4th staged test.request within this session exceeds the limit of 3.
    const overLimit = stageTestRequest('session-3');
    const checkedOverLimit = await routeStageTimeBlock(overLimit, undefined);

    expect(checkedOverLimit.state).toBe('approved');

    const session = db
      .prepare('SELECT pause_reason FROM sessions WHERE session_id = ?')
      .get('session-3') as { pause_reason: string | null };
    expect(session.pause_reason).toBeNull();

    const auditRow = db
      .prepare(
        "SELECT payload FROM audit_log WHERE event_type = 'test_request_cycle_limit_crossed' AND actor_id = ?",
      )
      .get('session-3') as { payload: string } | undefined;
    expect(auditRow).toBeDefined();
    const payload = JSON.parse(auditRow!.payload);
    expect(payload).toEqual({
      session_id: 'session-3',
      cycle_count: 4,
      cycle_limit: 3,
    });
  });

  it('declines and reports — rather than stranding the intent at staged — when the originating session has no resolvable worktree', async () => {
    setUpSession('session-no-worktree', false);
    const intent = stageTestRequest('session-no-worktree');
    const sessionManager = makeSessionManager();
    const warnSpy = vi.spyOn(logger, 'warn');

    const checked = await routeStageTimeBlock(intent, sessionManager);

    expect(checked.state).toBe('rejected');
    expect(mockAdmitTestRequest).not.toHaveBeenCalled();
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledWith(
      'session-no-worktree',
      'test_request',
      JSON.stringify({
        intentId: intent.id,
        passed: false,
        output:
          'test.request decline: originating session has no resolvable worktree',
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
        output: 'test.request decline: worktree content hash unavailable',
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

describe('test.request queue position + session-pending dedupe', () => {
  it('reports the admission (status/position/queueDepth/runId) via the approved annotation', async () => {
    mockAdmitTestRequest.mockImplementation(() => ({
      runId: 'run-queued',
      status: 'queued',
      position: 3,
      queueDepth: 5,
      reused: false,
      result: new Promise(() => {}),
    }));
    setUpSession('session-position');
    const intent = stageTestRequest('session-position');

    const checked = await routeStageTimeBlock(intent, undefined);

    expect(checked.state).toBe('approved');
    expect(checked.annotation).toEqual({
      testRequestQueue: {
        runId: 'run-queued',
        status: 'queued',
        position: 3,
        queueDepth: 5,
        reused: false,
      },
    });
  });

  it('a reused admission (session already has one pending against this tree) does not advance the cycle counter, while a fresh one still does', async () => {
    setUpSession('session-reuse');

    mockAdmitTestRequest.mockImplementationOnce(() =>
      stubFreshAdmission('run-first'),
    );
    const first = stageTestRequest('session-reuse');
    await routeStageTimeBlock(first, undefined);
    expect(getSessionTestRequestCycleCount('session-reuse')).toBe(1);

    mockAdmitTestRequest.mockImplementationOnce(() => ({
      runId: 'run-first',
      status: 'queued',
      position: 1,
      queueDepth: 1,
      reused: true,
      result: Promise.resolve({
        runId: 'run-first',
        passed: true,
        output: 'ok',
        joined: true,
      }),
    }));
    const second = stageTestRequest('session-reuse');
    const checkedSecond = await routeStageTimeBlock(second, undefined);

    // Reused: withdrawn immediately rather than staged as a second live
    // intent — see the locked "stages no new intent" design.
    expect(checkedSecond.state).toBe('withdrawn');
    expect(getSessionTestRequestCycleCount('session-reuse')).toBe(1);
    expect(checkedSecond.annotation).toMatchObject({
      testRequestQueue: { runId: 'run-first', reused: true },
    });

    // A genuinely fresh (non-reused) third request still advances the budget.
    mockAdmitTestRequest.mockImplementationOnce(() =>
      stubFreshAdmission('run-third'),
    );
    const third = stageTestRequest('session-reuse');
    await routeStageTimeBlock(third, undefined);
    expect(getSessionTestRequestCycleCount('session-reuse')).toBe(2);
  });

  it('an unchangedReplay admission (settled-run guard, distinct from a pending-request reuse) does not advance the cycle counter and stages/commits normally rather than withdrawing', async () => {
    setUpSession('session-replay');

    mockAdmitTestRequest.mockImplementationOnce(() => ({
      runId: 'run-settled',
      status: 'running',
      position: 0,
      queueDepth: 0,
      reused: false,
      unchangedReplay: true,
      result: Promise.resolve({
        runId: 'run-settled',
        passed: true,
        output: 'ok',
        joined: false,
        unchangedReplay: true,
      }),
    }));
    const intent = stageTestRequest('session-replay');
    const checked = await routeStageTimeBlock(intent, undefined);

    // Unlike a pending-request reuse, an unchangedReplay answer is not
    // withdrawn — there is no other in-flight execution left to deliver a
    // result later, so this intent itself must commit and deliver it.
    expect(checked.state).toBe('approved');
    expect(checked.annotation).toMatchObject({
      testRequestQueue: { runId: 'run-settled', unchangedReplay: true },
    });
    expect(getSessionTestRequestCycleCount('session-replay')).toBe(0);
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
