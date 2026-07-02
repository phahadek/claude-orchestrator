/**
 * Tests for reconcileInboxAtBoot(): inbox rows must only be marked delivered
 * after sendOrResume succeeds, so a failed send leaves them undelivered for
 * retry rather than silently losing the feedback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn().mockReturnValue(''),
    exec: vi.fn(),
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
  runtimeSettings: { session_mode: 'cli' },
  getProjectById: vi.fn().mockReturnValue(null),
  normalizePath: (p: string) => p,
}));

const inboxItemsBySession = new Map<
  string,
  Array<{ id: number; source: string; payload: string }>
>();

function seedInbox(
  sessionId: string,
  items: Array<{ id: number; source: string; payload: string }>,
) {
  inboxItemsBySession.set(sessionId, items);
}

vi.mock('../db/queries', () => ({
  insertSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateSessionWorktreePath: vi.fn(),
  markSessionDone: vi.fn(),
  markSessionSuperseded: vi.fn(),
  insertEvent: vi.fn(),
  getSession: vi.fn(),
  getSessionsByStatus: vi.fn().mockReturnValue([]),
  getPRByNotionTaskId: vi.fn().mockReturnValue(null),
  getEventsBySession: vi.fn().mockReturnValue([]),
  getPRByNumber: vi.fn().mockReturnValue(null),
  getPRBySessionId: vi.fn().mockReturnValue(null),
  getStuckResultSessionRows: vi.fn().mockReturnValue([]),
  getRunningSessionsWithMergedOrClosedPR: vi.fn().mockReturnValue([]),
  hasActiveSessionForTask: vi.fn().mockReturnValue(false),
  getOtherRunningSessionsForTask: vi.fn().mockReturnValue([]),
  setSessionPauseReason: vi.fn(),
  setSessionLastErrorDetail: vi.fn(),
  incrementTaskCrashCount: vi.fn().mockReturnValue(1),
  setTaskPauseReason: vi.fn(),
  getTerminalSessionsForTask: vi.fn().mockReturnValue([]),
  listSessionsWithUndeliveredInboxItems: vi.fn(() => [
    ...inboxItemsBySession.keys(),
  ]),
  listUndeliveredInboxItems: vi.fn((sessionId: string) =>
    (inboxItemsBySession.get(sessionId) ?? []).map((i) => ({
      ...i,
      session_id: sessionId,
      enqueued_at: 0,
      delivered_at: null,
    })),
  ),
  markInboxItemsDelivered: vi.fn((ids: number[]) => {
    for (const [sessionId, items] of inboxItemsBySession.entries()) {
      inboxItemsBySession.set(
        sessionId,
        items.filter((i) => !ids.includes(i.id)),
      );
    }
  }),
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

import { SessionManager } from '../session/SessionManager';
import * as queries from '../db/queries';

beforeEach(() => {
  vi.clearAllMocks();
  inboxItemsBySession.clear();
});

describe('reconcileInboxAtBoot()', () => {
  it('leaves non-terminal-session rows undelivered when sendOrResume throws, for retry', async () => {
    seedInbox('sess-running', [
      { id: 1, source: 'ai-reviewer', payload: 'verdict text' },
    ]);
    vi.mocked(queries.getSession).mockReturnValue({
      session_id: 'sess-running',
      status: 'running',
    } as never);

    const sm = new SessionManager();
    vi.spyOn(sm, 'sendOrResume').mockRejectedValue(new Error('send failed'));

    await sm.reconcileInboxAtBoot();

    expect(sm.sendOrResume).toHaveBeenCalledWith(
      'sess-running',
      expect.stringContaining('verdict text'),
    );
    // Item remains undelivered — available for retry at the next boundary/boot
    expect(queries.markInboxItemsDelivered).not.toHaveBeenCalled();
    expect(queries.listUndeliveredInboxItems('sess-running')).toHaveLength(1);
  });

  it('marks rows delivered only after a successful sendOrResume', async () => {
    seedInbox('sess-idle', [
      { id: 2, source: 'human:alice', payload: 'human feedback' },
    ]);
    vi.mocked(queries.getSession).mockReturnValue({
      session_id: 'sess-idle',
      status: 'idle',
    } as never);

    const sm = new SessionManager();
    vi.spyOn(sm, 'sendOrResume').mockResolvedValue('sess-idle');

    await sm.reconcileInboxAtBoot();

    expect(queries.markInboxItemsDelivered).toHaveBeenCalledWith([2]);
    expect(queries.listUndeliveredInboxItems('sess-idle')).toHaveLength(0);
  });

  it('marks terminal-session rows delivered without sending', async () => {
    seedInbox('sess-done', [
      { id: 3, source: 'ai-reviewer', payload: 'stale verdict' },
    ]);
    vi.mocked(queries.getSession).mockReturnValue({
      session_id: 'sess-done',
      status: 'done',
    } as never);

    const sm = new SessionManager();
    const sendSpy = vi.spyOn(sm, 'sendOrResume');

    await sm.reconcileInboxAtBoot();

    expect(sendSpy).not.toHaveBeenCalled();
    expect(queries.markInboxItemsDelivered).toHaveBeenCalledWith([3]);
    expect(queries.listUndeliveredInboxItems('sess-done')).toHaveLength(0);
  });
});
