import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks — must be declared before vi.mock calls ─────────────────────

const { mockExistsSync, mockReadFileSync, mockAppendFileSync } = vi.hoisted(
  () => ({
    mockExistsSync: vi.fn().mockReturnValue(false),
    mockReadFileSync: vi.fn().mockReturnValue(''),
    mockAppendFileSync: vi.fn(),
  }),
);

const { mockYamlLoad } = vi.hoisted(() => ({
  mockYamlLoad: vi.fn().mockReturnValue(null),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('fs', () => ({
  default: {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    appendFileSync: mockAppendFileSync,
  },
}));

vi.mock('js-yaml', () => ({
  default: { load: mockYamlLoad },
  load: mockYamlLoad,
}));

// ── child_process mock ─────────────────────────────────────────────────────────
// We intercept spawn dynamically via a module-level variable.

interface MockProc {
  stdout: { on: (e: string, cb: (d: Buffer) => void) => void } | null;
  stderr: { on: (e: string, cb: (d: Buffer) => void) => void } | null;
  on: (e: string, cb: (code: number | null) => void) => void;
}

type SpawnHook = (cmd: string, args: unknown, opts: unknown) => MockProc;
let _spawnHook: SpawnHook | null = null;

vi.mock('child_process', () => ({
  spawn: (cmd: string, args: unknown, opts: unknown): MockProc => {
    if (_spawnHook) return _spawnHook(cmd, args, opts);
    return makeProc(0, '');
  },
}));

// ── helpers ───────────────────────────────────────────────────────────────────

function makeProc(exitCode: number, stdout = '', stderr = ''): MockProc {
  const closeCbs: Array<(c: number | null) => void> = [];
  const outCbs: Array<(d: Buffer) => void> = [];
  const errCbs: Array<(d: Buffer) => void> = [];

  const proc: MockProc = {
    stdout: {
      on: (e, cb) => {
        if (e === 'data') outCbs.push(cb);
      },
    },
    stderr: {
      on: (e, cb) => {
        if (e === 'data') errCbs.push(cb);
      },
    },
    on: (e, cb) => {
      if (e === 'close') closeCbs.push(cb);
    },
  };

  setImmediate(() => {
    if (stdout) outCbs.forEach((cb) => cb(Buffer.from(stdout)));
    if (stderr) errCbs.forEach((cb) => cb(Buffer.from(stderr)));
    closeCbs.forEach((cb) => cb(exitCode));
  });

  return proc;
}

// ── subject ───────────────────────────────────────────────────────────────────

import { loadAutofixCommands, runAutofix } from '../autofix-runner';

// ── test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  _spawnHook = null;
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('');
  mockAppendFileSync.mockImplementation(() => undefined);
  mockYamlLoad.mockReturnValue(null);
});

// ── loadAutofixCommands ───────────────────────────────────────────────────────

describe('loadAutofixCommands', () => {
  it('returns [] when .claude-orchestrator.yml is absent', () => {
    mockExistsSync.mockReturnValue(false);
    expect(loadAutofixCommands('/project')).toEqual([]);
  });

  it('returns [] when autofix key is missing from yml', () => {
    mockExistsSync.mockReturnValue(true);
    mockYamlLoad.mockReturnValue({ prGate: { typeCheck: 'npx tsc' } });
    expect(loadAutofixCommands('/project')).toEqual([]);
  });

  it('returns [] when autofix is an empty array', () => {
    mockExistsSync.mockReturnValue(true);
    mockYamlLoad.mockReturnValue({ autofix: [] });
    expect(loadAutofixCommands('/project')).toEqual([]);
  });

  it('returns commands when autofix array is present', () => {
    mockExistsSync.mockReturnValue(true);
    mockYamlLoad.mockReturnValue({
      autofix: ['npm run lint --fix', 'npm run format'],
    });
    expect(loadAutofixCommands('/project')).toEqual([
      'npm run lint --fix',
      'npm run format',
    ]);
  });

  it('filters out non-string entries', () => {
    mockExistsSync.mockReturnValue(true);
    mockYamlLoad.mockReturnValue({ autofix: ['npm run lint', 42, null] });
    expect(loadAutofixCommands('/project')).toEqual(['npm run lint']);
  });

  it('returns [] and logs warning on parse error', () => {
    mockExistsSync.mockReturnValue(true);
    mockYamlLoad.mockImplementation(() => {
      throw new Error('invalid yaml');
    });
    expect(loadAutofixCommands('/project')).toEqual([]);
  });
});

// ── runAutofix — no-op cases ──────────────────────────────────────────────────

describe('runAutofix — no-op when no commands', () => {
  it('returns success immediately when commands array is empty', async () => {
    const result = await runAutofix('/worktree', '/project', [], () => {});
    expect(result.success).toBe(true);
    expect(result.commitSha).toBeUndefined();
  });
});

describe('runAutofix — no diff produced', () => {
  it('returns success with no commit when commands produce no diff', async () => {
    const spawnCalls: Array<{ cmd: string; args: unknown[] }> = [];

    _spawnHook = (cmd, args) => {
      const a = Array.isArray(args) ? args : [];
      spawnCalls.push({ cmd: cmd as string, args: a });

      // git status --porcelain → empty (no diff)
      if (cmd === 'git' && (a as string[])[0] === 'status') {
        return makeProc(0, '');
      }
      return makeProc(0, '');
    };

    const result = await runAutofix(
      '/worktree',
      '/project',
      ['npm run lint'],
      () => {},
    );

    expect(result.success).toBe(true);
    expect(result.commitSha).toBeUndefined();
    expect(
      spawnCalls.some(
        (c) => c.cmd === 'git' && (c.args as string[])[0] === 'commit',
      ),
    ).toBe(false);
  });
});

// ── runAutofix — diff produced → commit ──────────────────────────────────────

describe('runAutofix — diff produced → commit + push', () => {
  it('creates a commit with message "chore: apply autofix [orchestrator]"', async () => {
    const commitArgs: string[] = [];

    _spawnHook = (cmd, args) => {
      const a = Array.isArray(args) ? (args as string[]) : [];
      if (cmd === 'git' && a[0] === 'status')
        return makeProc(0, 'M  src/foo.ts\n');
      if (cmd === 'git' && a[0] === 'add') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'commit') {
        commitArgs.push(...a);
        return makeProc(
          0,
          '[branch abc1234] chore: apply autofix [orchestrator]',
        );
      }
      if (cmd === 'git' && a[0] === 'push') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'rev-parse')
        return makeProc(0, 'abc1234567\n');
      return makeProc(0, '');
    };

    const result = await runAutofix(
      '/worktree',
      '/project',
      ['npm run lint'],
      () => {},
    );

    expect(commitArgs).toContain('chore: apply autofix [orchestrator]');
    expect(result.commitSha).toBe('abc1234567');
    expect(result.success).toBe(true);
  });

  it('sets bot git identity env vars on commit', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;

    _spawnHook = (cmd, args, opts) => {
      const a = Array.isArray(args) ? (args as string[]) : [];
      const o = (opts ?? {}) as { env?: NodeJS.ProcessEnv };

      if (cmd === 'git' && a[0] === 'status') return makeProc(0, 'M  foo.ts\n');
      if (cmd === 'git' && a[0] === 'add') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'commit') {
        capturedEnv = o.env;
        return makeProc(0, '');
      }
      if (cmd === 'git' && a[0] === 'push') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'rev-parse') return makeProc(0, 'sha123\n');
      return makeProc(0, '');
    };

    await runAutofix('/worktree', '/project', ['echo hi'], () => {});

    expect(capturedEnv?.GIT_AUTHOR_NAME).toBe('claude-orchestrator');
    expect(capturedEnv?.GIT_AUTHOR_EMAIL).toBe('bot@claude-code.internal');
    expect(capturedEnv?.GIT_COMMITTER_NAME).toBe('claude-orchestrator');
    expect(capturedEnv?.GIT_COMMITTER_EMAIL).toBe('bot@claude-code.internal');
  });

  it('appends commit SHA to .git-blame-ignore-revs', async () => {
    _spawnHook = (cmd, args) => {
      const a = Array.isArray(args) ? (args as string[]) : [];
      if (cmd === 'git' && a[0] === 'status') return makeProc(0, 'M  foo.ts\n');
      if (cmd === 'git' && a[0] === 'add') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'commit') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'push') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'rev-parse')
        return makeProc(0, 'deadbeef\n');
      return makeProc(0, '');
    };

    await runAutofix('/worktree', '/project', ['echo hi'], () => {});

    expect(mockAppendFileSync).toHaveBeenCalledOnce();
    const [filePath, content] = mockAppendFileSync.mock.calls[0] as [
      string,
      string,
    ];
    expect(filePath).toContain('.git-blame-ignore-revs');
    expect(content).toContain('deadbeef');
  });
});

// ── runAutofix — fail open ─────────────────────────────────────────────────────

describe('runAutofix — fail open on non-zero exit', () => {
  it('returns success:false when a command exits non-zero with no diff', async () => {
    _spawnHook = (cmd, args) => {
      const a = Array.isArray(args) ? (args as string[]) : [];
      if (cmd === 'git' && a[0] === 'status') return makeProc(0, '');
      // autofix shell command fails
      return makeProc(1, '', 'lint error');
    };

    const logged: string[] = [];
    const result = await runAutofix(
      '/worktree',
      '/project',
      ['npm run lint'],
      (m) => logged.push(m),
    );

    expect(result.success).toBe(false);
    expect(result.commitSha).toBeUndefined();
    expect(logged.some((l) => l.includes('WARN'))).toBe(true);
  });

  it('commits whatever changes were produced even when a command fails', async () => {
    let committed = false;

    _spawnHook = (cmd, args) => {
      const a = Array.isArray(args) ? (args as string[]) : [];
      if (cmd === 'git' && a[0] === 'status') return makeProc(0, 'M  foo.ts\n');
      if (cmd === 'git' && a[0] === 'add') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'commit') {
        committed = true;
        return makeProc(0, '');
      }
      if (cmd === 'git' && a[0] === 'push') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'rev-parse') return makeProc(0, 'abc\n');
      // autofix shell command exits non-zero
      return makeProc(1, '', 'error');
    };

    const result = await runAutofix(
      '/worktree',
      '/project',
      ['npm run lint'],
      () => {},
    );

    expect(committed).toBe(true);
    expect(result.commitSha).toBe('abc');
    expect(result.success).toBe(false);
  });
});

// ── runAutofix — syncedTo (fetch + reset after push) ─────────────────────────

describe('runAutofix — syncedTo after fetch + reset', () => {
  it('returns syncedTo as the HEAD SHA after fetch + hard reset succeeds', async () => {
    // rev-parse is called multiple times: commitSha, --abbrev-ref (branch), syncedTo
    let revParseCount = 0;

    _spawnHook = (cmd, args) => {
      const a = Array.isArray(args) ? (args as string[]) : [];
      if (cmd === 'git' && a[0] === 'status') return makeProc(0, 'M  foo.ts\n');
      if (cmd === 'git' && a[0] === 'add') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'commit') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'push') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'fetch') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'reset') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'rev-parse') {
        revParseCount++;
        // First call: HEAD (commitSha); second: --abbrev-ref (branch name);
        // third: HEAD again after reset (syncedTo)
        if (a[1] === '--abbrev-ref') return makeProc(0, 'feature/test\n');
        if (revParseCount === 1) return makeProc(0, 'commit-sha-12345678\n');
        return makeProc(0, 'synced-sha-87654321\n');
      }
      return makeProc(0, '');
    };

    const result = await runAutofix(
      '/worktree',
      '/project',
      ['echo hi'],
      () => {},
    );

    expect(result.commitSha).toBe('commit-sha-12345678');
    expect(result.syncedTo).toBe('synced-sha-87654321');
    expect(result.success).toBe(true);
  });

  it('returns syncedTo: undefined when bannedFiles is empty (no commit)', async () => {
    const result = await runAutofix('/worktree', '/project', [], () => {});
    expect(result.syncedTo).toBeUndefined();
  });

  it('returns syncedTo: undefined when autofix produces no diff', async () => {
    _spawnHook = (cmd, args) => {
      const a = Array.isArray(args) ? (args as string[]) : [];
      if (cmd === 'git' && a[0] === 'status') return makeProc(0, '');
      return makeProc(0, '');
    };

    const result = await runAutofix(
      '/worktree',
      '/project',
      ['echo hi'],
      () => {},
    );
    expect(result.syncedTo).toBeUndefined();
    expect(result.commitSha).toBeUndefined();
  });

  it('returns touchedFiles as the list of files committed by autofix', async () => {
    let revParseCount = 0;

    _spawnHook = (cmd, args) => {
      const a = Array.isArray(args) ? (args as string[]) : [];
      if (cmd === 'git' && a[0] === 'status') return makeProc(0, 'M  foo.ts\n');
      if (cmd === 'git' && a[0] === 'add') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'commit') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'push') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'fetch') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'reset') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'diff') {
        // diff --name-only HEAD~1 HEAD
        return makeProc(0, 'src/foo.ts\nCLAUDE.md\n');
      }
      if (cmd === 'git' && a[0] === 'rev-parse') {
        revParseCount++;
        if (a[1] === '--abbrev-ref') return makeProc(0, 'feature/test\n');
        if (revParseCount === 1) return makeProc(0, 'commit-sha\n');
        return makeProc(0, 'synced-sha\n');
      }
      return makeProc(0, '');
    };

    const result = await runAutofix(
      '/worktree',
      '/project',
      ['echo hi'],
      () => {},
    );

    expect(result.touchedFiles).toEqual(['src/foo.ts', 'CLAUDE.md']);
  });

  it('omits syncedTo when fetch fails (does not throw)', async () => {
    _spawnHook = (cmd, args) => {
      const a = Array.isArray(args) ? (args as string[]) : [];
      if (cmd === 'git' && a[0] === 'status') return makeProc(0, 'M  foo.ts\n');
      if (cmd === 'git' && a[0] === 'add') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'commit') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'push') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'fetch')
        return makeProc(1, '', 'network error');
      if (cmd === 'git' && a[0] === 'rev-parse') {
        if (a[1] === '--abbrev-ref') return makeProc(0, 'feature/test\n');
        return makeProc(0, 'sha-abc\n');
      }
      return makeProc(0, '');
    };

    const result = await runAutofix(
      '/worktree',
      '/project',
      ['echo hi'],
      () => {},
    );

    expect(result.commitSha).toBe('sha-abc');
    // fetch failed so syncedTo must not be set
    expect(result.syncedTo).toBeUndefined();
  });
});

// ── runAutofix — CLAUDE.md protection ────────────────────────────────────────

describe('runAutofix — CLAUDE.md protection', () => {
  it('produces no commit when only CLAUDE.md was changed by autofix', async () => {
    const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

    _spawnHook = (cmd, args) => {
      const a = Array.isArray(args) ? (args as string[]) : [];
      spawnCalls.push({ cmd, args: a });
      // git restore succeeds; git status returns clean (CLAUDE.md was the only change)
      if (cmd === 'git' && a[0] === 'restore') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'status') return makeProc(0, '');
      return makeProc(0, '');
    };

    const result = await runAutofix(
      '/worktree',
      '/project',
      ['npm run format:write'],
      () => {},
    );

    expect(result.commitSha).toBeUndefined();
    expect(result.success).toBe(true);
    const restoreCalls = spawnCalls.filter(
      (c) => c.cmd === 'git' && c.args[0] === 'restore',
    );
    expect(restoreCalls.map((c) => c.args[1])).toContain('CLAUDE.md');
    expect(restoreCalls.map((c) => c.args[1])).toContain('CLAUDE.MD');
    expect(
      spawnCalls.some((c) => c.cmd === 'git' && c.args[0] === 'commit'),
    ).toBe(false);
  });

  it('commits source files when CLAUDE.md and a source file are both dirty, with restore called first', async () => {
    const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

    _spawnHook = (cmd, args) => {
      const a = Array.isArray(args) ? (args as string[]) : [];
      spawnCalls.push({ cmd, args: a });
      if (cmd === 'git' && a[0] === 'restore') return makeProc(0, '');
      // After restore, status still shows the source file (CLAUDE.md was cleaned)
      if (cmd === 'git' && a[0] === 'status') return makeProc(0, 'M  src/foo.ts\n');
      if (cmd === 'git' && a[0] === 'add') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'commit') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'push') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'rev-parse') {
        if (a[1] === '--abbrev-ref') return makeProc(0, 'feature/test\n');
        return makeProc(0, 'commit-sha\n');
      }
      return makeProc(0, '');
    };

    const result = await runAutofix(
      '/worktree',
      '/project',
      ['npm run format:write'],
      () => {},
    );

    expect(result.commitSha).toBe('commit-sha');
    expect(result.success).toBe(true);
    // restore was called for both casings
    const restoreCalls = spawnCalls.filter(
      (c) => c.cmd === 'git' && c.args[0] === 'restore',
    );
    expect(restoreCalls.map((c) => c.args[1])).toContain('CLAUDE.md');
    expect(restoreCalls.map((c) => c.args[1])).toContain('CLAUDE.MD');
    // restore happens before git add
    const firstRestoreIdx = spawnCalls.findIndex(
      (c) => c.cmd === 'git' && c.args[0] === 'restore',
    );
    const addIdx = spawnCalls.findIndex(
      (c) => c.cmd === 'git' && c.args[0] === 'add',
    );
    expect(firstRestoreIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThan(firstRestoreIdx);
  });

  it('restores CLAUDE.md even when git restore exits non-zero (file not tracked)', async () => {
    const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

    _spawnHook = (cmd, args) => {
      const a = Array.isArray(args) ? (args as string[]) : [];
      spawnCalls.push({ cmd, args: a });
      // git restore exits 1 (file not in index) — should not abort the run
      if (cmd === 'git' && a[0] === 'restore') return makeProc(1, '', 'error: pathspec');
      if (cmd === 'git' && a[0] === 'status') return makeProc(0, 'M  src/bar.ts\n');
      if (cmd === 'git' && a[0] === 'add') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'commit') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'push') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'rev-parse') {
        if (a[1] === '--abbrev-ref') return makeProc(0, 'feature/test\n');
        return makeProc(0, 'sha-xyz\n');
      }
      return makeProc(0, '');
    };

    const result = await runAutofix(
      '/worktree',
      '/project',
      ['npm run format:write'],
      () => {},
    );

    expect(result.commitSha).toBe('sha-xyz');
    expect(result.success).toBe(true);
  });
});
