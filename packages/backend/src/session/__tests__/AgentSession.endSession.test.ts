/**
 * AgentSession.endSession() delegates to the runner's verify-and-escalate
 * teardown and is responsible for auditing an escalation (naming the
 * session and that the graceful close failed) — the runner itself stays
 * free of any DB/audit dependency.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/queries', async () => {
  const { mockDbQueries } =
    await import('../../__tests__/helpers/mockDbQueries');
  return mockDbQueries({});
});

vi.mock('../../config', () => ({
  ALLOWED_TOOLS: [],
  BASH_MAX_OUTPUT_LENGTH: 30000,
  BASH_DEFAULT_TIMEOUT_MS: 300000,
  GITHUB_REPO: 'owner/repo',
  runtimeSettings: { corporate_mode_enabled: false },
  getProjectById: vi.fn().mockReturnValue(null),
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
  countPushFailureEvents: vi.fn().mockReturnValue(0),
}));

import { AgentSession } from '../AgentSession';
import { recordEvent } from '../../audit/AuditLog';
import type { ISessionRunner } from '../SessionRunner';

function makeFakeRunner(endSessionResult: boolean): ISessionRunner {
  return {
    run: vi.fn().mockReturnValue(new Promise(() => {})),
    sendMessage: vi.fn(),
    endSession: vi.fn().mockResolvedValue(endSessionResult),
    kill: vi.fn().mockResolvedValue(undefined),
    hasSpawnError: false,
  };
}

function makeSession(runner: ISessionRunner): AgentSession {
  const taskBackend = {
    attachPR: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
  };
  return new AgentSession(
    'test-end-session',
    'https://notion.so/task',
    'https://notion.so/project',
    taskBackend as never,
    '/fake/worktree',
    'task-123',
    undefined,
    undefined,
    'standard',
    undefined,
    undefined,
    [],
    undefined,
    runner,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AgentSession.endSession — audits only on escalation', () => {
  it('does not record an audit event when the runner reports a clean exit (no escalation)', async () => {
    const runner = makeFakeRunner(false);
    const session = makeSession(runner);

    await session.endSession();

    expect(runner.endSession).toHaveBeenCalledTimes(1);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('records a session_teardown_escalated audit event naming the session when the runner had to escalate', async () => {
    const runner = makeFakeRunner(true);
    const session = makeSession(runner);

    await session.endSession();

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'session_teardown_escalated',
        actor_type: 'system',
        actor_id: 'test-end-session',
        payload: expect.objectContaining({
          sessionId: 'test-end-session',
          reason: 'graceful_stdin_close_timed_out',
        }),
      }),
    );
  });
});

describe('AgentSession.reclaimProcess — reclaims the OS process without concluding the session', () => {
  it("sets hasEnded so run()'s exit-handling never writes a terminal status once the process exits", async () => {
    const runner = makeFakeRunner(false);
    const session = makeSession(runner);

    expect(session.hasEnded).toBe(false);
    await session.reclaimProcess();

    expect(runner.endSession).toHaveBeenCalledWith(false);
    expect(session.hasEnded).toBe(true);
  });

  it('does not record an audit event when the runner reports a clean exit (no escalation)', async () => {
    const runner = makeFakeRunner(false);
    const session = makeSession(runner);

    await session.reclaimProcess();

    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('still records session_teardown_escalated when the graceful close does not land in time', async () => {
    const runner = makeFakeRunner(true);
    const session = makeSession(runner);

    await session.reclaimProcess();

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'session_teardown_escalated',
        actor_type: 'system',
        actor_id: 'test-end-session',
        payload: expect.objectContaining({
          sessionId: 'test-end-session',
          reason: 'graceful_stdin_close_timed_out',
          concludedCleanly: false,
        }),
      }),
    );
  });
});
