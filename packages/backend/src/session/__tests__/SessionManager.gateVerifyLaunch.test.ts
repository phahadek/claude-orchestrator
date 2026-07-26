/**
 * Regression coverage for skipping task-backend calls on a gate-verify
 * session launch: task_id is `gate-item:<uuid>` — a pseudo-id naming a
 * gate_item row, not a Notion task page — so the pre-fetch and the
 * In-Progress status transition have nothing valid to act on and must be
 * skipped via isGateVerifySession, not sessionType (gate-verify sessions
 * dispatch as sessionType: 'ops', same as ordinary ops sessions that DO
 * have a real task page).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

let capturedSessions: EventEmitter[] = [];

function makeMockSession() {
  const ee = new EventEmitter() as any;
  ee.hasEnded = false;
  ee.sessionType = 'ops';
  ee.run = vi.fn().mockReturnValue(new Promise(() => {}));
  ee.sendMessage = vi.fn();
  ee.kill = vi.fn().mockResolvedValue(undefined);
  ee.endSession = vi.fn();
  ee.gracefulPause = vi.fn().mockResolvedValue(undefined);
  ee.setPendingOverflowText = vi.fn();
  ee.lockFileForNextInjection = vi.fn();
  return ee;
}

vi.mock('../AgentSession', () => ({
  AgentSession: vi.fn().mockImplementation(() => {
    const s = makeMockSession();
    capturedSessions.push(s);
    return s;
  }),
  parseNotionPageIdDashed: vi.fn().mockReturnValue(''),
}));
vi.mock('../CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../ApiSessionRunner', () => ({
  ApiSessionRunner: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../DockerSessionRunner', () => ({
  DockerSessionRunner: vi.fn().mockImplementation(() => ({})),
  reapOrphanContainers: vi.fn(),
}));
vi.mock('../ContextBuilder', () => ({
  buildSessionContext: vi.fn().mockResolvedValue(''),
}));
vi.mock('../orchestrator-claudemd', () => ({
  buildReviewClaudeMd: vi.fn().mockReturnValue(''),
}));
vi.mock('../branchModel', () => ({
  resolveStartingPoint: vi
    .fn()
    .mockReturnValue({ startingPoint: 'dev', milestoneSlug: null }),
  ensureMilestoneBranch: vi.fn(),
  deriveBranchSlug: vi.fn().mockReturnValue('feature/my-task'),
}));
vi.mock('../orchestrator-config', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    mcp_servers: undefined,
    allowed_tools: [],
    bootstrap_script: '',
    required_env: [],
    required_files: [],
  }),
}));
vi.mock('../sessionRecovery', () => ({
  recoverSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../audit/AuditLog', () => ({ recordEvent: vi.fn() }));

const fetchTaskPage = vi.fn().mockResolvedValue('task page content');
const updateStatus = vi.fn().mockResolvedValue(undefined);
vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    fetchTaskPage: (...args: unknown[]) => fetchTaskPage(...args),
    updateStatus: (...args: unknown[]) => updateStatus(...args),
  }),
}));
vi.mock('../../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));
vi.mock('../../tasks/TaskStatusEngine', () => ({
  deriveDisplayStatusFromDb: vi.fn().mockReturnValue('running'),
}));
vi.mock('../../tasks/taskId', () => ({
  formatTaskId: vi.fn().mockReturnValue('task-123'),
}));
vi.mock('../../notion/NotionClient', () => ({ parseSection: vi.fn() }));
vi.mock('../../github/reviewUtils', () => ({
  formatReviewFeedback: vi.fn().mockReturnValue('review-feedback'),
  formatApprovedVerdictMessage: vi.fn().mockReturnValue('approved'),
}));
vi.mock('../../security/scrubSecrets', () => ({
  scrubSecrets: vi.fn().mockImplementation((s: string) => s),
}));
vi.mock('../../config/corporateMode', () => ({
  getCorporateMode: vi
    .fn()
    .mockReturnValue({ gates: { dockerMandatory: false } }),
}));

vi.mock('../../db/queries', () => ({
  insertSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateSessionWorktreePath: vi.fn(),
  markSessionDone: vi.fn(),
  markSessionIdle: vi.fn(),
  markSessionSuperseded: vi.fn(),
  insertEvent: vi.fn(),
  getSession: vi.fn(),
  getSessionsByStatus: vi.fn().mockReturnValue([]),
  getOtherRunningSessionsForTask: vi.fn().mockReturnValue([]),
  getRunningSessionsWithMergedOrClosedPR: vi.fn().mockReturnValue([]),
  getPRByNotionTaskId: vi.fn().mockReturnValue(null),
  getEventsBySession: vi.fn().mockReturnValue([]),
  getPRByNumber: vi.fn().mockReturnValue(null),
  getPRBySessionId: vi.fn().mockReturnValue(null),
  getStuckResultSessionRows: vi.fn().mockReturnValue([]),
  hasActiveSessionForTask: vi.fn().mockReturnValue(false),
  incrementTaskCrashCount: vi.fn().mockReturnValue(1),
  getTerminalSessionsForTask: vi.fn().mockReturnValue([]),
  setSessionPauseReason: vi.fn(),
  setSessionLastErrorDetail: vi.fn(),
  setTaskPauseReason: vi.fn(),
  TERMINAL_SESSION_STATUSES: new Set(['done', 'error', 'killed']),
}));

vi.mock('../../config', () => ({
  config: { maxConcurrentCodeSessions: 5 },
  getProjectById: vi.fn(),
  normalizePath: vi.fn().mockImplementation((p: string) => p),
  runtimeSettings: {
    session_mode: 'cli',
    corporate_mode_enabled: false,
    max_concurrent_planning_sessions: 5,
  },
}));

vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue('dev\n'),
  exec: vi
    .fn()
    .mockImplementation(
      (
        _cmd: string,
        _opts: unknown,
        callback: (
          err: Error | null,
          result?: { stdout: string; stderr: string },
        ) => void,
      ) => {
        callback(null, { stdout: '', stderr: '' });
      },
    ),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi
      .fn()
      .mockImplementation((p: string) => !String(p).endsWith('.git')),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
    readFileSync: vi.fn().mockReturnValue(''),
    statSync: vi.fn().mockReturnValue({ isDirectory: () => true }),
    unlinkSync: vi.fn(),
    rmSync: vi.fn(),
  },
  existsSync: vi
    .fn()
    .mockImplementation((p: string) => !String(p).endsWith('.git')),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
}));

import { SessionManager } from '../SessionManager';
import { AgentSession } from '../AgentSession';
import { getProjectById } from '../../config';
import { logger } from '../../logger';

const PROJECT_ID = 'project-1';
const PROJECT_DIR = '/project';

function makeProject() {
  return {
    id: PROJECT_ID,
    projectDir: PROJECT_DIR,
    baseBranch: 'dev',
    gitMode: undefined,
  } as any;
}

describe('gate-verify session launch — skips task-backend calls', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    fetchTaskPage.mockClear().mockResolvedValue('task page content');
    updateStatus.mockClear().mockResolvedValue(undefined);
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
  });

  it('a gate-item pseudo-id launch makes no task-backend page fetch', async () => {
    await sm.start('https://notion.so/task', 'https://notion.so/project', {
      projectId: PROJECT_ID,
      taskKind: 'non_milestone',
      taskName: 'gate-verify-task',
      sessionType: 'ops',
      taskId: 'gate-item:da9a9b8e-25c1-4be5-be44-c53221776888',
      injectedProcedureContent: 'gate-verify procedure',
    } as any);

    await vi.waitFor(() => expect(vi.mocked(AgentSession)).toHaveBeenCalled());

    expect(fetchTaskPage).not.toHaveBeenCalled();
  });

  it('a gate-item pseudo-id launch makes no task-backend status update', async () => {
    await sm.start('https://notion.so/task', 'https://notion.so/project', {
      projectId: PROJECT_ID,
      taskKind: 'non_milestone',
      taskName: 'gate-verify-task',
      sessionType: 'ops',
      taskId: 'gate-item:da9a9b8e-25c1-4be5-be44-c53221776888',
      injectedProcedureContent: 'gate-verify procedure',
    } as any);

    await vi.waitFor(() => expect(vi.mocked(AgentSession)).toHaveBeenCalled());
    // Give the fire-and-forget updateStatus branch a tick to have run if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('a gate-item pseudo-id launch emits no NotionApiError on the logger', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    const warnSpy = vi.spyOn(logger, 'warn');

    await sm.start('https://notion.so/task', 'https://notion.so/project', {
      projectId: PROJECT_ID,
      taskKind: 'non_milestone',
      taskName: 'gate-verify-task',
      sessionType: 'ops',
      taskId: 'gate-item:da9a9b8e-25c1-4be5-be44-c53221776888',
      injectedProcedureContent: 'gate-verify procedure',
    } as any);

    await vi.waitFor(() => expect(vi.mocked(AgentSession)).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    const allLogCalls = [...errorSpy.mock.calls, ...warnSpy.mock.calls].map(
      (call) => String(call[0]),
    );
    expect(
      allLogCalls.some((msg) => msg.includes('NotionApiError')),
    ).toBe(false);
  });

  it('an ordinary ops session with a notion:<uuid> task id still performs the pre-fetch and the In Progress transition (no regression)', async () => {
    await sm.start('https://notion.so/task', 'https://notion.so/project', {
      projectId: PROJECT_ID,
      taskKind: 'non_milestone',
      taskName: 'ordinary-ops-task',
      sessionType: 'ops',
      taskId: 'notion:da9a9b8e-25c1-4be5-be44-c53221776888',
      injectedProcedureContent: 'ops procedure',
    } as any);

    await vi.waitFor(() => expect(vi.mocked(AgentSession)).toHaveBeenCalled());
    expect(fetchTaskPage).toHaveBeenCalledWith(
      'notion:da9a9b8e-25c1-4be5-be44-c53221776888',
    );

    await vi.waitFor(() => expect(updateStatus).toHaveBeenCalled());
    expect(updateStatus).toHaveBeenCalledWith(
      'notion:da9a9b8e-25c1-4be5-be44-c53221776888',
      '🔄 In Progress',
      expect.objectContaining({ source: 'orchestrator' }),
    );
  });
});
