/**
 * Tests for proactive ceiling-escalation in SessionManager._doSendOrResume.
 *
 * When a session's persisted context_occupancy_tokens is at/over the proactive
 * high-water mark (0.9 × 200k = 180k) AND large_task_model is configured AND
 * the session is not already on the large model, sendOrResume must:
 *   1. Call session.setProactiveEscalation(largeModel, nudgeText) instead of
 *      waiting for a first-event to deliver the nudge.
 *   2. Return immediately without awaiting the first 'message' event.
 *
 * No escalation when large_task_model is unset or the session is already on
 * the large model (guards from tryEscalateForOverflow preserved).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerMessage } from '../ws/types';

// ── Hoisted mutable config mock ───────────────────────────────────────────────
// vi.mock factories are hoisted above imports, so top-level variables in the test
// file are not yet initialised when the factory runs. vi.hoisted() runs at hoist
// time and returns a value usable inside vi.mock factories.

const mockRuntimeSettings = vi.hoisted(() => ({
  session_mode: 'cli' as string,
  large_task_model: null as string | null,
  code_session_model: null as string | null,
  auto_launch_poll_interval_ms: 60_000,
}));

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn().mockReturnValue(''),
    exec: vi
      .fn()
      .mockImplementation(
        (
          _cmd: string,
          _opts: unknown,
          cb: (err: null, result: { stdout: string; stderr: string }) => void,
        ) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
        },
      ),
  };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: vi.fn(),
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn().mockReturnValue(''),
      mkdirSync: vi.fn(),
      statSync: vi.fn().mockReturnValue({ isFile: () => false }),
    },
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
    mkdirSync: vi.fn(),
    statSync: vi.fn().mockReturnValue({ isFile: () => false }),
  };
});

vi.mock('../config', () => ({
  config: { maxConcurrentCodeSessions: 10 },
  runtimeSettings: mockRuntimeSettings,
  ALLOWED_TOOLS: [],
  GITHUB_REPO: '',
  getProjectById: vi.fn().mockReturnValue({
    id: 'test-proj',
    name: 'Test Project',
    projectDir: '/tmp/test',
    taskSource: 'notion',
    gitMode: 'local-only',
    autoLaunchEnabled: true,
    baseBranch: 'dev',
    boards: [],
  }),
  normalizePath: (p: string) => p,
}));

vi.mock('../db/queries', () => ({
  insertSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  getPRByNotionTaskId: vi.fn().mockReturnValue(null),
  getSession: vi.fn().mockReturnValue(null),
  insertEvent: vi.fn(),
  getSessionsByStatus: vi.fn().mockReturnValue([]),
  getEventsBySession: vi.fn().mockReturnValue([]),
  getPRByNumber: vi.fn().mockReturnValue(null),
  hasActiveSessionForTask: vi.fn().mockReturnValue(false),
  getSetting: vi.fn().mockReturnValue(null),
  getOtherRunningSessionsForTask: vi.fn().mockReturnValue([]),
  markSessionSuperseded: vi.fn(),
  markSessionDone: vi.fn(),
  updateSessionWorktreePath: vi.fn(),
  incrementTaskCrashCount: vi.fn().mockReturnValue(1),
  setTaskPauseReason: vi.fn(),
}));

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    fetchTaskPage: vi.fn().mockResolvedValue('task content'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../session/orchestrator-config', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    mainBranch: 'main',
    bootstrapScript: null,
    prGate: null,
    bashRules: null,
    allowedTools: [],
    mcp_servers: undefined,
  }),
}));

vi.mock('../session/ContextBuilder', () => ({
  buildSessionContext: vi.fn().mockReturnValue('context'),
}));

vi.mock('../session/orchestrator-claudemd', () => ({
  buildReviewClaudeMd: vi.fn().mockReturnValue('review context'),
}));

vi.mock('../session/branchModel', () => ({
  resolveStartingPoint: vi.fn().mockReturnValue({
    startingPoint: 'dev',
    milestoneSlug: null,
  }),
  ensureMilestoneBranch: vi.fn(),
  slugify: vi
    .fn()
    .mockImplementation((s: string) => s.toLowerCase().replace(/\s+/g, '-')),
  deriveBranchSlug: vi
    .fn()
    .mockImplementation(
      (s: string) => `feature/${s.toLowerCase().replace(/\s+/g, '-')}`,
    ),
}));

vi.mock('../routes/tasks', () => ({
  emitTaskUpdated: vi.fn(),
}));

vi.mock('../notion/NotionClient', () => ({
  parseSection: vi.fn().mockReturnValue(''),
}));

vi.mock('../tasks/TaskStatusEngine', () => ({
  deriveDisplayStatusFromDb: vi.fn().mockReturnValue('starting'),
}));

// CliSessionRunner: never-resolving run() so wireSession's run() emits session_status
// (resolving firstEvent) but never terminates.
vi.mock('../session/CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn(),
    endSession: vi.fn(),
    run: vi.fn().mockReturnValue(new Promise(() => {})),
  })),
}));

vi.mock('../session/ApiSessionRunner', () => ({
  ApiSessionRunner: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn(),
    endSession: vi.fn(),
  })),
}));

vi.mock('../session/DockerSessionRunner', () => ({
  DockerSessionRunner: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn(),
    endSession: vi.fn(),
  })),
  reapOrphanContainers: vi.fn(),
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../config/corporateMode', () => ({
  getCorporateMode: vi
    .fn()
    .mockReturnValue({ gates: { dockerMandatory: false } }),
}));

// ── Imports ────────────────────────────────────────────────────────────────

import { SessionManager, isSessionAtContextCeiling, PROACTIVE_ESCALATION_HWM } from '../session/SessionManager';
import { AgentSession } from '../session/AgentSession';
import * as queries from '../db/queries';

// ── Fixtures ───────────────────────────────────────────────────────────────

const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';
const LARGE_MODEL = 'claude-sonnet-4-6[1m]';
const SMALL_MODEL = 'claude-sonnet-4-6';

function makeSessionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: SESSION_ID,
    task_name: 'my-feature-task',
    task_id: 'notion:task-abc123',
    project_id: 'test-proj',
    status: 'idle',
    session_type: 'standard',
    worktree_path: null,
    pause_reason: null,
    context_occupancy_tokens: 0,
    model: SMALL_MODEL,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRuntimeSettings.large_task_model = null;
  mockRuntimeSettings.code_session_model = null;
  vi.mocked(queries.getSession).mockReturnValue(makeSessionRow() as never);
  vi.mocked(queries.getOtherRunningSessionsForTask).mockReturnValue([]);
});

// ── isSessionAtContextCeiling unit tests ──────────────────────────────────

describe('isSessionAtContextCeiling()', () => {
  beforeEach(() => {
    mockRuntimeSettings.large_task_model = LARGE_MODEL;
  });

  it('returns false when large_task_model is not configured', () => {
    mockRuntimeSettings.large_task_model = null;
    expect(
      isSessionAtContextCeiling({ model: SMALL_MODEL, context_occupancy_tokens: 195_000 }),
    ).toBe(false);
  });

  it('returns false when the session is already on the large model', () => {
    expect(
      isSessionAtContextCeiling({ model: LARGE_MODEL, context_occupancy_tokens: 900_000 }),
    ).toBe(false);
  });

  it('returns false when context_occupancy_tokens is 0 (not yet tracked)', () => {
    expect(
      isSessionAtContextCeiling({ model: SMALL_MODEL, context_occupancy_tokens: 0 }),
    ).toBe(false);
  });

  it('returns false when occupancy is below the HWM', () => {
    const tokens = Math.floor(200_000 * (PROACTIVE_ESCALATION_HWM - 0.01));
    expect(
      isSessionAtContextCeiling({ model: SMALL_MODEL, context_occupancy_tokens: tokens }),
    ).toBe(false);
  });

  it('returns true when occupancy is exactly at the HWM', () => {
    const tokens = Math.floor(200_000 * PROACTIVE_ESCALATION_HWM);
    expect(
      isSessionAtContextCeiling({ model: SMALL_MODEL, context_occupancy_tokens: tokens }),
    ).toBe(true);
  });

  it('returns true when occupancy is above the HWM', () => {
    expect(
      isSessionAtContextCeiling({ model: SMALL_MODEL, context_occupancy_tokens: 195_000 }),
    ).toBe(true);
  });

  it('returns true for a null model (treated as 200k window)', () => {
    expect(
      isSessionAtContextCeiling({ model: null, context_occupancy_tokens: 185_000 }),
    ).toBe(true);
  });
});

// ── SessionManager.sendOrResume — ceiling escalation ─────────────────────

describe('sendOrResume(): proactive ceiling-escalation (worktree-recreation path)', () => {
  beforeEach(() => {
    mockRuntimeSettings.large_task_model = LARGE_MODEL;
    vi.mocked(queries.getSession).mockReturnValue(
      makeSessionRow({ context_occupancy_tokens: 185_000, model: SMALL_MODEL }) as never,
    );
  });

  it('calls setProactiveEscalation on the session when at-ceiling', async () => {
    const spy = vi.spyOn(AgentSession.prototype, 'setProactiveEscalation');

    const sm = new SessionManager();
    await sm.sendOrResume(SESSION_ID, 'open a PR now');

    expect(spy).toHaveBeenCalledOnce();
    const [model, nudge] = spy.mock.calls[0];
    expect(model).toBe(LARGE_MODEL);
    expect(nudge).toContain('open a PR now');
  });

  it('nudge text is included in the escalation nudge message', async () => {
    const spy = vi.spyOn(AgentSession.prototype, 'setProactiveEscalation');

    const sm = new SessionManager();
    const NUDGE = 'You appear to have finished — please open a PR.';
    await sm.sendOrResume(SESSION_ID, NUDGE);

    const [, nudge] = spy.mock.calls[0];
    expect(nudge).toContain(NUDGE);
  });

  it('returns the session ID without waiting for a first-event (resolves immediately)', async () => {
    const sm = new SessionManager();
    // With a non-ceiling session the sendOrResume awaits a 'message' event that
    // CliSessionRunner's never-resolving run() does NOT emit — so the promise
    // would hang. With ceiling detection it should return immediately.
    const result = await sm.sendOrResume(SESSION_ID, 'open a PR');
    expect(result).toBe(SESSION_ID);
  });
});

describe('sendOrResume(): no escalation when large_task_model is unset', () => {
  it('does NOT call setProactiveEscalation when large_task_model is null', async () => {
    mockRuntimeSettings.large_task_model = null;
    vi.mocked(queries.getSession).mockReturnValue(
      makeSessionRow({ context_occupancy_tokens: 195_000 }) as never,
    );

    const spy = vi.spyOn(AgentSession.prototype, 'setProactiveEscalation');

    const sm = new SessionManager();
    await sm.sendOrResume(SESSION_ID, 'nudge');

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('sendOrResume(): no escalation when session is already on the large model', () => {
  it('does NOT call setProactiveEscalation when session.model === large_task_model', async () => {
    mockRuntimeSettings.large_task_model = LARGE_MODEL;
    vi.mocked(queries.getSession).mockReturnValue(
      makeSessionRow({ context_occupancy_tokens: 900_000, model: LARGE_MODEL }) as never,
    );

    const spy = vi.spyOn(AgentSession.prototype, 'setProactiveEscalation');

    const sm = new SessionManager();
    await sm.sendOrResume(SESSION_ID, 'nudge');

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('sendOrResume(): no escalation when occupancy is below the HWM', () => {
  it('does NOT call setProactiveEscalation when context is under the threshold', async () => {
    mockRuntimeSettings.large_task_model = LARGE_MODEL;
    const belowHwm = Math.floor(200_000 * (PROACTIVE_ESCALATION_HWM - 0.05));
    vi.mocked(queries.getSession).mockReturnValue(
      makeSessionRow({ context_occupancy_tokens: belowHwm, model: SMALL_MODEL }) as never,
    );

    const spy = vi.spyOn(AgentSession.prototype, 'setProactiveEscalation');

    const sm = new SessionManager();
    await sm.sendOrResume(SESSION_ID, 'nudge');

    expect(spy).not.toHaveBeenCalled();
  });
});
