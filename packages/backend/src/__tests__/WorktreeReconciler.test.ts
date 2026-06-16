import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execSync: vi.fn() };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(),
      readdirSync: vi.fn(),
      statSync: vi.fn(),
      rmSync: vi.fn(),
    },
  };
});

vi.mock('../db/queries.js', () => ({
  getSession: vi.fn(),
  getPRBySessionId: vi.fn(),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Spy on runWithConcurrency so we can verify the concurrency cap and inject delays.
vi.mock('../utils/concurrency.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/concurrency.js')>();
  return {
    runWithConcurrency: vi.fn().mockImplementation(actual.runWithConcurrency),
  };
});

import { execSync } from 'child_process';
import fs from 'node:fs';
import { getSession, getPRBySessionId } from '../db/queries.js';
import { recordEvent } from '../audit/AuditLog.js';
import { logger } from '../logger.js';
import { runWithConcurrency } from '../utils/concurrency.js';
import { runBootWorktreeReconciliation } from '../orchestration/WorktreeReconciler.js';
import type { ProjectConfig } from '../config.js';

const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedReaddirSync = vi.mocked(fs.readdirSync);
const mockedStatSync = vi.mocked(fs.statSync);
const mockedRmSync = vi.mocked(fs.rmSync);
const mockedGetSession = vi.mocked(getSession);
const mockedGetPR = vi.mocked(getPRBySessionId);
const mockedRecordEvent = vi.mocked(recordEvent);
const mockedLoggerInfo = vi.mocked(logger.info);
const mockedRunWithConcurrency = vi.mocked(runWithConcurrency);

const PROJECT_DIR = '/fake/project';
const WORKTREES_DIR = '/fake/project/.claude/worktrees';

// UUIDs for tests that exercise the orphaned-dir sweep path
const UUID_1 = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const UUID_2 = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const UUID_3 = 'c3d4e5f6-a7b8-9012-cdef-123456789012';

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: 'proj-1',
    name: 'Test Project',
    projectDir: PROJECT_DIR,
    contextUrl: 'https://notion.so/ctx',
    boardId: 'board-1',
    taskSource: 'notion',
    gitMode: 'github',
    autoLaunchEnabled: true,
    autoLaunchMilestoneId: null,
    autoMergeEnabled: false,
    dataResidencyConfirmed: false,
    baseBranch: 'dev',
    ...overrides,
  };
}

function makeSession(status: string) {
  return {
    session_id: 'sess-1',
    status,
    pr_url: null,
    task_id: null,
    task_url: null,
    project_context_url: null,
    project_id: 'proj-1',
    started_at: Date.now() - 60_000,
    ended_at: null,
    worktree_path: `${WORKTREES_DIR}/sess-1`,
    archived: 0,
    favorited: 0,
    session_type: 'standard',
    note: null,
    tags: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    compaction_count: 0,
    context_occupancy_tokens: 0,
    model: null,
    task_name: null,
    metadata: null,
    review_result: null,
    pause_reason: null,
    last_error_detail: null,
    events_pruned_at: null,
  };
}

function makePR(state: 'open' | 'merged' | 'closed') {
  return {
    id: 1,
    pr_number: 42,
    pr_url: 'https://github.com/owner/repo/pull/42',
    task_id: null,
    session_id: 'sess-1',
    repo: 'owner/repo',
    title: 'feat: test',
    body: null,
    head_branch: 'feature/test',
    base_branch: 'dev',
    state,
    draft: 0,
    review_result: null,
    review_at: null,
    created_at: null,
    updated_at: null,
    synced_at: new Date().toISOString(),
    review_session_id: null,
    review_iteration: 0,
    head_sha: null,
    last_reviewed_sha: null,
    node_id: null,
    mergeable: null,
  };
}

function setupWorktreeDir(sessionIds: string[]) {
  mockedReaddirSync.mockReturnValue(
    sessionIds as unknown as ReturnType<typeof fs.readdirSync>,
  );
  mockedStatSync.mockReturnValue({ isDirectory: () => true } as ReturnType<
    typeof fs.statSync
  >);
}

/** Register a worktree path in the git worktree list mock output. */
function gitWorktreeListOutput(
  wtPath: string,
  branch = 'feature/test',
): string {
  return `worktree ${wtPath}\nHEAD abc123\nbranch refs/heads/${branch}\n\n`;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockedExecSync.mockImplementation((cmd: string) => {
    if (String(cmd).includes('rev-parse')) return 'feature/test\n' as never;
    return '' as never; // worktree list → empty (no registered worktrees by default)
  });
  // Default: worktree dir exists on disk
  mockedExistsSync.mockReturnValue(true);
  // Default: empty worktrees dir
  mockedReaddirSync.mockReturnValue(
    [] as unknown as ReturnType<typeof fs.readdirSync>,
  );
  mockedStatSync.mockReturnValue({ isDirectory: () => true } as ReturnType<
    typeof fs.statSync
  >);
  // Restore runWithConcurrency to the real impl (clear any mockImplementationOnce overrides)
  mockedRunWithConcurrency.mockReset();
  const { runWithConcurrency: realRwc } = await vi.importActual<
    typeof import('../utils/concurrency.js')
  >('../utils/concurrency.js');
  mockedRunWithConcurrency.mockImplementation(realRwc);
});

// ── Terminal sessions removed (registered path → git-remove) ─────────────────

describe('runBootWorktreeReconciliation — terminal sessions', () => {
  it.each(['done', 'error', 'killed'] as const)(
    'removes registered worktree for %s session',
    async (status) => {
      const wtPath = `${WORKTREES_DIR}/sess-1`;
      mockedExecSync.mockImplementation((cmd: string) => {
        if (String(cmd).includes('worktree list'))
          return gitWorktreeListOutput(wtPath) as never;
        if (String(cmd).includes('rev-parse')) return 'feature/test\n' as never;
        return '' as never;
      });
      mockedGetSession.mockReturnValue(makeSession(status) as never);
      mockedGetPR.mockReturnValue(null);

      await runBootWorktreeReconciliation({
        listProjects: () => [makeProject()],
      });

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('git worktree remove --force'),
        expect.objectContaining({ cwd: PROJECT_DIR }),
      );
    },
  );

  it('prunes after successful removal', async () => {
    const wtPath = `${WORKTREES_DIR}/sess-1`;
    mockedExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes('worktree list'))
        return gitWorktreeListOutput(wtPath) as never;
      if (String(cmd).includes('rev-parse')) return 'feature/test\n' as never;
      return '' as never;
    });
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedExecSync).toHaveBeenCalledWith(
      'git worktree prune',
      expect.objectContaining({ cwd: PROJECT_DIR }),
    );
  });
});

// ── No-row worktrees removed ────────────────────────────────────────────────

describe('runBootWorktreeReconciliation — no DB row', () => {
  it('git-removes registered worktree with no sessions row', async () => {
    const wtPath = `${WORKTREES_DIR}/sess-1`;
    mockedExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes('worktree list'))
        return gitWorktreeListOutput(wtPath) as never;
      if (String(cmd).includes('rev-parse')) return 'feature/test\n' as never;
      return '' as never;
    });
    mockedGetSession.mockReturnValue(undefined);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove --force'),
      expect.objectContaining({ cwd: PROJECT_DIR }),
    );
  });
});

// ── Live sessions skipped ───────────────────────────────────────────────────

describe('runBootWorktreeReconciliation — live sessions skipped', () => {
  it.each(['running', 'idle', 'starting', 'needs_permission'] as const)(
    'skips registered worktree with %s session',
    async (status) => {
      const wtPath = `${WORKTREES_DIR}/sess-1`;
      mockedExecSync.mockImplementation((cmd: string) => {
        if (String(cmd).includes('worktree list'))
          return gitWorktreeListOutput(wtPath) as never;
        return '' as never;
      });
      mockedGetSession.mockReturnValue(makeSession(status) as never);

      await runBootWorktreeReconciliation({
        listProjects: () => [makeProject()],
      });

      expect(mockedExecSync).not.toHaveBeenCalledWith(
        expect.stringContaining('git worktree remove'),
        expect.anything(),
      );
    },
  );
});

// ── Branch handling ─────────────────────────────────────────────────────────

describe('runBootWorktreeReconciliation — branch deletion', () => {
  function setupRegisteredTerminal(
    status = 'done',
    pr: ReturnType<typeof makePR> | null = null,
  ) {
    const wtPath = `${WORKTREES_DIR}/sess-1`;
    mockedExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes('worktree list'))
        return gitWorktreeListOutput(wtPath) as never;
      if (String(cmd).includes('rev-parse')) return 'feature/test\n' as never;
      return '' as never;
    });
    mockedGetSession.mockReturnValue(makeSession(status) as never);
    mockedGetPR.mockReturnValue(pr as never);
  }

  it('deletes branch when no PR exists', async () => {
    setupRegisteredTerminal('done', null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining('git branch -D'),
      expect.objectContaining({ cwd: PROJECT_DIR }),
    );
  });

  it('deletes branch when PR is merged', async () => {
    setupRegisteredTerminal('done', makePR('merged'));

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining('git branch -D'),
      expect.objectContaining({ cwd: PROJECT_DIR }),
    );
  });

  it('deletes branch when PR is closed', async () => {
    setupRegisteredTerminal('error', makePR('closed'));

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining('git branch -D'),
      expect.objectContaining({ cwd: PROJECT_DIR }),
    );
  });

  it('preserves branch when PR is open', async () => {
    setupRegisteredTerminal('done', makePR('open'));

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining('git branch -D'),
      expect.anything(),
    );
  });
});

// ── Failure tolerance ────────────────────────────────────────────────────────

describe('runBootWorktreeReconciliation — failure tolerance', () => {
  it('records audit event on removal failure', async () => {
    const wtPath = `${WORKTREES_DIR}/sess-fail`;
    mockedExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes('worktree list'))
        return gitWorktreeListOutput(wtPath) as never;
      if (String(cmd).includes('rev-parse')) return 'feature/test\n' as never;
      if (String(cmd).includes('worktree remove')) throw new Error('locked');
      return '' as never;
    });
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'worktree_remove_failed' }),
    );
  });

  it('continues sweeping after one failure', async () => {
    const wt1 = `${WORKTREES_DIR}/sess-fail`;
    const wt2 = `${WORKTREES_DIR}/sess-ok`;

    let callCount = 0;
    mockedExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes('worktree list')) {
        return `${gitWorktreeListOutput(wt1)}${gitWorktreeListOutput(wt2)}` as never;
      }
      if (String(cmd).includes('rev-parse')) return 'feature/test\n' as never;
      if (String(cmd).includes('worktree remove')) {
        callCount++;
        if (callCount === 1) throw new Error('locked');
      }
      return '' as never;
    });
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    // Second worktree removal should still have been attempted
    expect(callCount).toBe(2);
  });

  it('never throws — boot never aborts', async () => {
    mockedReaddirSync.mockImplementation(() => {
      throw new Error('unexpected FS error');
    });

    await expect(
      runBootWorktreeReconciliation({ listProjects: () => [makeProject()] }),
    ).resolves.not.toThrow();
  });
});

// ── Fix A: per-worktree post-remove prune ────────────────────────────────────

describe('runBootWorktreeReconciliation — per-worktree post-remove prune (Fix A)', () => {
  it('runs git worktree prune after successful per-worktree remove', async () => {
    const wtPath = `${WORKTREES_DIR}/sess-1`;
    mockedExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes('worktree list'))
        return gitWorktreeListOutput(wtPath) as never;
      if (String(cmd).includes('rev-parse')) return 'feature/test\n' as never;
      return '' as never;
    });
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    const pruneCalls = mockedExecSync.mock.calls.filter(
      ([cmd]) => String(cmd) === 'git worktree prune',
    );
    // Per-worktree prune (Fix A) + end-of-project prune = 2
    expect(pruneCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('runs git worktree prune after failed per-worktree remove', async () => {
    const wtPath = `${WORKTREES_DIR}/sess-fail`;
    mockedExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes('worktree list'))
        return gitWorktreeListOutput(wtPath) as never;
      if (String(cmd).includes('rev-parse')) return 'feature/test\n' as never;
      if (String(cmd).includes('worktree remove'))
        throw new Error('Result too large');
      return '' as never;
    });
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    const pruneCalls = mockedExecSync.mock.calls.filter(
      ([cmd]) => String(cmd) === 'git worktree prune',
    );
    // Per-worktree prune (Fix A) + end-of-project prune = 2
    expect(pruneCalls.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Fix B: fs.rmSync fallback ─────────────────────────────────────────────────

describe('runBootWorktreeReconciliation — fs.rmSync fallback (Fix B)', () => {
  it('attempts fs.rmSync when dir exists and git worktree remove fails', async () => {
    const wtPath = `${WORKTREES_DIR}/sess-fail`;
    mockedExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes('worktree list'))
        return gitWorktreeListOutput(wtPath) as never;
      if (String(cmd).includes('rev-parse')) return 'feature/test\n' as never;
      if (String(cmd).includes('worktree remove'))
        throw new Error('Invalid argument');
      return '' as never;
    });
    mockedExistsSync.mockReturnValue(true);
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedRmSync).toHaveBeenCalledWith(wtPath, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 500,
    });
  });

  it('does not attempt fs.rmSync when dir is absent after git worktree remove fails', async () => {
    const wtPath = `${WORKTREES_DIR}/sess-fail`;
    mockedExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes('worktree list'))
        return gitWorktreeListOutput(wtPath) as never;
      if (String(cmd).includes('rev-parse')) return 'feature/test\n' as never;
      if (String(cmd).includes('worktree remove'))
        throw new Error('not a working tree');
      return '' as never;
    });
    // Phase 1 existsSync (line 88): true → proceed to removal; Fix B existsSync: false → skip rmSync
    mockedExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedRmSync).not.toHaveBeenCalled();
  });

  it('sets fallbackOk: true in audit event when fs.rmSync succeeds', async () => {
    const wtPath = `${WORKTREES_DIR}/sess-fail`;
    mockedExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes('worktree list'))
        return gitWorktreeListOutput(wtPath) as never;
      if (String(cmd).includes('rev-parse')) return 'feature/test\n' as never;
      if (String(cmd).includes('worktree remove')) throw new Error('locked');
      return '' as never;
    });
    mockedExistsSync.mockReturnValue(true);
    mockedRmSync.mockReturnValue(undefined);
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'worktree_remove_failed',
        payload: expect.objectContaining({ fallbackOk: true }),
      }),
    );
  });

  it('sets fallbackOk: false in audit event when fs.rmSync also fails', async () => {
    const wtPath = `${WORKTREES_DIR}/sess-fail`;
    mockedExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes('worktree list'))
        return gitWorktreeListOutput(wtPath) as never;
      if (String(cmd).includes('rev-parse')) return 'feature/test\n' as never;
      if (String(cmd).includes('worktree remove')) throw new Error('locked');
      return '' as never;
    });
    mockedExistsSync.mockReturnValue(true);
    mockedRmSync.mockImplementation(() => {
      throw new Error('permission denied');
    });
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'worktree_remove_failed',
        payload: expect.objectContaining({ fallbackOk: false }),
      }),
    );
  });

  it('still records worktree_remove_failed even when fs.rmSync fallback succeeds', async () => {
    const wtPath = `${WORKTREES_DIR}/sess-fail`;
    mockedExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes('worktree list'))
        return gitWorktreeListOutput(wtPath) as never;
      if (String(cmd).includes('rev-parse')) return 'feature/test\n' as never;
      if (String(cmd).includes('worktree remove')) throw new Error('locked');
      return '' as never;
    });
    mockedExistsSync.mockReturnValue(true);
    mockedRmSync.mockReturnValue(undefined);
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'worktree_remove_failed' }),
    );
  });
});

// ── No-op on empty worktrees dir ──────────────────────────────────────────

describe('runBootWorktreeReconciliation — idempotent / no-op', () => {
  it('is a no-op when worktrees dir does not exist', async () => {
    mockedReaddirSync.mockImplementation(() => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      throw err;
    });

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining('worktree remove'),
      expect.anything(),
    );
  });

  it('is a no-op when all worktrees belong to live sessions', async () => {
    setupWorktreeDir(['sess-running']);
    mockedGetSession.mockReturnValue(makeSession('running') as never);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining('worktree remove'),
      expect.anything(),
    );
  });

  it('handles multiple projects independently', async () => {
    const proj1 = makeProject({ id: 'proj-1', projectDir: '/p1' });
    const proj2 = makeProject({ id: 'proj-2', projectDir: '/p2' });
    const wt1 = '/p1/.claude/worktrees/sess-1';

    mockedExecSync.mockImplementation((cmd: string, opts?: unknown) => {
      if (String(cmd).includes('worktree list')) {
        if ((opts as { cwd?: string })?.cwd === '/p1')
          return gitWorktreeListOutput(wt1) as never;
        return '' as never;
      }
      if (String(cmd).includes('rev-parse')) return 'feature/test\n' as never;
      return '' as never;
    });
    mockedReaddirSync.mockImplementation((dir) => {
      if (String(dir).includes('p1'))
        return ['sess-1'] as unknown as ReturnType<typeof fs.readdirSync>;
      return [] as unknown as ReturnType<typeof fs.readdirSync>;
    });
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({ listProjects: () => [proj1, proj2] });

    const removeCalls = mockedExecSync.mock.calls.filter(([cmd]) =>
      String(cmd).includes('worktree remove'),
    );
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0][1]).toMatchObject({ cwd: '/p1' });
  });
});

// ── Already-gone worktrees silently pruned ───────────────────────────────────

describe('runBootWorktreeReconciliation — already-gone worktree dir', () => {
  it('does not emit worktree_remove_failed when registered dir is absent', async () => {
    const wtPath = `${WORKTREES_DIR}/sess-gone`;
    mockedExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes('worktree list'))
        return gitWorktreeListOutput(wtPath) as never;
      return '' as never;
    });
    mockedExistsSync.mockReturnValue(false);
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedRecordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'worktree_remove_failed' }),
    );
    expect(mockedExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove'),
      expect.anything(),
    );
    // git worktree prune still runs to reap the dangling registration
    expect(mockedExecSync).toHaveBeenCalledWith(
      'git worktree prune',
      expect.objectContaining({ cwd: PROJECT_DIR }),
    );
  });

  it('emits worktree_remove_failed when dir is present but git refuses to remove', async () => {
    const wtPath = `${WORKTREES_DIR}/sess-locked`;
    mockedExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes('worktree list'))
        return gitWorktreeListOutput(wtPath) as never;
      if (String(cmd).includes('rev-parse')) return 'feature/test\n' as never;
      if (String(cmd).includes('worktree remove'))
        throw new Error('fatal: not a working tree');
      return '' as never;
    });
    mockedExistsSync.mockReturnValue(true);
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'worktree_remove_failed' }),
    );
  });
});

// ── No interval/timer ────────────────────────────────────────────────────────

describe('runBootWorktreeReconciliation — no timer', () => {
  it('does not register a setInterval', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval');

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ── Eligibility from registrations ───────────────────────────────────────────

describe('runBootWorktreeReconciliation — eligibility from registrations', () => {
  it('never calls git worktree remove for an unregistered path', async () => {
    // UUID dir exists on disk but is NOT in git worktree list
    setupWorktreeDir([UUID_1]);
    mockedGetSession.mockReturnValue(makeSession('done') as never);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove'),
      expect.anything(),
    );
  });
});

// ── Orphaned-dir sweep ────────────────────────────────────────────────────────

describe('runBootWorktreeReconciliation — orphaned dir sweep', () => {
  it('fs-deletes unregistered UUID dir with terminal session', async () => {
    setupWorktreeDir([UUID_1]);
    mockedGetSession.mockReturnValue(makeSession('done') as never);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedRmSync).toHaveBeenCalledWith(expect.stringContaining(UUID_1), {
      recursive: true,
      force: true,
    });
    expect(mockedExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove'),
      expect.anything(),
    );
  });

  it('fs-deletes unregistered UUID dir with no DB row', async () => {
    setupWorktreeDir([UUID_1]);
    mockedGetSession.mockReturnValue(undefined);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedRmSync).toHaveBeenCalledWith(expect.stringContaining(UUID_1), {
      recursive: true,
      force: true,
    });
  });

  it.each(['running', 'idle', 'starting', 'needs_permission'] as const)(
    'skips unregistered UUID dir with %s session',
    async (status) => {
      setupWorktreeDir([UUID_1]);
      mockedGetSession.mockReturnValue(makeSession(status) as never);

      await runBootWorktreeReconciliation({
        listProjects: () => [makeProject()],
      });

      expect(mockedRmSync).not.toHaveBeenCalled();
      expect(mockedExecSync).not.toHaveBeenCalledWith(
        expect.stringContaining('git worktree remove'),
        expect.anything(),
      );
    },
  );

  it('never touches non-UUID named dirs', async () => {
    setupWorktreeDir(['not-a-uuid', 'sess-1', 'orphan-uuid', 'random-name']);
    mockedGetSession.mockReturnValue(makeSession('done') as never);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedRmSync).not.toHaveBeenCalled();
    expect(mockedExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove'),
      expect.anything(),
    );
  });

  it('prunes after the fs-delete sweep', async () => {
    setupWorktreeDir([UUID_1]);
    mockedGetSession.mockReturnValue(makeSession('done') as never);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedExecSync).toHaveBeenCalledWith(
      'git worktree prune',
      expect.objectContaining({ cwd: PROJECT_DIR }),
    );
  });
});

// ── Mixed fixture ─────────────────────────────────────────────────────────────

describe('runBootWorktreeReconciliation — mixed fixture', () => {
  it('produces zero worktree_remove_failed audits on a mixed fixture', async () => {
    const regPath = `${WORKTREES_DIR}/${UUID_1}`;

    mockedExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes('worktree list'))
        return gitWorktreeListOutput(regPath) as never;
      if (String(cmd).includes('rev-parse')) return 'feature/test\n' as never;
      return '' as never;
    });
    // FS has: registered-terminal UUID, unregistered-terminal UUID, live UUID, non-UUID
    setupWorktreeDir([UUID_1, UUID_2, UUID_3, 'not-a-uuid']);
    mockedGetSession.mockImplementation((id: string) => {
      if (id === UUID_3) return makeSession('running') as never;
      return makeSession('done') as never;
    });
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    // No spurious audit events
    expect(mockedRecordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'worktree_remove_failed' }),
    );
    // Registered terminal UUID → git-removed
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove --force'),
      expect.anything(),
    );
    // Unregistered terminal UUID → fs.rm
    expect(mockedRmSync).toHaveBeenCalledWith(
      expect.stringContaining(UUID_2),
      expect.objectContaining({ recursive: true }),
    );
    // Live UUID → not fs.rm
    expect(mockedRmSync).not.toHaveBeenCalledWith(
      expect.stringContaining(UUID_3),
      expect.anything(),
    );
    // Non-UUID → not fs.rm
    expect(mockedRmSync).not.toHaveBeenCalledWith(
      expect.stringContaining('not-a-uuid'),
      expect.anything(),
    );
  });

  it('idempotent second boot is a no-op', async () => {
    // Nothing registered, nothing on disk

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });
    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove'),
      expect.anything(),
    );
    expect(mockedRmSync).not.toHaveBeenCalled();
  });
});

// ── Parallelism — boot sweep uses runWithConcurrency with cap 4 ───────────────

describe('runBootWorktreeReconciliation — parallelism', () => {
  it('dispatches all projects to runWithConcurrency with concurrency cap 4', async () => {
    const projects = Array.from({ length: 6 }, (_, i) =>
      makeProject({ id: `proj-${i}`, projectDir: `/fake/p${i}` }),
    );

    await runBootWorktreeReconciliation({ listProjects: () => projects });

    expect(mockedRunWithConcurrency).toHaveBeenCalledWith(
      projects,
      4,
      expect.any(Function),
    );
  });

  it('processes all N projects even when N > concurrency cap', async () => {
    const N = 8;
    const projects = Array.from({ length: N }, (_, i) =>
      makeProject({ id: `proj-${i}`, projectDir: `/fake/p${i}` }),
    );

    mockedExecSync.mockImplementation(() => '' as never);

    await runBootWorktreeReconciliation({ listProjects: () => projects });

    const pruneCalls = mockedExecSync.mock.calls.filter(([cmd]) =>
      String(cmd).includes('worktree prune'),
    );
    expect(pruneCalls).toHaveLength(N);
  });

  it('cap 4 completes faster than serial (cap 1) with async-delayed projects', async () => {
    const N = 8;
    const DELAY_MS = 20;
    const projects = Array.from({ length: N }, (_, i) =>
      makeProject({ id: `proj-${i}`, projectDir: `/fake/p${i}` }),
    );

    mockedExecSync.mockImplementation(() => '' as never);

    // Override runWithConcurrency to add a real async delay per project,
    // preserving the concurrency cap so parallel benefit is observable.
    const { runWithConcurrency: realRwc } = await vi.importActual<
      typeof import('../utils/concurrency.js')
    >('../utils/concurrency.js');
    mockedRunWithConcurrency.mockImplementationOnce(
      (items: any[], cap: number, fn: (item: any) => Promise<any>) =>
        realRwc(items, cap, async (item: unknown) => {
          await new Promise<void>((resolve) => setTimeout(resolve, DELAY_MS));
          return fn(item);
        }),
    );

    const t0 = Date.now();
    await runBootWorktreeReconciliation({ listProjects: () => projects });
    const elapsed = Date.now() - t0;

    // With cap=4 and N=8: ceil(8/4) * 20ms = 40ms.
    // Serial (cap=1) would take 8 * 20ms = 160ms.
    // Threshold: less than half the serial time gives generous room for CI noise.
    expect(elapsed).toBeLessThan((N * DELAY_MS) / 2);
  });
});

// ── Structured per-repo duration logs ────────────────────────────────────────

describe('runBootWorktreeReconciliation — per-repo duration logs', () => {
  it('emits a per-repo profile log with all four duration fields', async () => {
    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    const profileCall = mockedLoggerInfo.mock.calls.find(
      ([msg]) => typeof msg === 'string' && msg.includes('per-repo profile'),
    );
    expect(profileCall).toBeDefined();
    const payload = profileCall![1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      project_id: 'proj-1',
      worktree_list_duration_ms: expect.any(Number),
      worktree_remove_duration_ms: expect.any(Number),
      worktree_branch_delete_duration_ms: expect.any(Number),
      worktree_prune_duration_ms: expect.any(Number),
    });
  });

  it('emits one profile log per project', async () => {
    const projects = [
      makeProject({ id: 'proj-a', projectDir: '/pa' }),
      makeProject({ id: 'proj-b', projectDir: '/pb' }),
    ];

    await runBootWorktreeReconciliation({ listProjects: () => projects });

    const profileCalls = mockedLoggerInfo.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('per-repo profile'),
    );
    expect(profileCalls).toHaveLength(2);
    const ids = profileCalls.map(
      ([, payload]) => (payload as Record<string, unknown>).project_id,
    );
    expect(ids).toContain('proj-a');
    expect(ids).toContain('proj-b');
  });
});
