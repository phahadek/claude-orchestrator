/**
 * Tests for the AgentSession.recordXDisposition methods that back the MCP
 * verdict-delivery tool surface (mcp/tools/verdictTools.ts). Each method must
 * emit the exact same internal event the retired stdout parser used to emit
 * (dispositions_parsed / verified_flaky_disposition / gate_verify_disposition,
 * see AgentSession.dispositions.test.ts / .verifiedFlaky.test.ts /
 * .gateVerify.test.ts for the parser-driven equivalents). recordReviewDisposition
 * and recordVerifiedFlakyDisposition must be idempotent per (session, item): a
 * same-content repeat call is a dedup no-op, a changed-content repeat call is
 * last-write-wins. recordGateVerifyDisposition is deliberately not deduplicated
 * at this layer — it stages a gate.verify intent (see routes/stagedIntents.ts),
 * and staging's own content-hash dedup governs instead, since a repeat call
 * after an operator pushback must always re-stage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDbQueries } from '../../__tests__/helpers/mockDbQueries';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../db/queries', () =>
  mockDbQueries({
    upsertSessionEvent: vi.fn().mockReturnValue(1),
    updateSessionStatus: vi.fn(),
    markSessionDone: vi.fn(),
    markSessionIdle: vi.fn(),
    getEventsBySession: vi.fn().mockReturnValue([]),
    insertPermissionDenial: vi.fn(),
    upsertPullRequest: vi.fn(),
    incrementTokens: vi.fn(),
    incrementCompactionCount: vi.fn(),
    setContextOccupancy: vi.fn(),
    setSessionModel: vi.fn(),
    setSessionMetadata: vi.fn(),
    getPRBySessionId: vi.fn().mockReturnValue(null),
    setHeadSha: vi.fn(),
    setPauseReason: vi.fn(),
    setSessionPauseReason: vi.fn(),
    insertPauseInterval: vi.fn(),
    getSessionTags: vi.fn().mockReturnValue([]),
    setSessionTags: vi.fn(),
    resetTaskCrashCount: vi.fn(),
    getSession: vi.fn().mockReturnValue(null),
    ackPendingComments: vi.fn(),
    listUndeliveredInboxItems: vi.fn().mockReturnValue([]),
    markInboxItemsDelivered: vi.fn(),
  }),
);

vi.mock('../../config', () => ({
  ALLOWED_TOOLS: [],
  GITHUB_REPO: 'owner/repo',
  BASH_MAX_OUTPUT_LENGTH: 30000,
  BASH_DEFAULT_TIMEOUT_MS: 300000,
  runtimeSettings: { corporate_mode_enabled: false },
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    attachPR: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
  }),
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
  countPushFailureEvents: vi.fn().mockReturnValue(0),
}));

vi.mock('../filePollutionCheck', () => ({
  runFilePollutionCheck: vi.fn().mockResolvedValue({ revertCommitSha: null }),
}));

vi.mock('../../github/PRBodyValidator', () => ({
  validatePRBody: vi.fn().mockReturnValue({ valid: true, missingSections: [] }),
  buildValidationComment: vi.fn().mockReturnValue(''),
}));

vi.mock('../../github/CommitAttributionWatcher', () => ({
  checkCommitAttribution: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../sessionRecovery', () => ({
  recoverSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd === 'git rev-parse HEAD') return 'abc1234567890\n';
    if (cmd === 'git branch --show-current') return 'feature/my-task\n';
    throw new Error(`unexpected execSync: ${cmd}`);
  }),
  execFile: vi.fn((...args: unknown[]) => {
    (args[args.length - 1] as (err: unknown, out: unknown) => void)(null, {
      stdout: '',
      stderr: '',
    });
  }),
  exec: vi.fn((...args: unknown[]) => {
    (args[args.length - 1] as (err: unknown, out: unknown) => void)(null, {
      stdout: '',
      stderr: '',
    });
  }),
}));

vi.mock('../CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockReturnValue(new Promise(() => {})),
    sendMessage: vi.fn(),
    endSession: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    hasSpawnError: false,
  })),
}));

vi.mock('../../db/pauseReason', () => ({
  pauseReasonFromCanonical: vi.fn(),
  serializePauseReason: vi.fn(),
}));

vi.mock('../../routes/stagedIntents', () => ({
  stageIntent: vi.fn(),
}));

vi.mock('../../gate/gateService', () => ({
  getGateItem: vi.fn().mockReturnValue(null),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { AgentSession } from '../AgentSession';
import { getPRBySessionId } from '../../db/queries';
import { stageIntent } from '../../routes/stagedIntents';
import { getGateItem } from '../../gate/gateService';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession() {
  const taskBackend = {
    attachPR: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
  };
  return new AgentSession(
    'test-session-id',
    'https://notion.so/task',
    'https://notion.so/project',
    taskBackend as never,
    '/tmp/worktree',
    'task-123',
    undefined,
    undefined,
    'standard',
    undefined,
    undefined,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPRBySessionId).mockReturnValue(null);
  vi.mocked(getGateItem).mockReturnValue(null);
});

// ── recordReviewDisposition ──────────────────────────────────────────────────

describe('AgentSession.recordReviewDisposition', () => {
  it('emits dispositions_parsed with the same shape the retired parser produced', () => {
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 42,
      repo: 'owner/repo',
    } as never);
    const session = makeSession();
    const emitted: unknown[] = [];
    session.on('dispositions_parsed', (p) => emitted.push(p));

    session.recordReviewDisposition({
      comment_id: 1,
      disposition: 'addressed',
      reason: 'fixed',
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      sessionId: 'test-session-id',
      prNumber: 42,
      repo: 'owner/repo',
      headSha: 'abc1234567890',
      dispositions: [
        { comment_id: 1, disposition: 'addressed', reason: 'fixed' },
      ],
    });
  });

  it('is a no-op when there is no PR for the session', () => {
    const session = makeSession();
    const emitted: unknown[] = [];
    session.on('dispositions_parsed', (p) => emitted.push(p));

    session.recordReviewDisposition({
      comment_id: 1,
      disposition: 'addressed',
    });

    expect(emitted).toHaveLength(0);
  });

  it('is idempotent: an identical repeat call for the same comment_id does not double-emit', () => {
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 42,
      repo: 'owner/repo',
    } as never);
    const session = makeSession();
    const emitted: unknown[] = [];
    session.on('dispositions_parsed', (p) => emitted.push(p));

    const item = {
      comment_id: 1,
      disposition: 'addressed' as const,
      reason: 'fixed',
    };
    session.recordReviewDisposition(item);
    session.recordReviewDisposition({ ...item });

    expect(emitted).toHaveLength(1);
  });

  it('last-write-wins: a changed disposition for the same comment_id re-emits', () => {
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 42,
      repo: 'owner/repo',
    } as never);
    const session = makeSession();
    const emitted: unknown[] = [];
    session.on('dispositions_parsed', (p) => emitted.push(p));

    session.recordReviewDisposition({
      comment_id: 1,
      disposition: 'addressed',
    });
    session.recordReviewDisposition({
      comment_id: 1,
      disposition: 'wont_fix',
      reason: 'changed my mind',
    });

    expect(emitted).toHaveLength(2);
  });

  it('distinct comment_ids each emit independently', () => {
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 42,
      repo: 'owner/repo',
    } as never);
    const session = makeSession();
    const emitted: unknown[] = [];
    session.on('dispositions_parsed', (p) => emitted.push(p));

    session.recordReviewDisposition({
      comment_id: 1,
      disposition: 'addressed',
    });
    session.recordReviewDisposition({ comment_id: 2, disposition: 'wont_fix' });

    expect(emitted).toHaveLength(2);
  });
});

// ── recordVerifiedFlakyDisposition ───────────────────────────────────────────

describe('AgentSession.recordVerifiedFlakyDisposition', () => {
  it('emits verified_flaky_disposition with the same shape the retired parser produced', () => {
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 7,
      repo: 'owner/repo',
    } as never);
    const session = makeSession();
    const emitted: unknown[] = [];
    session.on('verified_flaky_disposition', (p) => emitted.push(p));

    session.recordVerifiedFlakyDisposition({
      gate: 'ci',
      reason: 'ran in isolation, passed clean',
    });

    expect(emitted).toEqual([
      {
        sessionId: 'test-session-id',
        prNumber: 7,
        repo: 'owner/repo',
        headSha: 'abc1234567890',
        disposition: { gate: 'ci', reason: 'ran in isolation, passed clean' },
      },
    ]);
  });

  it('is a no-op when there is no PR for the session', () => {
    const session = makeSession();
    const emitted: unknown[] = [];
    session.on('verified_flaky_disposition', (p) => emitted.push(p));

    session.recordVerifiedFlakyDisposition({ gate: 'f2', reason: 'x' });

    expect(emitted).toHaveLength(0);
  });

  it('is idempotent: an identical repeat call does not double-emit', () => {
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 7,
      repo: 'owner/repo',
    } as never);
    const session = makeSession();
    const emitted: unknown[] = [];
    session.on('verified_flaky_disposition', (p) => emitted.push(p));

    session.recordVerifiedFlakyDisposition({ gate: 'ci', reason: 'same' });
    session.recordVerifiedFlakyDisposition({ gate: 'ci', reason: 'same' });

    expect(emitted).toHaveLength(1);
  });

  it('last-write-wins: a changed disposition re-emits', () => {
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 7,
      repo: 'owner/repo',
    } as never);
    const session = makeSession();
    const emitted: unknown[] = [];
    session.on('verified_flaky_disposition', (p) => emitted.push(p));

    session.recordVerifiedFlakyDisposition({ gate: 'ci', reason: 'first' });
    session.recordVerifiedFlakyDisposition({ gate: 'f2', reason: 'second' });

    expect(emitted).toHaveLength(2);
  });
});

// ── recordGateVerifyDisposition ──────────────────────────────────────────────

function mockFoundGateItem(overrides?: {
  id?: string;
  milestone?: string | null;
}) {
  vi.mocked(getGateItem).mockReturnValue({
    id: overrides?.id ?? 'item-1',
    project: 'proj-1',
    milestone: overrides?.milestone ?? 'milestone-1',
    text: 'does the thing',
    classification: 'Read-Only',
    state: 'runnable',
    updatedAt: new Date().toISOString(),
    sources: [],
    events: [],
  } as never);
}

describe('AgentSession.recordGateVerifyDisposition', () => {
  it('stages a gate.verify intent — never a direct gate_item_event write — and emits gate_verify_disposition unconditionally, with no PR needed', () => {
    mockFoundGateItem();
    const session = makeSession();
    const emitted: unknown[] = [];
    session.on('gate_verify_disposition', (p) => emitted.push(p));

    session.recordGateVerifyDisposition({
      gateItemId: 'item-1',
      disposition: 'pass',
      evidence: { note: 'ok' },
    });

    expect(getPRBySessionId).not.toHaveBeenCalled();
    expect(stageIntent).toHaveBeenCalledTimes(1);
    expect(stageIntent).toHaveBeenCalledWith(
      'gate.verify',
      { gateItemId: 'item-1', disposition: 'pass', evidence: { note: 'ok' } },
      expect.any(String),
      null,
      'test-session-id',
      expect.any(String),
      null,
      null,
      'milestone-1',
      null,
    );
    expect(emitted).toEqual([
      {
        sessionId: 'test-session-id',
        disposition: {
          gateItemId: 'item-1',
          disposition: 'pass',
          evidence: { note: 'ok' },
        },
      },
    ]);
  });

  it("carries the gate item's milestone through to the staged intent when it resolves", () => {
    mockFoundGateItem({ milestone: 'milestone-1' });
    const session = makeSession();

    session.recordGateVerifyDisposition({
      gateItemId: 'item-1',
      disposition: 'pass',
    });

    expect(stageIntent).toHaveBeenCalledWith(
      'gate.verify',
      expect.objectContaining({ gateItemId: 'item-1' }),
      expect.any(String),
      null,
      'test-session-id',
      expect.any(String),
      null,
      null,
      'milestone-1',
      null,
    );
  });

  it('returns the staged intent so the gate.verify MCP tool can echo id + milestone', () => {
    mockFoundGateItem({ milestone: 'milestone-1' });
    vi.mocked(stageIntent).mockReturnValue({
      id: 'staged-42',
      milestone: 'milestone-1',
    } as never);
    const session = makeSession();

    const staged = session.recordGateVerifyDisposition({
      gateItemId: 'item-1',
      disposition: 'pass',
    });

    expect(staged).toEqual({ id: 'staged-42', milestone: 'milestone-1' });
  });

  it('throws rather than staging when gateItemId does not exact-match an existing gate_item (e.g. a short/truncated form)', () => {
    vi.mocked(getGateItem).mockReturnValue(undefined);
    const session = makeSession();

    expect(() =>
      session.recordGateVerifyDisposition({
        gateItemId: 'short-id',
        disposition: 'pass',
      }),
    ).toThrow(/short-id/);
    expect(stageIntent).not.toHaveBeenCalled();
  });

  it("is not deduplicated at the session level: a repeat call — e.g. re-reporting after an operator pushback — re-stages every time (staging's own content-hash dedup governs, not this method)", () => {
    mockFoundGateItem();
    const session = makeSession();
    const emitted: unknown[] = [];
    session.on('gate_verify_disposition', (p) => emitted.push(p));

    session.recordGateVerifyDisposition({
      gateItemId: 'item-1',
      disposition: 'pass',
    });
    session.recordGateVerifyDisposition({
      gateItemId: 'item-1',
      disposition: 'pass',
    });

    expect(stageIntent).toHaveBeenCalledTimes(2);
    expect(emitted).toHaveLength(2);
  });

  it('a changed disposition re-stages and re-emits', () => {
    mockFoundGateItem();
    const session = makeSession();
    const emitted: unknown[] = [];
    session.on('gate_verify_disposition', (p) => emitted.push(p));

    session.recordGateVerifyDisposition({
      gateItemId: 'item-1',
      disposition: 'pass',
    });
    session.recordGateVerifyDisposition({
      gateItemId: 'item-1',
      disposition: 'fail',
    });

    expect(stageIntent).toHaveBeenCalledTimes(2);
    expect(emitted).toHaveLength(2);
  });
});

// ── recordDeployAgenticVerdict ────────────────────────────────────────────────

function makeDeployAgenticSession(taskId: string) {
  const taskBackend = {
    attachPR: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
  };
  return new AgentSession(
    'deploy-sess-1',
    'https://notion.so/task',
    'https://notion.so/project',
    taskBackend as never,
    '/tmp/worktree',
    taskId,
    undefined,
    undefined,
    'ops',
    undefined,
    undefined,
  );
}

describe('AgentSession.recordDeployAgenticVerdict', () => {
  it('recovers runId/stepId from the session task_id and emits deploy_agentic_verdict — never a staged intent', () => {
    const session = makeDeployAgenticSession(
      'deploy-agentic:run-1:investigate',
    );
    const emitted: unknown[] = [];
    session.on('deploy_agentic_verdict', (p) => emitted.push(p));

    session.recordDeployAgenticVerdict({
      verdict: 'approved',
      detail: 'health check passed',
    });

    expect(stageIntent).not.toHaveBeenCalled();
    expect(emitted).toEqual([
      {
        sessionId: 'deploy-sess-1',
        projectId: '',
        runId: 'run-1',
        stepId: 'investigate',
        verdict: 'approved',
        detail: 'health check passed',
      },
    ]);
  });

  it('throws rather than emitting when the session was not dispatched for a deploy-agentic task', () => {
    const session = makeDeployAgenticSession('gate-item:some-id');

    expect(() =>
      session.recordDeployAgenticVerdict({ verdict: 'rejected' }),
    ).toThrow(/not a deploy-agentic task/);
  });
});
