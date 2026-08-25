/**
 * Unit tests for SessionManager.markSessionErrored's task-demotion guards.
 *
 * A dying standard session must never demote a task that already has an
 * open PR bound to it — the work already exists, a second dispatch cannot
 * land it, and both sessions would race the same branch. This is the
 * defence-in-depth counterpart to the pre-existing isTaskStatusTerminal
 * guard (which only covers Done/Deferred, not In Review).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDbQueries } from '../__tests__/helpers/mockDbQueries';

// ── Heavy deps mocked before SessionManager is imported ───────────────────────

const getPRByNotionTaskId = vi.fn().mockReturnValue(null);
const getTaskCache = vi.fn().mockReturnValue(undefined);
const incrementTaskCrashCount = vi.fn().mockReturnValue(1);
const setTaskPauseReason = vi.fn();
const updateSessionStatus = vi.fn();

vi.mock('../db/queries.js', () =>
  mockDbQueries({
    getSession: vi.fn(),
    insertSession: vi.fn(),
    updateSessionStatus,
    updateSessionWorktreePath: vi.fn(),
    markSessionDone: vi.fn(),
    markSessionSuperseded: vi.fn(),
    insertEvent: vi.fn(),
    getSessionsByStatus: vi.fn().mockReturnValue([]),
    getPRByNotionTaskId,
    getEventsBySession: vi.fn().mockReturnValue([]),
    getPRByNumber: vi.fn().mockReturnValue(null),
    getPRBySessionId: vi.fn().mockReturnValue(null),
    getStuckResultSessionRows: vi.fn().mockReturnValue([]),
    getRunningSessionsWithMergedOrClosedPR: vi.fn().mockReturnValue([]),
    hasActiveSessionForTask: vi.fn().mockReturnValue(false),
    getOtherRunningSessionsForTask: vi.fn().mockReturnValue([]),
    setSessionPauseReason: vi.fn(),
    setSessionLastErrorDetail: vi.fn(),
    incrementTaskCrashCount,
    setTaskPauseReason,
    getTerminalSessionsForTask: vi.fn().mockReturnValue([]),
    getTaskCache,
    listStagedIntentsBySession: vi.fn().mockReturnValue([]),
    reapStagedIntentsForNeverStagedSession: vi.fn().mockReturnValue(0),
    setSessionTerminalCompletionReason: vi.fn(),
    TERMINAL_SESSION_STATUSES: new Set(['done', 'error', 'killed']),
  }),
);

const recordEvent = vi.fn();
vi.mock('../audit/AuditLog.js', () => ({ recordEvent }));

vi.mock('../security/scrubSecrets.js', () => ({
  scrubSecrets: (s: string) => s,
}));

vi.mock('./AgentSession.js', () => ({
  AgentSession: vi.fn(),
  parseNotionPageIdDashed: vi.fn((s: string) => s),
}));

vi.mock('../tasks/taskId.js', () => ({
  formatTaskId: vi.fn((src: string, id: string) => `${src}:${id}`),
  normalizeBoardId: vi.fn((id: string) => id),
}));

vi.mock('./ContextBuilder.js', () => ({ buildSessionContext: vi.fn() }));

vi.mock('./orchestrator-claudemd.js', () => ({
  buildReviewClaudeMd: vi.fn().mockReturnValue(''),
}));

vi.mock('./branchModel.js', () => ({
  resolveStartingPoint: vi.fn(),
  ensureMilestoneBranch: vi.fn(),
  deriveBranchSlug: vi.fn(),
  resolveResumeBranchSlug: vi.fn(),
}));

vi.mock('./orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('./WorktreeSetupError.js', () => ({
  WorktreeSetupError: class extends Error {},
}));

vi.mock('./CliSessionRunner.js', () => ({ CliSessionRunner: vi.fn() }));

vi.mock('./ApiSessionRunner.js', () => ({ ApiSessionRunner: vi.fn() }));

vi.mock('./DockerSessionRunner.js', () => ({
  DockerSessionRunner: vi.fn(),
  reapOrphanContainers: vi.fn(),
}));

vi.mock('../config/corporateMode.js', () => ({
  getCorporateMode: vi.fn().mockReturnValue(false),
}));

vi.mock('../config.js', () => ({
  config: { projects: [] },
  getProjectById: vi.fn().mockReturnValue(null),
  normalizePath: (p: string) => p,
  runtimeSettings: { session_mode: 'cli', code_session_model: null },
}));

vi.mock('./sessionRecovery.js', () => ({ recoverSession: vi.fn() }));

vi.mock('./eventKind.js', () => ({ eventKind: vi.fn() }));

const updateStatus = vi.fn().mockResolvedValue(undefined);
const getTaskBackend = vi.fn().mockReturnValue({ updateStatus });
vi.mock('../tasks/TaskBackend.js', () => ({ getTaskBackend }));

vi.mock('../tasks/TaskStatusEngine.js', () => ({
  deriveDisplayStatusFromDb: vi.fn(),
}));

vi.mock('../routes/tasks.js', () => ({ emitTaskUpdated: vi.fn() }));

vi.mock('../notion/NotionClient.js', () => ({ parseSection: vi.fn() }));

vi.mock('../github/reviewUtils.js', () => ({
  formatReviewFeedback: vi.fn(),
  formatApprovedVerdictMessage: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { SessionManager } from './SessionManager';
import { getSession } from '../db/queries';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SESSION_ID = 'sess-abc123';
const NOTION_TASK_ID = 'notion:3c122f91-52f3-8106-b707-e5e84e80e0bf';

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    session_id: SESSION_ID,
    status: 'running',
    session_type: 'standard',
    task_id: NOTION_TASK_ID,
    project_id: 'proj-1',
    pr_url: null,
    ...overrides,
  } as any;
}

function makePrRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    pr_number: 1060,
    pr_url: 'https://github.com/org/repo/pull/1060',
    task_id: NOTION_TASK_ID,
    session_id: 'other-session',
    repo: 'org/repo',
    state: 'open',
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  getPRByNotionTaskId.mockReturnValue(null);
  getTaskCache.mockReturnValue(undefined);
  incrementTaskCrashCount.mockReturnValue(1);
  updateStatus.mockResolvedValue(undefined);
});

describe('SessionManager.markSessionErrored — open-PR demotion guard', () => {
  it('leaves the task status unchanged and issues no updateStatus call when the task has an open PR', () => {
    vi.mocked(getSession).mockReturnValue(makeRow());
    getPRByNotionTaskId.mockReturnValue(makePrRow({ state: 'open' }));

    const sm = new SessionManager();
    sm.markSessionErrored(SESSION_ID, 'error', 'run_error');

    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('still demotes the task to 🗂️ Ready when there is no PR row (unchanged behaviour)', () => {
    vi.mocked(getSession).mockReturnValue(makeRow());
    getPRByNotionTaskId.mockReturnValue(null);

    const sm = new SessionManager();
    sm.markSessionErrored(SESSION_ID, 'error', 'run_error');

    expect(updateStatus).toHaveBeenCalledWith(
      NOTION_TASK_ID,
      '🗂️ Ready',
      expect.objectContaining({ source: 'orchestrator', sessionId: SESSION_ID }),
    );
  });

  it('does not demote a task with a merged PR row (isTaskStatusTerminal guard, pinned so both guards cannot regress silently)', () => {
    vi.mocked(getSession).mockReturnValue(makeRow());
    getPRByNotionTaskId.mockReturnValue(makePrRow({ state: 'merged' }));
    getTaskCache.mockReturnValue({
      task_id: NOTION_TASK_ID,
      fetched_at: 0,
      raw_json: JSON.stringify({ status: '✅ Done' }),
    } as any);

    const sm = new SessionManager();
    sm.markSessionErrored(SESSION_ID, 'error', 'run_error');

    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('looks up the PR using the notion:-prefixed task id, matching what pull_requests.task_id stores', () => {
    vi.mocked(getSession).mockReturnValue(makeRow());
    getPRByNotionTaskId.mockReturnValue(null);

    const sm = new SessionManager();
    sm.markSessionErrored(SESSION_ID, 'error', 'run_error');

    expect(getPRByNotionTaskId).toHaveBeenCalledWith(NOTION_TASK_ID);
  });

  it('still increments crash count and sets 🚫 Blocked pause-reason on the 2nd consecutive crash even when the PR is open, but skips the visible status write', () => {
    vi.mocked(getSession).mockReturnValue(makeRow());
    getPRByNotionTaskId.mockReturnValue(makePrRow({ state: 'open' }));
    incrementTaskCrashCount.mockReturnValue(2);

    const sm = new SessionManager();
    sm.markSessionErrored(SESSION_ID, 'error', 'run_error');

    expect(setTaskPauseReason).toHaveBeenCalledWith(
      NOTION_TASK_ID,
      'launch_failed',
      'run_error',
    );
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('records an audit event when the demotion is skipped for an open PR', () => {
    vi.mocked(getSession).mockReturnValue(makeRow());
    getPRByNotionTaskId.mockReturnValue(makePrRow({ state: 'open', pr_number: 1060 }));

    const sm = new SessionManager();
    sm.markSessionErrored(SESSION_ID, 'error', 'run_error');

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'session_errored_write_skipped_open_pr',
        task_id: NOTION_TASK_ID,
        payload: expect.objectContaining({ pr_number: 1060 }),
      }),
    );
  });
});
