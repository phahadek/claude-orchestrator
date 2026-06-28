import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const mockExec = vi.fn();
  // The production code does `promisify(exec)`. The real exec carries a
  // util.promisify.custom symbol that makes the promisified form resolve with
  // `{ stdout, stderr }`. A bare vi.fn() lacks that symbol, so generic promisify
  // would resolve with only the first callback value (stdout). Re-attach a custom
  // implementation that drives the mock's callback and resolves `{ stdout, stderr }`.
  (mockExec as unknown as Record<symbol, unknown>)[
    Symbol.for('nodejs.util.promisify.custom')
  ] = (command: string, options: unknown) =>
    new Promise((resolve, reject) => {
      (mockExec as unknown as (...args: unknown[]) => unknown)(
        command,
        options,
        (err: Error | null, stdout: string, stderr: string) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        },
      );
    });
  return { ...actual, exec: mockExec };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      promises: {
        ...actual.promises,
        access: vi.fn().mockResolvedValue(undefined),
        readdir: vi.fn().mockResolvedValue([]),
        stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
        rm: vi.fn().mockResolvedValue(undefined),
      },
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

import { exec } from 'node:child_process';
import fs from 'node:fs';
import { getSession, getPRBySessionId } from '../db/queries.js';
import { recordEvent } from '../audit/AuditLog.js';
import { logger } from '../logger.js';
import { runWithConcurrency } from '../utils/concurrency.js';
import {
  runBootWorktreeReconciliation,
  register,
} from '../orchestration/WorktreeReconciler.js';
import type { ProjectConfig } from '../config.js';
import type { Scheduler } from '../orchestration/Scheduler.js';

const mockedExec = vi.mocked(exec);
const mockedAccess = vi.mocked(fs.promises.access);
const mockedReaddir = vi.mocked(fs.promises.readdir);
const mockedStat = vi.mocked(fs.promises.stat);
const mockedRm = vi.mocked(fs.promises.rm);
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
  mockedReaddir.mockResolvedValue(
    sessionIds as unknown as ReturnType<typeof fs.promises.readdir>,
  );
  mockedStat.mockResolvedValue({ isDirectory: () => true } as ReturnType<
    typeof fs.promises.stat
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
  mockedExec.mockImplementation(
    (cmd: string, _opts: unknown, callback: any) => {
      if (String(cmd).includes('rev-parse'))
        callback(null, 'feature/test\n', '');
      else callback(null, '', ''); // worktree list → empty (no registered worktrees by default)
      return {} as ReturnType<typeof exec>;
    },
  );
  // Default: worktree dir exists on disk
  mockedAccess.mockResolvedValue(undefined);
  // Default: empty worktrees dir
  mockedReaddir.mockResolvedValue(
    [] as unknown as ReturnType<typeof fs.promises.readdir>,
  );
  mockedStat.mockResolvedValue({ isDirectory: () => true } as ReturnType<
    typeof fs.promises.stat
  >);
  mockedRm.mockResolvedValue(undefined);
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
      mockedExec.mockImplementation(
        (cmd: string, _opts: unknown, callback: any) => {
          if (String(cmd).includes('worktree list'))
            callback(null, gitWorktreeListOutput(wtPath), '');
          else if (String(cmd).includes('rev-parse'))
            callback(null, 'feature/test\n', '');
          else callback(null, '', '');
          return {} as ReturnType<typeof exec>;
        },
      );
      mockedGetSession.mockReturnValue(makeSession(status) as never);
      mockedGetPR.mockReturnValue(null);

      await runBootWorktreeReconciliation({
        listProjects: () => [makeProject()],
      });

      expect(mockedExec).toHaveBeenCalledWith(
        expect.stringContaining('git worktree remove --force'),
        expect.objectContaining({ cwd: PROJECT_DIR }),
        expect.any(Function),
      );
    },
  );

  it('prunes after successful removal', async () => {
    const wtPath = `${WORKTREES_DIR}/sess-1`;
    mockedExec.mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).includes('worktree list'))
          callback(null, gitWorktreeListOutput(wtPath), '');
        else if (String(cmd).includes('rev-parse'))
          callback(null, 'feature/test\n', '');
        else callback(null, '', '');
        return {} as ReturnType<typeof exec>;
      },
    );
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedExec).toHaveBeenCalledWith(
      'git worktree prune',
      expect.objectContaining({ cwd: PROJECT_DIR }),
      expect.any(Function),
    );
  });
});

// ── No-row worktrees removed ────────────────────────────────────────────────

describe('runBootWorktreeReconciliation — no DB row', () => {
  it('git-removes registered worktree with no sessions row', async () => {
    const wtPath = `${WORKTREES_DIR}/sess-1`;
    mockedExec.mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).includes('worktree list'))
          callback(null, gitWorktreeListOutput(wtPath), '');
        else if (String(cmd).includes('rev-parse'))
          callback(null, 'feature/test\n', '');
        else callback(null, '', '');
        return {} as ReturnType<typeof exec>;
      },
    );
    mockedGetSession.mockReturnValue(undefined);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedExec).toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove --force'),
      expect.objectContaining({ cwd: PROJECT_DIR }),
      expect.any(Function),
    );
  });
});

// ── Live sessions skipped ───────────────────────────────────────────────────

describe('runBootWorktreeReconciliation — live sessions skipped', () => {
  it.each(['running', 'idle', 'starting', 'needs_permission'] as const)(
    'skips registered worktree with %s session',
    async (status) => {
      const wtPath = `${WORKTREES_DIR}/sess-1`;
      mockedExec.mockImplementation(
        (cmd: string, _opts: unknown, callback: any) => {
          if (String(cmd).includes('worktree list'))
            callback(null, gitWorktreeListOutput(wtPath), '');
          else callback(null, '', '');
          return {} as ReturnType<typeof exec>;
        },
      );
      mockedGetSession.mockReturnValue(makeSession(status) as never);

      await runBootWorktreeReconciliation({
        listProjects: () => [makeProject()],
      });

      expect(mockedExec).not.toHaveBeenCalledWith(
        expect.stringContaining('git worktree remove'),
        expect.anything(),
        expect.any(Function),
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
    mockedExec.mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).includes('worktree list'))
          callback(null, gitWorktreeListOutput(wtPath), '');
        else if (String(cmd).includes('rev-parse'))
          callback(null, 'feature/test\n', '');
        else callback(null, '', '');
        return {} as ReturnType<typeof exec>;
      },
    );
    mockedGetSession.mockReturnValue(makeSession(status) as never);
    mockedGetPR.mockReturnValue(pr as never);
  }

  it('deletes branch when no PR exists', async () => {
    setupRegisteredTerminal('done', null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedExec).toHaveBeenCalledWith(
      expect.stringContaining('git branch -D'),
      expect.objectContaining({ cwd: PROJECT_DIR }),
      expect.any(Function),
    );
  });

  it('deletes branch when PR is merged', async () => {
    setupRegisteredTerminal('done', makePR('merged'));

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedExec).toHaveBeenCalledWith(
      expect.stringContaining('git branch -D'),
      expect.objectContaining({ cwd: PROJECT_DIR }),
      expect.any(Function),
    );
  });

  it('deletes branch when PR is closed', async () => {
    setupRegisteredTerminal('error', makePR('closed'));

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedExec).toHaveBeenCalledWith(
      expect.stringContaining('git branch -D'),
      expect.objectContaining({ cwd: PROJECT_DIR }),
      expect.any(Function),
    );
  });

  it('preserves branch when PR is open', async () => {
    setupRegisteredTerminal('done', makePR('open'));

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedExec).not.toHaveBeenCalledWith(
      expect.stringContaining('git branch -D'),
      expect.anything(),
      expect.any(Function),
    );
  });
});

// ── Failure tolerance ────────────────────────────────────────────────────────

describe('runBootWorktreeReconciliation — failure tolerance', () => {
  it('records audit event on removal failure', async () => {
    const wtPath = `${WORKTREES_DIR}/sess-fail`;
    mockedExec.mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).includes('worktree list'))
          callback(null, gitWorktreeListOutput(wtPath), '');
        else if (String(cmd).includes('rev-parse'))
          callback(null, 'feature/test\n', '');
        else if (String(cmd).includes('worktree remove'))
          callback(new Error('locked'), '', '');
        else callback(null, '', '');
        return {} as ReturnType<typeof exec>;
      },
    );
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
    mockedExec.mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).includes('worktree list'))
          callback(
            null,
            `${gitWorktreeListOutput(wt1)}${gitWorktreeListOutput(wt2)}`,
            '',
          );
        else if (String(cmd).includes('rev-parse'))
          callback(null, 'feature/test\n', '');
        else if (String(cmd).includes('worktree remove')) {
          callCount++;
          if (callCount === 1) callback(new Error('locked'), '', '');
          else callback(null, '', '');
        } else {
          callback(null, '', '');
        }
        return {} as ReturnType<typeof exec>;
      },
    );
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    // Second worktree removal should still have been attempted
    expect(callCount).toBe(2);
  });

  it('never throws — boot never aborts', async () => {
    mockedReaddir.mockRejectedValue(new Error('unexpected FS error'));

    await expect(
      runBootWorktreeReconciliation({ listProjects: () => [makeProject()] }),
    ).resolves.not.toThrow();
  });
});

// ── Fix A: per-worktree post-remove prune ────────────────────────────────────

describe('runBootWorktreeReconciliation — per-worktree post-remove prune (Fix A)', () => {
  it('runs git worktree prune after successful per-worktree remove', async () => {
    const wtPath = `${WORKTREES_DIR}/sess-1`;
    mockedExec.mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).includes('worktree list'))
          callback(null, gitWorktreeListOutput(wtPath), '');
        else if (String(cmd).includes('rev-parse'))
          callback(null, 'feature/test\n', '');
        else callback(null, '', '');
        return {} as ReturnType<typeof exec>;
      },
    );
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    const pruneCalls = mockedExec.mock.calls.filter(
      ([cmd]) => String(cmd) === 'git worktree prune',
    );
    // Per-worktree prune (Fix A) + end-of-project prune = 2
    expect(pruneCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('runs git worktree prune after failed per-worktree remove', async () => {
    const wtPath = `${WORKTREES_DIR}/sess-fail`;
    mockedExec.mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).includes('worktree list'))
          callback(null, gitWorktreeListOutput(wtPath), '');
        else if (String(cmd).includes('rev-parse'))
          callback(null, 'feature/test\n', '');
        else if (String(cmd).includes('worktree remove'))
          callback(new Error('Result too large'), '', '');
        else callback(null, '', '');
        return {} as ReturnType<typeof exec>;
      },
    );
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    const pruneCalls = mockedExec.mock.calls.filter(
      ([cmd]) => String(cmd) === 'git worktree prune',
    );
    // Per-worktree prune (Fix A) + end-of-project prune = 2
    expect(pruneCalls.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Fix B: fs.promises.rm fallback ───────────────────────────────────────────

describe('runBootWorktreeReconciliation — fs.promises.rm fallback (Fix B)', () => {
  it('attempts fs.promises.rm when dir exists and git worktree remove fails', async () => {
    const wtPath = `${WORKTREES_DIR}/sess-fail`;
    mockedExec.mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).includes('worktree list'))
          callback(null, gitWorktreeListOutput(wtPath), '');
        else if (String(cmd).includes('rev-parse'))
          callback(null, 'feature/test\n', '');
        else if (String(cmd).includes('worktree remove'))
          callback(new Error('Invalid argument'), '', '');
        else callback(null, '', '');
        return {} as ReturnType<typeof exec>;
      },
    );
    mockedAccess.mockResolvedValue(undefined);
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedRm).toHaveBeenCalledWith(wtPath, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 500,
    });
  });

  it('does not attempt fs.promises.rm when dir is absent after git worktree remove fails', async () => {
    const wtPath = `${WORKTREES_DIR}/sess-fail`;
    mockedExec.mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).includes('worktree list'))
          callback(null, gitWorktreeListOutput(wtPath), '');
        else if (String(cmd).includes('rev-parse'))
          callback(null, 'feature/test\n', '');
        else if (String(cmd).includes('worktree remove'))
          callback(new Error('not a working tree'), '', '');
        else callback(null, '', '');
        return {} as ReturnType<typeof exec>;
      },
    );
    // Phase 1 access (check before removal): exists; Fix B access: does not exist
    mockedAccess
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('sets fallbackOk: true in audit event when fs.promises.rm succeeds', async () => {
    const wtPath = `${WORKTREES_DIR}/sess-fail`;
    mockedExec.mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).includes('worktree list'))
          callback(null, gitWorktreeListOutput(wtPath), '');
        else if (String(cmd).includes('rev-parse'))
          callback(null, 'feature/test\n', '');
        else if (String(cmd).includes('worktree remove'))
          callback(new Error('locked'), '', '');
        else callback(null, '', '');
        return {} as ReturnType<typeof exec>;
      },
    );
    mockedAccess.mockResolvedValue(undefined);
    mockedRm.mockResolvedValue(undefined);
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

  it('sets fallbackOk: false in audit event when fs.promises.rm also fails', async () => {
    const wtPath = `${WORKTREES_DIR}/sess-fail`;
    mockedExec.mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).includes('worktree list'))
          callback(null, gitWorktreeListOutput(wtPath), '');
        else if (String(cmd).includes('rev-parse'))
          callback(null, 'feature/test\n', '');
        else if (String(cmd).includes('worktree remove'))
          callback(new Error('locked'), '', '');
        else callback(null, '', '');
        return {} as ReturnType<typeof exec>;
      },
    );
    mockedAccess.mockResolvedValue(undefined);
    mockedRm.mockRejectedValue(new Error('permission denied'));
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

  it('still records worktree_remove_failed even when fs.promises.rm fallback succeeds', async () => {
    const wtPath = `${WORKTREES_DIR}/sess-fail`;
    mockedExec.mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).includes('worktree list'))
          callback(null, gitWorktreeListOutput(wtPath), '');
        else if (String(cmd).includes('rev-parse'))
          callback(null, 'feature/test\n', '');
        else if (String(cmd).includes('worktree remove'))
          callback(new Error('locked'), '', '');
        else callback(null, '', '');
        return {} as ReturnType<typeof exec>;
      },
    );
    mockedAccess.mockResolvedValue(undefined);
    mockedRm.mockResolvedValue(undefined);
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
    mockedReaddir.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedExec).not.toHaveBeenCalledWith(
      expect.stringContaining('worktree remove'),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('is a no-op when all worktrees belong to live sessions', async () => {
    setupWorktreeDir(['sess-running']);
    mockedGetSession.mockReturnValue(makeSession('running') as never);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedExec).not.toHaveBeenCalledWith(
      expect.stringContaining('worktree remove'),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('handles multiple projects independently', async () => {
    const proj1 = makeProject({ id: 'proj-1', projectDir: '/p1' });
    const proj2 = makeProject({ id: 'proj-2', projectDir: '/p2' });
    const wt1 = '/p1/.claude/worktrees/sess-1';

    mockedExec.mockImplementation(
      (cmd: string, opts: unknown, callback: any) => {
        if (String(cmd).includes('worktree list')) {
          if ((opts as { cwd?: string })?.cwd === '/p1')
            callback(null, gitWorktreeListOutput(wt1), '');
          else callback(null, '', '');
        } else if (String(cmd).includes('rev-parse')) {
          callback(null, 'feature/test\n', '');
        } else {
          callback(null, '', '');
        }
        return {} as ReturnType<typeof exec>;
      },
    );
    mockedReaddir.mockImplementation((dir) => {
      if (String(dir).includes('p1'))
        return Promise.resolve(['sess-1'] as unknown as ReturnType<
          typeof fs.promises.readdir
        >);
      return Promise.resolve([] as unknown as ReturnType<
        typeof fs.promises.readdir
      >);
    });
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({ listProjects: () => [proj1, proj2] });

    const removeCalls = mockedExec.mock.calls.filter(([cmd]) =>
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
    mockedExec.mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).includes('worktree list'))
          callback(null, gitWorktreeListOutput(wtPath), '');
        else callback(null, '', '');
        return {} as ReturnType<typeof exec>;
      },
    );
    mockedAccess.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedRecordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'worktree_remove_failed' }),
    );
    expect(mockedExec).not.toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove'),
      expect.anything(),
      expect.any(Function),
    );
    // git worktree prune still runs to reap the dangling registration
    expect(mockedExec).toHaveBeenCalledWith(
      'git worktree prune',
      expect.objectContaining({ cwd: PROJECT_DIR }),
      expect.any(Function),
    );
  });

  it('emits worktree_remove_failed when dir is present but git refuses to remove', async () => {
    const wtPath = `${WORKTREES_DIR}/sess-locked`;
    mockedExec.mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).includes('worktree list'))
          callback(null, gitWorktreeListOutput(wtPath), '');
        else if (String(cmd).includes('rev-parse'))
          callback(null, 'feature/test\n', '');
        else if (String(cmd).includes('worktree remove'))
          callback(new Error('fatal: not a working tree'), '', '');
        else callback(null, '', '');
        return {} as ReturnType<typeof exec>;
      },
    );
    mockedAccess.mockResolvedValue(undefined);
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

    expect(mockedExec).not.toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove'),
      expect.anything(),
      expect.any(Function),
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

    expect(mockedRm).toHaveBeenCalledWith(expect.stringContaining(UUID_1), {
      recursive: true,
      force: true,
    });
    expect(mockedExec).not.toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove'),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('fs-deletes unregistered UUID dir with no DB row', async () => {
    setupWorktreeDir([UUID_1]);
    mockedGetSession.mockReturnValue(undefined);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedRm).toHaveBeenCalledWith(expect.stringContaining(UUID_1), {
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

      expect(mockedRm).not.toHaveBeenCalled();
      expect(mockedExec).not.toHaveBeenCalledWith(
        expect.stringContaining('git worktree remove'),
        expect.anything(),
        expect.any(Function),
      );
    },
  );

  it('never touches non-UUID named dirs', async () => {
    setupWorktreeDir(['not-a-uuid', 'sess-1', 'orphan-uuid', 'random-name']);
    mockedGetSession.mockReturnValue(makeSession('done') as never);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockedExec).not.toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove'),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('prunes after the fs-delete sweep', async () => {
    setupWorktreeDir([UUID_1]);
    mockedGetSession.mockReturnValue(makeSession('done') as never);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedExec).toHaveBeenCalledWith(
      'git worktree prune',
      expect.objectContaining({ cwd: PROJECT_DIR }),
      expect.any(Function),
    );
  });
});

// ── Mixed fixture ─────────────────────────────────────────────────────────────

describe('runBootWorktreeReconciliation — mixed fixture', () => {
  it('produces zero worktree_remove_failed audits on a mixed fixture', async () => {
    const regPath = `${WORKTREES_DIR}/${UUID_1}`;

    mockedExec.mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).includes('worktree list'))
          callback(null, gitWorktreeListOutput(regPath), '');
        else if (String(cmd).includes('rev-parse'))
          callback(null, 'feature/test\n', '');
        else callback(null, '', '');
        return {} as ReturnType<typeof exec>;
      },
    );
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
    expect(mockedExec).toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove --force'),
      expect.anything(),
      expect.any(Function),
    );
    // Unregistered terminal UUID → fs.rm
    expect(mockedRm).toHaveBeenCalledWith(
      expect.stringContaining(UUID_2),
      expect.objectContaining({ recursive: true }),
    );
    // Live UUID → not fs.rm
    expect(mockedRm).not.toHaveBeenCalledWith(
      expect.stringContaining(UUID_3),
      expect.anything(),
    );
    // Non-UUID → not fs.rm
    expect(mockedRm).not.toHaveBeenCalledWith(
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

    expect(mockedExec).not.toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove'),
      expect.anything(),
      expect.any(Function),
    );
    expect(mockedRm).not.toHaveBeenCalled();
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

    mockedExec.mockImplementation(
      (_cmd: string, _opts: unknown, callback: any) => {
        callback(null, '', '');
        return {} as ReturnType<typeof exec>;
      },
    );

    await runBootWorktreeReconciliation({ listProjects: () => projects });

    const pruneCalls = mockedExec.mock.calls.filter(([cmd]) =>
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

    mockedExec.mockImplementation(
      (_cmd: string, _opts: unknown, callback: any) => {
        callback(null, '', '');
        return {} as ReturnType<typeof exec>;
      },
    );

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

// ── cwd normalization — OS-aware Git-Bash path conversion ────────────────────

describe('runBootWorktreeReconciliation — cwd normalization', () => {
  const GITBASH_DIR = '/c/Users/phadek/IdeaProjects/proj';
  const WIN32_DIR = 'C:/Users/phadek/IdeaProjects/proj';
  const POSIX_DIR = '/home/orchestrator/repo';

  it('normalizes /c/... project_dir to C:/ cwd on win32', async () => {
    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject({ projectDir: GITBASH_DIR })],
      platform: 'win32',
    });

    const cwds = mockedExec.mock.calls.map(
      ([, opts]) => (opts as { cwd?: string })?.cwd,
    );
    expect(cwds).toEqual(expect.arrayContaining([WIN32_DIR]));
    expect(cwds).not.toContain(GITBASH_DIR);
  });

  it('leaves native POSIX project_dir unchanged on linux', async () => {
    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject({ projectDir: POSIX_DIR })],
      platform: 'linux',
    });

    const cwds = mockedExec.mock.calls.map(
      ([, opts]) => (opts as { cwd?: string })?.cwd,
    );
    expect(cwds).toEqual(expect.arrayContaining([POSIX_DIR]));
  });

  it('leaves native POSIX project_dir unchanged on darwin', async () => {
    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject({ projectDir: POSIX_DIR })],
      platform: 'darwin',
    });

    const cwds = mockedExec.mock.calls.map(
      ([, opts]) => (opts as { cwd?: string })?.cwd,
    );
    expect(cwds).toEqual(expect.arrayContaining([POSIX_DIR]));
  });

  it('win32: git worktree prune uses normalized C:/ cwd, not the raw /c/ path', async () => {
    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject({ projectDir: GITBASH_DIR })],
      platform: 'win32',
    });

    const pruneCalls = mockedExec.mock.calls.filter(
      ([cmd]) => String(cmd) === 'git worktree prune',
    );
    expect(pruneCalls.length).toBeGreaterThan(0);
    for (const call of pruneCalls) {
      expect((call[1] as { cwd?: string })?.cwd).toBe(WIN32_DIR);
    }
  });
});

// ── Event-loop responsiveness ─────────────────────────────────────────────────

describe('runBootWorktreeReconciliation — event-loop responsiveness', () => {
  it('yields the event loop during git operations so concurrent I/O can proceed', async () => {
    const wtPath = `${WORKTREES_DIR}/${UUID_1}`;
    let eventLoopTaskRan = false;

    // Use setImmediate in the mock to simulate genuine async I/O
    mockedExec.mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        setImmediate(() => {
          if (String(cmd).includes('worktree list'))
            callback(null, gitWorktreeListOutput(wtPath), '');
          else if (String(cmd).includes('rev-parse'))
            callback(null, 'feature/test\n', '');
          else callback(null, '', '');
        });
        return {} as ReturnType<typeof exec>;
      },
    );

    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    // Schedule a macrotask that must execute while reconciliation awaits exec
    setImmediate(() => {
      eventLoopTaskRan = true;
    });

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    // If execAsync properly yields the event loop, the scheduled task will have run
    expect(eventLoopTaskRan).toBe(true);
  });
});

// ── TERMINAL_STATUSES guard — DB row precedes worktree creation invariant ─────

describe('TERMINAL_STATUSES guard — DB row precedes worktree creation invariant', () => {
  it('never prunes a registered worktree whose session is non-terminal', async () => {
    // Invariant: SessionManager inserts the session DB row before running
    // `git worktree add`. A non-terminal DB row means the session owns a live
    // worktree — pruning it would corrupt the running session.
    const wtPath = `${WORKTREES_DIR}/sess-1`;
    mockedExec.mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).includes('worktree list'))
          callback(null, gitWorktreeListOutput(wtPath), '');
        else callback(null, '', '');
        return {} as ReturnType<typeof exec>;
      },
    );
    mockedGetSession.mockReturnValue(makeSession('starting') as never);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedExec).not.toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove'),
      expect.anything(),
      expect.any(Function),
    );
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('never prunes an unregistered UUID dir whose session is non-terminal', async () => {
    // Same invariant for phase 2: the DB row is present and non-terminal so the
    // worktree is live, even though it is not yet git-registered.
    setupWorktreeDir([UUID_1]);
    mockedGetSession.mockReturnValue(makeSession('running') as never);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockedExec).not.toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove'),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('prunes a registered worktree with no DB row (truly orphaned)', async () => {
    // No DB row: no session was ever created for this worktree path, so it is
    // safe to reclaim regardless of the guard.
    const wtPath = `${WORKTREES_DIR}/sess-orphan`;
    mockedExec.mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).includes('worktree list'))
          callback(null, gitWorktreeListOutput(wtPath), '');
        else if (String(cmd).includes('rev-parse'))
          callback(null, 'feature/test\n', '');
        else callback(null, '', '');
        return {} as ReturnType<typeof exec>;
      },
    );
    mockedGetSession.mockReturnValue(undefined);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({
      listProjects: () => [makeProject()],
    });

    expect(mockedExec).toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove --force'),
      expect.objectContaining({ cwd: PROJECT_DIR }),
      expect.any(Function),
    );
  });
});

// ── Scheduler job registration ────────────────────────────────────────────────

describe('register — Scheduler job', () => {
  it('registers a job named worktree_reconciler with runOnBoot: true and skip-if-running', () => {
    const mockScheduler = { register: vi.fn() } as unknown as Scheduler;
    register(mockScheduler);
    expect(mockScheduler.register).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'worktree_reconciler',
        runOnBoot: true,
        concurrency: 'skip-if-running',
      }),
    );
  });

  it('registered job has a periodic interval of at least 10 minutes', () => {
    const mockScheduler = { register: vi.fn() } as unknown as Scheduler;
    register(mockScheduler);
    const opts = vi.mocked(mockScheduler.register).mock.calls[0][0];
    const intervalMs =
      typeof opts.intervalMs === 'function' ? opts.intervalMs() : opts.intervalMs;
    expect(intervalMs).toBeGreaterThanOrEqual(10 * 60_000);
  });


});
