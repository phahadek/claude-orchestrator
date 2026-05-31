/**
 * Behavioral tests: SessionManager error broadcast and rollback on launch failure.
 * Tests stub updateStatus/AgentSession to throw and verify runtime emit('message')
 * behavior — no source-text scanning.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerMessage } from '../ws/types';

// child_process: prevent real git operations
vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue('dev\n'),
}));

// fs: prevent real file writes
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

vi.mock('../config', () => ({
  config: { maxConcurrentCodeSessions: 10 },
  runtimeSettings: { session_mode: 'cli' },
  getProjectById: vi.fn().mockReturnValue({
    id: 'test-proj',
    name: 'Test Project',
    projectDir: '/tmp/test',
    taskSource: 'yaml',
    autoLaunchEnabled: true,
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

vi.mock('../session/AgentSession', () => {
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
    AgentSession,
    parseNotionPageIdDashed: vi.fn().mockImplementation((url: string) => {
      const segment = url.split('/').pop() ?? url;
      const raw = segment
        .replace(/[^a-f0-9]/gi, '')
        .slice(-32)
        .padEnd(32, '0');
      return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
    }),
  };
});

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

import { SessionManager } from '../session/SessionManager';
import { AgentSession } from '../session/AgentSession';
import { getTaskBackend } from '../tasks/TaskBackend';
import * as queries from '../db/queries';

const YAML_TASK_ID = 't2-ready-unblocked';
const NOTION_TASK_URL =
  'https://www.notion.so/Test-Task-abc123def456789012345678901234';
const CTX_URL = 'https://notion.so/context';
const PROJECT_ID = 'test-proj';

type FakeBackend = {
  fetchTaskPage: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
};

function makeDefaultAgentSession(sessionType: string) {
  return {
    sessionType: sessionType ?? 'standard',
    taskId: null,
    prUrl: null,
    hasEnded: true,
    on: vi.fn(),
    run: vi.fn().mockReturnValue(new Promise(() => {})),
  };
}

// ── updateStatus("In Progress") failure ──────────────────────────────────────

describe('SessionManager — updateStatus("In Progress") failure broadcasts error', () => {
  let fakeBackend: FakeBackend;

  beforeEach(() => {
    fakeBackend = {
      fetchTaskPage: vi.fn().mockResolvedValue('task content'),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(getTaskBackend).mockReturnValue(fakeBackend as never);

    vi.mocked(AgentSession).mockImplementation(
      (_s, _u, _c, _o, _w, _t, _r, _p, sessionType) =>
        makeDefaultAgentSession(sessionType) as never,
    );
  });

  it('emits { type: "error" } containing "In Progress" when updateStatus rejects', async () => {
    fakeBackend.updateStatus.mockRejectedValue(new Error('task not found'));

    const sm = new SessionManager();
    const msgs: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => msgs.push(m));

    sm.start(YAML_TASK_ID, CTX_URL, {
      sessionType: 'standard',
      projectId: PROJECT_ID,
      taskKind: 'milestone',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const errorMsgs = msgs.filter((m) => m.type === 'error') as Array<{
      type: 'error';
      message: string;
    }>;
    expect(errorMsgs.length).toBeGreaterThanOrEqual(1);
    expect(errorMsgs.some((m) => m.message.includes('In Progress'))).toBe(true);
  });

  it('still emits session_started synchronously even when updateStatus will reject', () => {
    fakeBackend.updateStatus.mockRejectedValue(new Error('task not found'));

    const sm = new SessionManager();
    const msgs: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => msgs.push(m));

    sm.start(YAML_TASK_ID, CTX_URL, {
      sessionType: 'standard',
      projectId: PROJECT_ID,
      taskKind: 'milestone',
    });

    // session_started is broadcast synchronously before any async rejection
    expect(msgs.find((m) => m.type === 'session_started')).toBeDefined();
  });
});

// ── launchSession failure: error broadcast + rollback ────────────────────────

describe('SessionManager — launchSession failure broadcasts error and rolls back', () => {
  let fakeBackend: FakeBackend;

  beforeEach(() => {
    fakeBackend = {
      fetchTaskPage: vi.fn().mockResolvedValue('task content'),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(getTaskBackend).mockReturnValue(fakeBackend as never);
    // markSessionErrored reads the session row to find task_id and project_id for Notion rollback
    vi.mocked(queries.getSession).mockReturnValue({
      session_type: 'standard',
      task_id: 'notion:t2-ready-unblocked',
      project_id: PROJECT_ID,
    } as never);
  });

  it('emits { type: "error" } with "Session launch failed" when AgentSession throws', async () => {
    vi.mocked(AgentSession).mockImplementationOnce(() => {
      throw new Error('worktree creation failed');
    });

    const sm = new SessionManager();
    const msgs: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => msgs.push(m));

    sm.start(YAML_TASK_ID, CTX_URL, {
      sessionType: 'standard',
      projectId: PROJECT_ID,
      taskKind: 'milestone',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const errorMsgs = msgs.filter((m) => m.type === 'error') as Array<{
      type: 'error';
      message: string;
    }>;
    expect(errorMsgs.length).toBeGreaterThanOrEqual(1);
    expect(
      errorMsgs.some((m) => m.message.includes('Session launch failed')),
    ).toBe(true);
  });

  it('calls updateStatus("🗂️ Ready") to roll back when launchSession fails', async () => {
    vi.mocked(AgentSession).mockImplementationOnce(() => {
      throw new Error('worktree creation failed');
    });

    const sm = new SessionManager();
    sm.start(YAML_TASK_ID, CTX_URL, {
      sessionType: 'standard',
      projectId: PROJECT_ID,
      taskKind: 'milestone',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fakeBackend.updateStatus).toHaveBeenCalledWith(
      expect.anything(),
      '🗂️ Ready',
      expect.anything(),
    );
  });

  it('emits task_status_changed with newStatus "🗂️ Ready" after rollback resolves', async () => {
    vi.mocked(AgentSession).mockImplementationOnce(() => {
      throw new Error('worktree creation failed');
    });

    const sm = new SessionManager();
    const msgs: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => msgs.push(m));

    sm.start(YAML_TASK_ID, CTX_URL, {
      sessionType: 'standard',
      projectId: PROJECT_ID,
      taskKind: 'milestone',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const rollbackMsg = msgs.find(
      (m) =>
        m.type === 'task_status_changed' &&
        (m as { type: 'task_status_changed'; newStatus: string }).newStatus ===
          '🗂️ Ready',
    );
    expect(rollbackMsg).toBeDefined();
  });

  it('does NOT roll back for review sessions (only standard sessions roll back)', async () => {
    vi.mocked(AgentSession).mockImplementationOnce(() => {
      throw new Error('worktree failed');
    });
    vi.mocked(queries.getSession).mockReturnValue({
      session_type: 'review',
      task_id: 'notion:t2-ready-unblocked',
      project_id: PROJECT_ID,
    } as never);

    const sm = new SessionManager();
    sm.start(YAML_TASK_ID, CTX_URL, {
      sessionType: 'review',
      projectId: PROJECT_ID,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const readyCalls = (
      fakeBackend.updateStatus.mock.calls as [unknown, string][]
    ).filter((c) => c[1] === '🗂️ Ready');
    expect(readyCalls).toHaveLength(0);
  });
});

// ── YAML task dispatch integration ───────────────────────────────────────────

describe('SessionManager — YAML task dispatch integration', () => {
  let fakeBackend: FakeBackend;

  beforeEach(() => {
    fakeBackend = {
      fetchTaskPage: vi.fn().mockResolvedValue('yaml task content'),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(getTaskBackend).mockReturnValue(fakeBackend as never);

    vi.mocked(AgentSession).mockImplementation(
      (_s, _u, _c, _o, _w, _t, _r, _p, sessionType) =>
        makeDefaultAgentSession(sessionType) as never,
    );
  });

  it('dispatching YAML task ID "t2-ready-unblocked" emits session_started immediately', () => {
    const sm = new SessionManager();
    const msgs: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => msgs.push(m));

    sm.start(YAML_TASK_ID, CTX_URL, {
      sessionType: 'standard',
      projectId: PROJECT_ID,
      taskType: '💻 Code',
      taskKind: 'milestone',
    });

    const started = msgs.find((m) => m.type === 'session_started') as
      | { type: 'session_started'; notionTaskUrl: string }
      | undefined;
    expect(started).toBeDefined();
    expect(started!.notionTaskUrl).toBe(YAML_TASK_ID);
  });

  it('dispatching a YAML task ID emits no synchronous errors', () => {
    const sm = new SessionManager();
    const msgs: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => msgs.push(m));

    sm.start(YAML_TASK_ID, CTX_URL, {
      sessionType: 'standard',
      projectId: PROJECT_ID,
      taskType: '💻 Code',
      taskKind: 'milestone',
    });

    expect(msgs.filter((m) => m.type === 'error')).toHaveLength(0);
  });

  it('Notion task URL dispatch also emits session_started without errors (regression)', () => {
    const sm = new SessionManager();
    const msgs: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => msgs.push(m));

    sm.start(NOTION_TASK_URL, CTX_URL, {
      sessionType: 'standard',
      projectId: PROJECT_ID,
      taskKind: 'milestone',
    });

    expect(msgs.find((m) => m.type === 'session_started')).toBeDefined();
    expect(msgs.filter((m) => m.type === 'error')).toHaveLength(0);
  });
});
