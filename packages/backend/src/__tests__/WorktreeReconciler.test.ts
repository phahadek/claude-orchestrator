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
      readdirSync: vi.fn(),
      statSync: vi.fn(),
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
const mockedReaddirSync = vi.mocked(fs.readdirSync);
const mockedStatSync = vi.mocked(fs.statSync);
const mockedGetSession = vi.mocked(getSession);
const mockedGetPR = vi.mocked(getPRBySessionId);
const mockedRecordEvent = vi.mocked(recordEvent);

const PROJECT_DIR = '/fake/project';
const WORKTREES_DIR = '/fake/project/.claude/worktrees';

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
  mockedReaddirSync.mockReturnValue(sessionIds as unknown as ReturnType<typeof fs.readdirSync>);
  mockedStatSync.mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: git commands succeed
  mockedExecSync.mockReturnValue('' as never);
  // Default: branch name detected
  mockedExecSync.mockImplementation((cmd: string) => {
    if (String(cmd).includes('rev-parse')) return 'feature/test\n' as never;
    return '' as never;
  });
});

// ── Terminal sessions removed ──────────────────────────────────────────────

describe('runBootWorktreeReconciliation — terminal sessions', () => {
  it.each(['done', 'error', 'killed'] as const)(
    'removes worktree for %s session',
    async (status) => {
      setupWorktreeDir(['sess-1']);
      mockedGetSession.mockReturnValue(makeSession(status) as never);
      mockedGetPR.mockReturnValue(null);

      await runBootWorktreeReconciliation({ listProjects: () => [makeProject()] });

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('git worktree remove --force'),
        expect.objectContaining({ cwd: PROJECT_DIR }),
      );
    },
  );

  it('prunes after successful removal', async () => {
    setupWorktreeDir(['sess-1']);
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({ listProjects: () => [makeProject()] });

    expect(mockedExecSync).toHaveBeenCalledWith(
      'git worktree prune',
      expect.objectContaining({ cwd: PROJECT_DIR }),
    );
  });
});

// ── No-row worktrees removed ────────────────────────────────────────────────

describe('runBootWorktreeReconciliation — no DB row', () => {
  it('removes worktree with no sessions row', async () => {
    setupWorktreeDir(['orphan-uuid']);
    mockedGetSession.mockReturnValue(undefined);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({ listProjects: () => [makeProject()] });

    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove --force'),
      expect.objectContaining({ cwd: PROJECT_DIR }),
    );
  });
});

// ── Live sessions skipped ───────────────────────────────────────────────────

describe('runBootWorktreeReconciliation — live sessions skipped', () => {
  it.each(['running', 'idle', 'starting', 'needs_permission'] as const)(
    'skips %s session',
    async (status) => {
      setupWorktreeDir(['sess-1']);
      mockedGetSession.mockReturnValue(makeSession(status) as never);

      await runBootWorktreeReconciliation({ listProjects: () => [makeProject()] });

      expect(mockedExecSync).not.toHaveBeenCalledWith(
        expect.stringContaining('git worktree remove'),
        expect.anything(),
      );
    },
  );
});

// ── Branch handling ─────────────────────────────────────────────────────────

describe('runBootWorktreeReconciliation — branch deletion', () => {
  it('deletes branch when no PR exists', async () => {
    setupWorktreeDir(['sess-1']);
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    await runBootWorktreeReconciliation({ listProjects: () => [makeProject()] });

    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining('git branch -D'),
      expect.objectContaining({ cwd: PROJECT_DIR }),
    );
  });

  it('deletes branch when PR is merged', async () => {
    setupWorktreeDir(['sess-1']);
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(makePR('merged') as never);

    await runBootWorktreeReconciliation({ listProjects: () => [makeProject()] });

    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining('git branch -D'),
      expect.objectContaining({ cwd: PROJECT_DIR }),
    );
  });

  it('deletes branch when PR is closed', async () => {
    setupWorktreeDir(['sess-1']);
    mockedGetSession.mockReturnValue(makeSession('error') as never);
    mockedGetPR.mockReturnValue(makePR('closed') as never);

    await runBootWorktreeReconciliation({ listProjects: () => [makeProject()] });

    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining('git branch -D'),
      expect.objectContaining({ cwd: PROJECT_DIR }),
    );
  });

  it('preserves branch when PR is open', async () => {
    setupWorktreeDir(['sess-1']);
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(makePR('open') as never);

    await runBootWorktreeReconciliation({ listProjects: () => [makeProject()] });

    expect(mockedExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining('git branch -D'),
      expect.anything(),
    );
  });
});

// ── Failure tolerance ────────────────────────────────────────────────────────

describe('runBootWorktreeReconciliation — failure tolerance', () => {
  it('records audit event on removal failure', async () => {
    setupWorktreeDir(['sess-fail']);
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);
    mockedExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes('rev-parse')) return 'feature/test\n' as never;
      if (String(cmd).includes('worktree remove')) throw new Error('locked');
      return '' as never;
    });

    await runBootWorktreeReconciliation({ listProjects: () => [makeProject()] });

    expect(mockedRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'worktree_remove_failed' }),
    );
  });

  it('continues sweeping after one failure', async () => {
    setupWorktreeDir(['sess-fail', 'sess-ok']);
    mockedGetSession.mockReturnValue(makeSession('done') as never);
    mockedGetPR.mockReturnValue(null);

    let callCount = 0;
    mockedExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes('rev-parse')) return 'feature/test\n' as never;
      if (String(cmd).includes('worktree remove')) {
        callCount++;
        if (callCount === 1) throw new Error('locked');
      }
      return '' as never;
    });

    await runBootWorktreeReconciliation({ listProjects: () => [makeProject()] });

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

    await runBootWorktreeReconciliation({ listProjects: () => [makeProject()] });

    expect(mockedExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining('worktree remove'),
      expect.anything(),
    );
  });

  it('is a no-op when all worktrees belong to live sessions', async () => {
    setupWorktreeDir(['sess-running']);
    mockedGetSession.mockReturnValue(makeSession('running') as never);

    await runBootWorktreeReconciliation({ listProjects: () => [makeProject()] });

    expect(mockedExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining('worktree remove'),
      expect.anything(),
    );
  });

  it('handles multiple projects independently', async () => {
    const proj1 = makeProject({ id: 'proj-1', projectDir: '/p1' });
    const proj2 = makeProject({ id: 'proj-2', projectDir: '/p2' });

    mockedReaddirSync.mockImplementation((dir) => {
      if (String(dir).includes('p1')) return ['sess-1'] as unknown as ReturnType<typeof fs.readdirSync>;
      return [] as unknown as ReturnType<typeof fs.readdirSync>;
    });
    mockedStatSync.mockReturnValue({ isDirectory: () => true } as ReturnType<typeof fs.statSync>);
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

// ── No interval/timer ────────────────────────────────────────────────────────

describe('runBootWorktreeReconciliation — no timer', () => {
  it('does not register a setInterval', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    setupWorktreeDir([]);

    await runBootWorktreeReconciliation({ listProjects: () => [makeProject()] });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
