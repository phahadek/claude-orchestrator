/**
 * Spawn-time seeding of the per-project, per-session-kind capability
 * pre-grants (.claude-orchestrator.yml `capability_pre_grants`) into
 * `sessions.granted_capabilities` — see
 * orchestrator-config.ts#resolvePreGrantCapabilities and
 * db/queries.ts#seedGrantedCapabilities. Verifies the resolved, isGrantable-
 * filtered list lands before the session's first turn, for all six
 * resolvable session kinds (gate-verify/investigate/ops/groom/design/docs).
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
  resolveResumeBranchSlug: vi.fn().mockReturnValue('feature/my-task'),
}));

// resolvePreGrantCapabilities/resolvePreGrantSessionKind's own resolution
// logic (task_id prefix -> kind, isGrantable filtering) is covered directly
// by orchestrator-config.test.ts's unit tests. This file only needs to
// verify SessionManager.start() actually calls seedGrantedCapabilities with
// whatever the resolver returns, for each of the six session kinds — so the
// resolver is stubbed here with a simple, self-contained lookup rather than
// exercising the real implementation through the full spawn pipeline.
vi.mock('../orchestrator-config', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    mcp_servers: undefined,
    allowed_tools: [],
    bootstrap_script: '',
    required_env: [],
    required_files: [],
  }),
  resolvePreGrantCapabilities: vi.fn(
    (_orchConfig: unknown, sessionType: string, taskId: string | null) => {
      if (sessionType === 'ops' && taskId?.startsWith('gate-item:')) {
        return ['read:audit-log:project-1'];
      }
      if (sessionType === 'ops' && taskId?.startsWith('report-batch:')) {
        return ['read:session-events:project-1'];
      }
      if (sessionType === 'ops') return ['read:audit-log:project-1'];
      if (sessionType === 'groom') return ['read:path:/etc/foo'];
      if (sessionType === 'design') return ['read:session-events:project-1'];
      if (sessionType === 'docs') return ['read:path:/etc/bar'];
      return [];
    },
  ),
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
  normalizeBoardId: vi.fn((id: string) => id),
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

// Stateful capability store keyed by sessionId, mirroring the real
// db/queries.ts#seedGrantedCapabilities union-merge semantics — so the test
// observes what actually lands in `granted_capabilities`, not opaque mock args.
let grantedCapabilitiesStore: Map<string, string[]>;

vi.mock('../../db/queries', () => ({
  insertSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  recordSessionErroredWriteSkipped: vi.fn(),
  updateSessionWorktreePath: vi.fn(),
  markSessionDone: vi.fn(),
  markSessionIdle: vi.fn(),
  applyPendingDone: vi.fn(),
  getSessionsWithUnappliedPendingDone: vi.fn().mockReturnValue([]),
  archiveSession: vi.fn(),
  markSessionSuperseded: vi.fn(),
  insertEvent: vi.fn(),
  getSession: vi.fn(),
  getSessionsByStatus: vi.fn().mockReturnValue([]),
  getOtherRunningSessionsForTask: vi.fn().mockReturnValue([]),
  getRunningSessionsWithMergedOrClosedPR: vi.fn().mockReturnValue([]),
  getPRByNotionTaskId: vi.fn().mockReturnValue(null),
  getTaskCache: vi.fn().mockReturnValue(null),
  getEventsBySession: vi.fn().mockReturnValue([]),
  getPRByNumber: vi.fn().mockReturnValue(null),
  getPRBySessionId: vi.fn().mockReturnValue(null),
  getStuckResultSessionRows: vi.fn().mockReturnValue([]),
  hasActiveSessionForTask: vi.fn().mockReturnValue(false),
  hasActivePlanningSessionForTask: vi.fn().mockReturnValue(false),
  incrementTaskCrashCount: vi.fn().mockReturnValue(1),
  getTerminalSessionsForTask: vi.fn().mockReturnValue([]),
  setSessionPauseReason: vi.fn(),
  setSessionLastErrorDetail: vi.fn(),
  setTaskPauseReason: vi.fn(),
  listSessionsWithUndeliveredInboxItems: vi.fn().mockReturnValue([]),
  listUndeliveredInboxItems: vi.fn().mockReturnValue([]),
  markInboxItemsDelivered: vi.fn(),
  enqueueFeedbackItem: vi.fn(),
  addGrantedCapability: vi.fn(),
  removeGrantedCapability: vi.fn(),
  TERMINAL_SESSION_STATUSES: new Set(['done', 'error', 'killed']),
  getUsageDeferral: vi.fn().mockReturnValue(null),
  getGrantedCapabilities: vi.fn((sessionId: string) =>
    grantedCapabilitiesStore.get(sessionId)?.slice() ?? [],
  ),
  seedGrantedCapabilities: vi.fn(
    (sessionId: string, capabilities: string[]) => {
      if (capabilities.length === 0) {
        return grantedCapabilitiesStore.get(sessionId)?.slice() ?? [];
      }
      const existing = grantedCapabilitiesStore.get(sessionId) ?? [];
      const next = [...new Set([...existing, ...capabilities])];
      grantedCapabilitiesStore.set(sessionId, next);
      return next;
    },
  ),
  setSessionDeclaredWrites: vi.fn(),
  expireStagedIntentsForSession: vi.fn(),
  hasStagedIntentForTask: vi.fn().mockReturnValue(false),
  hasUndispositionedStagedIntentsForSession: vi.fn().mockReturnValue(false),
  sweepStagedIntentsForTerminalSessions: vi.fn(),
  listStagedIntentsBySession: vi.fn().mockReturnValue([]),
  insertCompletingSignal: vi.fn(),
  listCompletingSignalsForSession: vi.fn().mockReturnValue([]),
  setSessionTerminalCompletionReason: vi.fn(),
  incrementSessionPokeRetryCount: vi.fn().mockReturnValue(1),
  resetSessionPokeRetryCount: vi.fn(),
}));

vi.mock('../../config', () => ({
  config: {},
  getProjectById: vi.fn(),
  normalizePath: vi.fn().mockImplementation((p: string) => p),
  runtimeSettings: {
    session_mode: 'cli',
    corporate_mode_enabled: false,
    max_concurrent_planning_sessions: 5,
    max_concurrent_code_sessions: 5,
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
  execFile: vi.fn(),
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
import { getProjectById } from '../../config';
import { getGrantedCapabilities } from '../../db/queries';

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

describe('capability pre-grants — seeded into granted_capabilities before the first turn', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    grantedCapabilitiesStore = new Map();
    vi.clearAllMocks();
    fetchTaskPage.mockClear().mockResolvedValue('task page content');
    updateStatus.mockClear().mockResolvedValue(undefined);
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
  });

  const cases: Array<{
    kind: string;
    sessionType: 'ops' | 'groom' | 'design' | 'docs';
    taskId: string;
    expected: string[];
  }> = [
    {
      kind: 'gate-verify',
      sessionType: 'ops',
      taskId: 'gate-item:da9a9b8e-25c1-4be5-be44-c53221776888',
      expected: ['read:audit-log:project-1'],
    },
    {
      kind: 'investigate',
      sessionType: 'ops',
      taskId: 'report-batch:batch-1',
      expected: ['read:session-events:project-1'],
    },
    {
      kind: 'ops',
      sessionType: 'ops',
      taskId: 'notion:abc123',
      expected: ['read:audit-log:project-1'],
    },
    {
      kind: 'groom',
      sessionType: 'groom',
      taskId: 'notion:abc123',
      expected: ['read:path:/etc/foo'],
    },
    {
      kind: 'design',
      sessionType: 'design',
      taskId: 'notion:abc123',
      expected: ['read:session-events:project-1'],
    },
    {
      kind: 'docs',
      sessionType: 'docs',
      taskId: 'notion:abc123',
      expected: ['read:path:/etc/bar'],
    },
  ];

  for (const { kind, sessionType, taskId, expected } of cases) {
    it(`seeds the resolved, filtered pre-grant list for a ${kind} session`, async () => {
      const sessionId = await sm.start(
        'https://notion.so/task',
        'https://notion.so/project',
        {
          projectId: PROJECT_ID,
          taskKind: 'non_milestone',
          taskName: `${kind}-task`,
          sessionType,
          taskId,
        } as any,
      );

      // Seeding happens synchronously inside start(), before the
      // fire-and-forget completeStart() chain (worktree setup, AgentSession
      // construction) even begins — so it's already durable by the time
      // start() resolves, with no need to wait for a live session.
      expect(getGrantedCapabilities(sessionId)).toEqual(expected);
    });
  }
});
