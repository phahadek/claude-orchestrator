/**
 * Unit tests for SessionManager.sendOrResume — specifically the null-return
 * behaviour introduced to prevent ghost-session wedges in PRReviewService.
 *
 * When a session's DB row is missing (pruned) or in a terminal state
 * (done/error/killed), _doSendOrResume must return null rather than the
 * dead session ID so callers can detect the failure and spawn a fresh session.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Heavy deps mocked before SessionManager is imported ───────────────────────

vi.mock('../db/queries.js', () => ({
  getSession: vi.fn().mockReturnValue(null),
  insertSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateSessionWorktreePath: vi.fn(),
  markSessionDone: vi.fn(),
  markSessionSuperseded: vi.fn(),
  insertEvent: vi.fn(),
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
  incrementTaskCrashCount: vi.fn(),
  setTaskPauseReason: vi.fn(),
  getTerminalSessionsForTask: vi.fn().mockReturnValue([]),
}));

vi.mock('../audit/AuditLog.js', () => ({ recordEvent: vi.fn() }));

vi.mock('../security/scrubSecrets.js', () => ({
  scrubSecrets: (s: string) => s,
}));

vi.mock('./AgentSession.js', () => ({
  AgentSession: vi.fn(),
  parseNotionPageIdDashed: vi.fn((s: string) => s),
}));

vi.mock('../tasks/taskId.js', () => ({
  formatTaskId: vi.fn((src: string, id: string) => `${src}:${id}`),
}));

vi.mock('./ContextBuilder.js', () => ({ buildSessionContext: vi.fn() }));

vi.mock('./orchestrator-claudemd.js', () => ({
  buildReviewClaudeMd: vi.fn().mockReturnValue(''),
}));

vi.mock('./branchModel.js', () => ({
  resolveStartingPoint: vi.fn(),
  ensureMilestoneBranch: vi.fn(),
  deriveBranchSlug: vi.fn(),
}));

vi.mock('./orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('./WorktreeSetupError.js', () => ({ WorktreeSetupError: class extends Error {} }));

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

vi.mock('../tasks/TaskBackend.js', () => ({ getTaskBackend: vi.fn() }));

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

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SessionManager.sendOrResume — null sentinel on non-resumable sessions', () => {
  it('returns null when session DB row is missing (pruned)', async () => {
    vi.mocked(getSession).mockReturnValue(null);

    const sm = new SessionManager();
    const result = await sm.sendOrResume('nonexistent-session-id', 'hello');

    expect(result).toBeNull();
  });

  it('returns null when session status is "done"', async () => {
    vi.mocked(getSession).mockReturnValue({ status: 'done' } as any);

    const sm = new SessionManager();
    const result = await sm.sendOrResume('done-session-id', 'hello');

    expect(result).toBeNull();
  });

  it('returns null when session status is "error"', async () => {
    vi.mocked(getSession).mockReturnValue({ status: 'error' } as any);

    const sm = new SessionManager();
    const result = await sm.sendOrResume('errored-session-id', 'hello');

    expect(result).toBeNull();
  });

  it('returns null when session status is "killed"', async () => {
    vi.mocked(getSession).mockReturnValue({ status: 'killed' } as any);

    const sm = new SessionManager();
    const result = await sm.sendOrResume('killed-session-id', 'hello');

    expect(result).toBeNull();
  });

  it('does NOT return null for a live in-memory session (returns sessionId directly)', async () => {
    const sm = new SessionManager();
    // Simulate a live session in the in-memory map by injecting a stub
    const fakeSendMessage = vi.fn();
    (sm as any).sessions.set('live-session-id', { sendMessage: fakeSendMessage });
    vi.mocked(getSession).mockReturnValue({ status: 'running' } as any);

    const result = await sm.sendOrResume('live-session-id', 'hello');

    expect(result).toBe('live-session-id');
  });
});
