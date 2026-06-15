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

import { execSync } from 'child_process';
import fs from 'node:fs';
import { getSession, getPRBySessionId } from '../db/queries.js';
import { recordEvent } from '../audit/AuditLog.js';
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

beforeEach(() => {
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
