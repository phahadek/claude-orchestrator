/**
 * Behavioral unit tests for the ZDR gate in SessionManager.start().
 * Mocks all I/O (git, fs, db, corporateMode) and exercises the runtime
 * code path — not source-text scanning.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Prevent real git/fs operations ──────────────────────────────────────────

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn().mockReturnValue('dev\n'),
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
      statSync: vi.fn().mockReturnValue({ isFile: () => false }),
    },
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
    statSync: vi.fn().mockReturnValue({ isFile: () => false }),
  };
});

// ── Config / DB mocks ────────────────────────────────────────────────────────

vi.mock('../config', () => ({
  config: { maxConcurrentCodeSessions: 10 },
  runtimeSettings: { session_mode: 'cli' },
  getProjectById: vi.fn(),
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
  getStuckResultSessionRows: vi.fn().mockReturnValue([]),
  hasActiveSessionForTask: vi.fn().mockReturnValue(false),
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
    bootstrap_script: null,
    prGate: null,
    bashRules: null,
    allowedTools: [],
  }),
}));

vi.mock('../session/ContextBuilder', () => ({
  buildSessionContext: vi.fn().mockReturnValue('context'),
}));

vi.mock('../session/orchestrator-claudemd', () => ({
  buildReviewClaudeMd: vi.fn().mockReturnValue('review context'),
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

vi.mock('../session/CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn(),
    endSession: vi.fn(),
  })),
}));

vi.mock('../session/ApiSessionRunner', () => ({
  ApiSessionRunner: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn(),
    endSession: vi.fn(),
  })),
}));

vi.mock(import('../session/AgentSession'), async (importOriginal) => {
  const actual = await importOriginal();
  const AgentSession = vi
    .fn()
    .mockImplementation(
      (
        _sid: string,
        _url: string,
        _ctx: string,
        _override: unknown,
        _wt: string,
        _tid: string,
        _resume: string,
        _prompt: string,
        sessionType: string,
      ) => ({
        sessionType: sessionType ?? 'standard',
        taskId: null,
        prUrl: null,
        hasEnded: true,
        on: vi.fn(),
        run: vi.fn().mockReturnValue(new Promise(() => {})),
      }),
    );
  return {
    ...actual,
    AgentSession,
  };
});

vi.mock('../config/corporateMode', () => ({
  getCorporateMode: vi.fn(),
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { SessionManager } from '../session/SessionManager';
import { getProjectById } from '../config';
import { getCorporateMode } from '../config/corporateMode';
import { recordEvent } from '../audit/AuditLog';

// ── Shared helpers ───────────────────────────────────────────────────────────

const TASK_URL =
  'https://www.notion.so/Test-Task-abc123def456789012345678901234';
const CTX_URL = 'https://notion.so/context';
const PROJECT_ID = 'test-proj';

function makeProject(dataResidencyConfirmed: boolean) {
  return {
    id: PROJECT_ID,
    name: 'Test Project',
    projectDir: '/tmp/test',
    taskSource: 'yaml',
    gitMode: 'github',
    autoLaunchEnabled: false,
    autoLaunchMilestoneId: null,
    autoMergeEnabled: false,
    dataResidencyConfirmed,
    boards: [],
  };
}

function corporateModeOn() {
  return {
    enabled: true,
    envLocked: false,
    gates: {
      dockerMandatory: true,
      requireHumanApproval: true,
      requireZDR: true,
      validatePRBody: true,
      secretsViaSeam: true,
    },
  };
}

function corporateModeOff() {
  return {
    enabled: false,
    envLocked: false,
    gates: {
      dockerMandatory: false,
      requireHumanApproval: false,
      requireZDR: false,
      validatePRBody: false,
      secretsViaSeam: false,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Behavioral tests ─────────────────────────────────────────────────────────

describe('SessionManager.start() ZDR gate — corporate mode, data_residency_confirmed=false REFUSES', () => {
  beforeEach(() => {
    vi.mocked(getCorporateMode).mockReturnValue(corporateModeOn());
    vi.mocked(getProjectById).mockReturnValue(makeProject(false) as never);
  });

  it('throws synchronously with a ZDR error message', () => {
    const sm = new SessionManager();
    expect(() =>
      sm.start(TASK_URL, CTX_URL, {
        sessionType: 'standard',
        projectId: PROJECT_ID,
        taskKind: 'milestone',
      }),
    ).toThrow(/Session launch refused/);
  });

  it('error message mentions Zero Data Retention or ZDR', () => {
    const sm = new SessionManager();
    expect(() =>
      sm.start(TASK_URL, CTX_URL, {
        sessionType: 'standard',
        projectId: PROJECT_ID,
        taskKind: 'milestone',
      }),
    ).toThrow(/Zero Data Retention|ZDR/);
  });

  it('records a session_launch_refused_zdr audit event', () => {
    const sm = new SessionManager();
    try {
      sm.start(TASK_URL, CTX_URL, {
        sessionType: 'standard',
        projectId: PROJECT_ID,
        taskKind: 'milestone',
      });
    } catch {
      // expected
    }
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'session_launch_refused_zdr' }),
    );
  });
});

describe('SessionManager.start() ZDR gate — corporate mode, data_residency_confirmed=true PROCEEDS', () => {
  beforeEach(() => {
    vi.mocked(getCorporateMode).mockReturnValue(corporateModeOn());
    vi.mocked(getProjectById).mockReturnValue(makeProject(true) as never);
  });

  it('does not throw and returns a session ID string', () => {
    const sm = new SessionManager();
    let sessionId: string | undefined;
    expect(() => {
      sessionId = sm.start(TASK_URL, CTX_URL, {
        sessionType: 'standard',
        projectId: PROJECT_ID,
        taskKind: 'milestone',
      });
    }).not.toThrow();
    expect(typeof sessionId).toBe('string');
  });

  it('does not call recordEvent with session_launch_refused_zdr', () => {
    const sm = new SessionManager();
    sm.start(TASK_URL, CTX_URL, {
      sessionType: 'standard',
      projectId: PROJECT_ID,
      taskKind: 'milestone',
    });
    const refusalCalls = vi
      .mocked(recordEvent)
      .mock.calls.filter(
        (args) =>
          (args[0] as { event_type: string }).event_type ===
          'session_launch_refused_zdr',
      );
    expect(refusalCalls).toHaveLength(0);
  });
});

describe('SessionManager.start() ZDR gate — non-corporate mode, flag NOT checked', () => {
  beforeEach(() => {
    vi.mocked(getCorporateMode).mockReturnValue(corporateModeOff());
    vi.mocked(getProjectById).mockReturnValue(makeProject(false) as never);
  });

  it('proceeds even when data_residency_confirmed=false in non-corporate mode', () => {
    const sm = new SessionManager();
    expect(() =>
      sm.start(TASK_URL, CTX_URL, {
        sessionType: 'standard',
        projectId: PROJECT_ID,
        taskKind: 'milestone',
      }),
    ).not.toThrow();
  });

  it('does not record a session_launch_refused_zdr event', () => {
    const sm = new SessionManager();
    sm.start(TASK_URL, CTX_URL, {
      sessionType: 'standard',
      projectId: PROJECT_ID,
      taskKind: 'milestone',
    });
    const refusalCalls = vi
      .mocked(recordEvent)
      .mock.calls.filter(
        (args) =>
          (args[0] as { event_type: string }).event_type ===
          'session_launch_refused_zdr',
      );
    expect(refusalCalls).toHaveLength(0);
  });
});
