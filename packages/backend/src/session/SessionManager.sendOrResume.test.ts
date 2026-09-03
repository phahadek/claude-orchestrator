/**
 * Unit tests for SessionManager.sendOrResume — specifically the null-return
 * behaviour introduced to prevent ghost-session wedges in PRReviewService.
 *
 * When a session's DB row is missing (pruned) or in a terminal state
 * (done/error/killed), _doSendOrResume must return null rather than the
 * dead session ID so callers can detect the failure and spawn a fresh session.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDbQueries } from '../__tests__/helpers/mockDbQueries';

// ── Heavy deps mocked before SessionManager is imported ───────────────────────

vi.mock('../db/queries.js', () =>
  mockDbQueries({
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

import os from 'os';
import { SessionManager } from './SessionManager';
import { getSession, listUndeliveredInboxItems } from '../db/queries';

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
    (sm as any).sessions.set('live-session-id', {
      sendMessage: fakeSendMessage,
    });
    vi.mocked(getSession).mockReturnValue({ status: 'running' } as any);

    const result = await sm.sendOrResume('live-session-id', 'hello');

    expect(result).toBe('live-session-id');
  });

  it('does not deliver via stdin to a live map entry whose process has already ended (hasEnded) — falls through to the respawn path instead', async () => {
    const sm = new SessionManager();
    // A session_ended broadcast sets hasEnded=true synchronously, but the
    // map entry itself is only removed later by cleanupWorktree (chained
    // onto the session's run() promise) — so a caller can observe this
    // in-between state where the entry is present but the process is gone.
    // Writing to its stdin here would silently no-op (closed pipe) and lose
    // the message; the fix is falling through to a --resume respawn.
    const fakeSendMessage = vi.fn();
    (sm as any).sessions.set('ended-session-id', {
      sendMessage: fakeSendMessage,
      hasEnded: true,
    });
    vi.mocked(getSession).mockReturnValue({
      status: 'running',
      project_id: 'missing-project',
    } as any);

    const result = await sm.sendOrResume('ended-session-id', 'hello');

    // getProjectById is mocked to return null, so the respawn path returns
    // early with the sessionId — the assertion that matters is that the
    // live-delivery branch (fakeSendMessage) was never reached.
    expect(fakeSendMessage).not.toHaveBeenCalled();
    expect(result).toBe('ended-session-id');
  });

  it('resumes an idle session even when host free memory is far below the configured admission threshold — the resume path never consults memory admission', async () => {
    // Real os.freemem() (not mocked at module level in this suite) is spied
    // down to a value that would fail hasMemoryHeadroom()'s default
    // 4096+3072 MB floor by a wide margin. SessionManager no longer imports
    // hasMemoryHeadroom at all, so this must have zero effect on the resume.
    const freememSpy = vi
      .spyOn(os, 'freemem')
      .mockReturnValue(200 * 1024 * 1024); // 200 MB free
    try {
      const fakeSendMessage = vi.fn();
      vi.mocked(getSession).mockReturnValue({
        status: 'idle',
        project_id: 'missing-project',
      } as any);

      const smInstance = new SessionManager();
      (smInstance as any).sessions.set('low-memory-session-id', {
        sendMessage: fakeSendMessage,
        hasEnded: true,
      });

      const result = await smInstance.sendOrResume(
        'low-memory-session-id',
        'hello',
      );

      // getProjectById is mocked to return null, so the respawn path
      // returns early with the sessionId — the point is that it is not
      // null, i.e. no memory-admission deferral ever fired.
      expect(result).toBe('low-memory-session-id');
    } finally {
      freememSpy.mockRestore();
    }
  });

  it('resumes a session archived with archive_kind="machine_park" — a machine park is explicitly not done', async () => {
    vi.mocked(getSession).mockReturnValue({
      status: 'idle',
      archived: 1,
      archive_kind: 'machine_park',
      project_id: 'missing-project',
    } as any);

    const sm = new SessionManager();
    const emitSpy = vi.spyOn(sm, 'emit');

    const result = await sm.sendOrResume('parked-session-id', 'hello');

    // getProjectById is mocked to return null, so the respawn path returns
    // early with the sessionId — the point is that the terminal-session
    // guard did not fire and reject it first.
    expect(result).toBe('parked-session-id');
    expect(emitSpy).not.toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        type: 'session_action_failed',
        reason: 'terminal_session',
      }),
    );
  });

  it('returns null when archived=1 with archive_kind="operator" — an explicit operator conclusion', async () => {
    vi.mocked(getSession).mockReturnValue({
      status: 'idle',
      archived: 1,
      archive_kind: 'operator',
    } as any);

    const sm = new SessionManager();
    const result = await sm.sendOrResume('operator-archived-id', 'hello');

    expect(result).toBeNull();
  });

  it('returns null when archived=1 with archive_kind NULL — legacy rows fail closed', async () => {
    vi.mocked(getSession).mockReturnValue({
      status: 'idle',
      archived: 1,
      archive_kind: null,
    } as any);

    const sm = new SessionManager();
    const result = await sm.sendOrResume('legacy-archived-id', 'hello');

    expect(result).toBeNull();
  });

  it('returns null for a terminal status even with archive_kind="machine_park"', async () => {
    vi.mocked(getSession).mockReturnValue({
      status: 'done',
      archived: 1,
      archive_kind: 'machine_park',
    } as any);

    const sm = new SessionManager();
    const result = await sm.sendOrResume('done-parked-id', 'hello');

    expect(result).toBeNull();
  });

  it('enqueues the operator text before refusing an archived, non-machine-parked session — a refusal is a deferral, not a discard', async () => {
    vi.mocked(getSession).mockReturnValue({
      status: 'idle',
      archived: 1,
      archive_kind: 'operator',
    } as any);

    const sm = new SessionManager();
    const result = await sm.sendOrResume(
      'refused-archived-id',
      'operator poke text',
    );

    expect(result).toBeNull();
    const items = await listUndeliveredInboxItems('refused-archived-id');
    expect(items).toHaveLength(1);
    expect(items[0].payload).toBe('operator poke text');
    expect(items[0].source).toBe('operator:message');
    expect(items[0].delivered_at).toBeNull();
    expect(items[0].dropped_at).toBeNull();
  });

  it('the refusal detail names archival as the reason instead of echoing a non-terminal status', async () => {
    vi.mocked(getSession).mockReturnValue({
      status: 'idle',
      archived: 1,
      archive_kind: 'operator',
    } as any);

    const sm = new SessionManager();
    const emitSpy = vi.spyOn(sm, 'emit');

    await sm.sendOrResume('refused-detail-id', 'hello');

    expect(emitSpy).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        type: 'session_action_failed',
        reason: 'terminal_session',
        detail: expect.stringContaining('archived'),
      }),
    );
    expect(emitSpy).not.toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        detail: expect.stringContaining('idle'),
      }),
    );
  });
});
