import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../config.js', () => ({
  runtimeSettings: {
    session_hard_stop_window_seconds: 60,
  },
}));

vi.mock('../../db/queries.js', () => ({
  getPRBySessionId: vi.fn().mockReturnValue(null),
  setPauseReason: vi.fn(),
  insertPauseInterval: vi.fn(),
  closePauseInterval: vi.fn(),
  upsertStuckSessionTimer: vi.fn(),
  deleteStuckSessionTimer: vi.fn(),
  getAllStuckSessionTimers: vi.fn().mockReturnValue([]),
  getStuckResultSessionRows: vi.fn().mockReturnValue([]),
  markSessionDone: vi.fn(),
  markSessionIdle: vi.fn(),
  getSession: vi.fn(),
  getProjectRowById: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi.fn(),
}));

vi.mock('../../session/sessionRecovery.js', () => ({
  recoverSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../localBranchHelpers.js', () => ({
  getCurrentBranch: vi.fn(),
  hasNonEmptyDiff: vi.fn(),
}));

vi.mock('../localBranchSubmission.js', () => ({
  submitLocalBranch: vi.fn(),
}));

import {
  getStuckResultSessionRows,
  markSessionIdle,
  markSessionDone,
  getProjectRowById,
} from '../../db/queries.js';
import { getTaskBackend } from '../../tasks/TaskBackend.js';
import { recoverSession } from '../../session/sessionRecovery.js';
import { getCurrentBranch, hasNonEmptyDiff } from '../localBranchHelpers.js';
import { submitLocalBranch } from '../localBranchSubmission.js';
import { StuckSessionMonitor } from '../StuckSessionMonitor.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSessionManager(alive: boolean) {
  return {
    on: vi.fn(),
    send: vi.fn(),
    isAlive: vi.fn().mockReturnValue(alive),
  } as unknown as import('../../session/SessionManager').SessionManager;
}

function makeMonitor(alive: boolean) {
  const broadcast = vi.fn();
  const sessionManager = makeSessionManager(alive);
  const monitor = new StuckSessionMonitor(sessionManager, broadcast);
  return { monitor, broadcast, sessionManager };
}

const baseRow = {
  session_id: 'sess-1',
  task_id: 'task-1',
  task_url: 'https://notion.so/task',
  project_context_url: 'https://notion.so/ctx',
  project_id: 'proj-1',
  pr_url: null,
  worktree_path: '/worktree',
  session_type: 'standard',
  last_ts: Date.now(),
};

describe('StuckSessionMonitor.scanForStuckSessions — local-only submission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTaskBackend).mockReturnValue({} as never);
  });

  it('submits the local branch on the idle (still-alive-subprocess) path for a local-only project', async () => {
    vi.mocked(getStuckResultSessionRows).mockReturnValue([baseRow] as never);
    vi.mocked(getProjectRowById).mockReturnValue({
      git_mode: 'local-only',
      base_branch: 'dev',
    } as never);
    vi.mocked(getCurrentBranch).mockResolvedValue('feature/my-task');
    vi.mocked(hasNonEmptyDiff).mockResolvedValue(true);

    const { monitor } = makeMonitor(true);
    await monitor.scanForStuckSessions();

    expect(markSessionIdle).toHaveBeenCalledWith(
      'sess-1',
      baseRow.last_ts,
      null,
    );
    expect(submitLocalBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        taskId: 'task-1',
        featureBranchName: 'feature/my-task',
        baseBranch: 'dev',
        hasDiff: true,
      }),
    );
  });

  it('does not submit a local branch for github-mode projects on the idle path (regression)', async () => {
    vi.mocked(getStuckResultSessionRows).mockReturnValue([baseRow] as never);
    vi.mocked(getProjectRowById).mockReturnValue({
      git_mode: 'github',
      base_branch: 'dev',
    } as never);

    const { monitor } = makeMonitor(true);
    await monitor.scanForStuckSessions();

    expect(submitLocalBranch).not.toHaveBeenCalled();
  });

  it('does not submit when the diff against base is empty', async () => {
    vi.mocked(getStuckResultSessionRows).mockReturnValue([baseRow] as never);
    vi.mocked(getProjectRowById).mockReturnValue({
      git_mode: 'local-only',
      base_branch: 'dev',
    } as never);
    vi.mocked(getCurrentBranch).mockResolvedValue('feature/my-task');
    vi.mocked(hasNonEmptyDiff).mockResolvedValue(false);

    const { monitor } = makeMonitor(true);
    await monitor.scanForStuckSessions();

    expect(submitLocalBranch).toHaveBeenCalledWith(
      expect.objectContaining({ hasDiff: false }),
    );
  });

  it('routes the dead-process, no-PR, local-only path through recoverSession with scope periodic', async () => {
    vi.mocked(getStuckResultSessionRows).mockReturnValue([baseRow] as never);

    const { monitor } = makeMonitor(false);
    await monitor.scanForStuckSessions();

    expect(markSessionDone).toHaveBeenCalled();
    expect(recoverSession).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ scope: 'periodic', projectId: 'proj-1' }),
    );
  });
});
