import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('child_process', () => ({
  spawn: vi.fn().mockReturnValue({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { write: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
    pid: 12345,
    exitCode: null,
  }),
  execSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('../../db/queries', () => ({
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
  setSessionModelSettingKey: vi.fn(),
  setSessionEffortSettingKey: vi.fn(),
  setSessionMetadata: vi.fn(),
  getPRBySessionId: vi.fn().mockReturnValue(null),
  setHeadSha: vi.fn(),
  setPauseReason: vi.fn(),
  insertPauseInterval: vi.fn(),
  setSessionPauseReason: vi.fn(),
  getSessionTags: vi.fn().mockReturnValue([]),
  setSessionTags: vi.fn(),
}));

vi.mock('../../config', () => ({
  ALLOWED_TOOLS: [],
  BASH_MAX_OUTPUT_LENGTH: 30000,
  BASH_DEFAULT_TIMEOUT_MS: 300000,
  GITHUB_REPO: 'owner/repo',
  runtimeSettings: { corporate_mode_enabled: false },
  getProjectById: vi.fn().mockReturnValue(null),
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

vi.mock('../CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockReturnValue(new Promise(() => {})),
    sendMessage: vi.fn(),
    endSession: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../SessionAuditor', () => ({
  detectInFlightEscape: vi
    .fn()
    .mockReturnValue({ violations: [], specMismatch: null }),
}));

vi.mock('../../utils/eventFilters', () => ({
  isSystemOnlyUserEvent: vi.fn().mockReturnValue(false),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  AgentSession,
  isMcpUnreachable,
  getOrchestratorMcpStatus,
} from '../AgentSession';
import { setSessionPauseReason, insertPauseInterval } from '../../db/queries';
import { recordEvent } from '../../audit/AuditLog';

// ── Pure predicate tests ──────────────────────────────────────────────────────

describe('isMcpUnreachable', () => {
  const GRACE_MS = 3 * 60_000;

  it('is false once a connection was established since the last spawn', () => {
    expect(
      isMcpUnreachable({
        hasConnectedSinceSpawn: true,
        nowMs: 1_000_000,
        lastSpawnMs: 0,
        graceMs: GRACE_MS,
      }),
    ).toBe(false);
  });

  it('is false inside the startup grace window', () => {
    expect(
      isMcpUnreachable({
        hasConnectedSinceSpawn: false,
        nowMs: GRACE_MS - 1,
        lastSpawnMs: 0,
        graceMs: GRACE_MS,
      }),
    ).toBe(false);
  });

  it('is true once the grace window has elapsed with no connection', () => {
    expect(
      isMcpUnreachable({
        hasConnectedSinceSpawn: false,
        nowMs: GRACE_MS,
        lastSpawnMs: 0,
        graceMs: GRACE_MS,
      }),
    ).toBe(true);
  });
});

describe('getOrchestratorMcpStatus', () => {
  it('returns the orchestrator entry status', () => {
    expect(
      getOrchestratorMcpStatus({
        mcp_servers: [
          { name: 'notion', status: 'connected' },
          { name: 'orchestrator', status: 'failed' },
        ],
      }),
    ).toBe('failed');
  });

  it('returns undefined when there is no orchestrator entry', () => {
    expect(
      getOrchestratorMcpStatus({
        mcp_servers: [{ name: 'notion', status: 'failed' }],
      }),
    ).toBeUndefined();
  });

  it('returns undefined when mcp_servers is missing', () => {
    expect(getOrchestratorMcpStatus({})).toBeUndefined();
  });

  it('returns undefined when mcp_servers is malformed', () => {
    expect(
      getOrchestratorMcpStatus({ mcp_servers: 'not-an-array' }),
    ).toBeUndefined();
    expect(
      getOrchestratorMcpStatus({ mcp_servers: [null, 42, { name: 'x' }] }),
    ).toBeUndefined();
  });
});

// ── Init-event pause behavior ─────────────────────────────────────────────────

const WORKTREE = '/fake/worktree';

function makeCodeSession(): AgentSession {
  const taskBackend = {
    attachPR: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
  };
  return new AgentSession(
    'test-mcp-init',
    'https://notion.so/task',
    'https://notion.so/project',
    taskBackend as never,
    WORKTREE,
    'task-123',
    undefined,
    undefined,
    'standard',
  );
}

function feedInitEvent(
  session: AgentSession,
  mcpServers: unknown,
): void {
  (
    session as unknown as {
      handleRawEvent(event: Record<string, unknown>): void;
    }
  ).handleRawEvent({
    type: 'system',
    subtype: 'init',
    permissionMode: 'default',
    mcp_servers: mcpServers,
  });
}

describe('AgentSession init event — orchestrator MCP status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pauses a coding session whose orchestrator entry reports a non-connected status', () => {
    const session = makeCodeSession();
    feedInitEvent(session, [
      { name: 'notion', status: 'connected' },
      { name: 'orchestrator', status: 'failed' },
    ]);

    expect(setSessionPauseReason).toHaveBeenCalledWith(
      'test-mcp-init',
      'orchestrator_mcp_connect_failed',
    );
    expect(insertPauseInterval).toHaveBeenCalledWith(
      'test-mcp-init',
      'orchestrator_mcp_connect_failed',
    );
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'session_orchestrator_mcp_connect_failed',
        payload: expect.objectContaining({
          server: 'orchestrator',
          status: 'failed',
        }),
      }),
    );
  });

  it('does not pause when the orchestrator entry reports connected', () => {
    const session = makeCodeSession();
    feedInitEvent(session, [
      { name: 'notion', status: 'failed' },
      { name: 'orchestrator', status: 'connected' },
    ]);

    expect(setSessionPauseReason).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'session_orchestrator_mcp_connect_failed',
      }),
    );
  });

  it('does not throw and does not pause on a malformed mcp_servers payload', () => {
    const session = makeCodeSession();
    expect(() => feedInitEvent(session, undefined)).not.toThrow();
    expect(() => feedInitEvent(session, 'garbage')).not.toThrow();

    expect(setSessionPauseReason).not.toHaveBeenCalled();
  });
});
