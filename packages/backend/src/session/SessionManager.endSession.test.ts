/**
 * Unit tests for SessionManager.endSession()'s terminal-status guard.
 *
 * endSession() refuses to escalate/kill a session whose DB row isn't
 * already terminal — but 'superseded' (the status
 * supersedeReviewSession/db/queries.markSessionSuperseded writes) must
 * count as terminal here too, or the guard silently no-ops against the
 * still-idle/running row and the live subprocess for a superseded review
 * session is never actually torn down.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDbQueries } from '../__tests__/helpers/mockDbQueries';

// ── Heavy deps mocked before SessionManager is imported ───────────────────────

vi.mock('../db/queries.js', () =>
  mockDbQueries({
    getSession: vi.fn(),
  }),
);

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

vi.mock('./CliSessionRunner.js', () => ({
  CliSessionRunner: vi.fn(),
  PreSpawnConfigError: class PreSpawnConfigError extends Error {},
}));

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

vi.mock('../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi.fn().mockReturnValue({ updateStatus: vi.fn() }),
}));

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

const SESSION_ID = 'sess-under-test';

/** Seeds a fake live session (with a spyable endSession) directly into the map. */
function seedLiveSession(sm: SessionManager, endSessionSpy: () => void) {
  (
    sm as unknown as {
      sessions: Map<string, { sessionType: string; endSession: () => void }>;
    }
  ).sessions.set(SESSION_ID, { sessionType: 'review', endSession: endSessionSpy });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SessionManager.endSession() — terminal-status guard', () => {
  it('refuses to escalate/kill a session whose DB row is idle (not yet terminal)', () => {
    vi.mocked(getSession).mockReturnValue({ status: 'idle' } as any);
    const endSessionSpy = vi.fn();
    const sm = new SessionManager();
    seedLiveSession(sm, endSessionSpy);

    sm.endSession(SESSION_ID);

    expect(endSessionSpy).not.toHaveBeenCalled();
  });

  it('refuses to escalate/kill a session whose DB row is running (not yet terminal)', () => {
    vi.mocked(getSession).mockReturnValue({ status: 'running' } as any);
    const endSessionSpy = vi.fn();
    const sm = new SessionManager();
    seedLiveSession(sm, endSessionSpy);

    sm.endSession(SESSION_ID);

    expect(endSessionSpy).not.toHaveBeenCalled();
  });

  it('escalates/kills a session whose DB row has been marked superseded', () => {
    vi.mocked(getSession).mockReturnValue({ status: 'superseded' } as any);
    const endSessionSpy = vi.fn();
    const sm = new SessionManager();
    seedLiveSession(sm, endSessionSpy);

    sm.endSession(SESSION_ID);

    expect(endSessionSpy).toHaveBeenCalledOnce();
  });

  it('still escalates/kills a session whose DB row is done (pre-existing terminal case)', () => {
    vi.mocked(getSession).mockReturnValue({ status: 'done' } as any);
    const endSessionSpy = vi.fn();
    const sm = new SessionManager();
    seedLiveSession(sm, endSessionSpy);

    sm.endSession(SESSION_ID);

    expect(endSessionSpy).toHaveBeenCalledOnce();
  });
});
