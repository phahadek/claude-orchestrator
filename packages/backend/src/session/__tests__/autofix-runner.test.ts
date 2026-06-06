import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks — must be declared before vi.mock calls ─────────────────────

const { mockExistsSync, mockReadFileSync } = vi.hoisted(
  () => ({
    mockExistsSync: vi.fn().mockReturnValue(false),
    mockReadFileSync: vi.fn().mockReturnValue(''),
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
  },
}));

vi.mock('js-yaml', () => ({
  default: { load: mockYamlLoad },
  load: mockYamlLoad,
}));

vi.mock('../../github/PRFileValidator', () => ({
  isHardBanned: vi.fn((f: string) => {
    const base = f.split('/').pop() ?? f;
    return (
      /^claude\.md$/i.test(base) ||
      /^\.commit[-_]msg$/i.test(base) ||
      /^commit[-_]msg\..+$/i.test(base)
    );
  }),
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
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
import { recordEvent } from '../../audit/AuditLog';

// ── test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  _spawnHook = null;
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('');
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
      if (cmd === 'git' && a[0] === 'diff' && a[1] === '--cached')
        return makeProc(0, 'src/foo.ts\n');
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
      if (cmd === 'git' && a[0] === 'diff' && a[1] === '--cached')
        return makeProc(0, 'foo.ts\n');
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
      if (cmd === 'git' && a[0] === 'diff' && a[1] === '--cached')
        return makeProc(0, 'foo.ts\n');
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
      if (cmd === 'git' && a[0] === 'diff' && a[1] === '--cached')
        return makeProc(0, 'foo.ts\n');
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

// ── runAutofix — proactive banned-file cleanup ────────────────────────────────

describe('runAutofix — proactive banned-file unstaging', () => {
  it('calls git restore --staged for each banned staged file, in call order after git add', async () => {
    const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

    _spawnHook = (cmd, args) => {
      const a = Array.isArray(args) ? (args as string[]) : [];
      spawnCalls.push({ cmd: cmd as string, args: a });

      if (cmd === 'git' && a[0] === 'status')
        return makeProc(0, 'M  src/foo.ts\n');
      if (cmd === 'git' && a[0] === 'add') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'diff' && a[1] === '--cached') {
        // First call: staged list; second call: remaining after restore
        const callsBefore = spawnCalls.filter(
          (c) =>
            c.cmd === 'git' && c.args[0] === 'diff' && c.args[1] === '--cached',
        );
        if (callsBefore.length <= 1)
          return makeProc(0, 'CLAUDE.md\nsrc/foo.ts\n');
        return makeProc(0, 'src/foo.ts\n');
      }
      if (cmd === 'git' && a[0] === 'restore') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'commit') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'push') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'rev-parse') {
        if (a[1] === '--abbrev-ref') return makeProc(0, 'feature/x\n');
        return makeProc(0, 'abc123\n');
      }
      return makeProc(0, '');
    };

    await runAutofix('/worktree', '/project', ['npm run lint'], () => {});

    const addIdx = spawnCalls.findIndex(
      (c) => c.cmd === 'git' && c.args[0] === 'add',
    );
    const restoreIdx = spawnCalls.findIndex(
      (c) => c.cmd === 'git' && c.args[0] === 'restore',
    );
    const commitIdx = spawnCalls.findIndex(
      (c) => c.cmd === 'git' && c.args[0] === 'commit',
    );

    expect(restoreIdx).toBeGreaterThan(addIdx);
    expect(commitIdx).toBeGreaterThan(restoreIdx);

    const restoreCall = spawnCalls[restoreIdx];
    expect(restoreCall.args).toEqual([
      'restore',
      '--staged',
      '--',
      'CLAUDE.md',
    ]);
  });

  it('handles CLAUDE.MD (uppercase extension) by exact staged path', async () => {
    const restoreCalls: string[][] = [];

    _spawnHook = (cmd, args) => {
      const a = Array.isArray(args) ? (args as string[]) : [];
      if (cmd === 'git' && a[0] === 'status')
        return makeProc(0, 'M  CLAUDE.MD\n');
      if (cmd === 'git' && a[0] === 'add') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'restore') {
        restoreCalls.push(a);
        return makeProc(0, '');
      }
      if (cmd === 'git' && a[0] === 'diff' && a[1] === '--cached') {
        if (restoreCalls.length === 0) return makeProc(0, 'CLAUDE.MD\n');
        return makeProc(0, '');
      }
      if (cmd === 'git' && a[0] === 'rev-parse') return makeProc(0, 'sha\n');
      return makeProc(0, '');
    };

    await runAutofix('/worktree', '/project', ['echo hi'], () => {});

    expect(restoreCalls).toHaveLength(1);
    expect(restoreCalls[0]).toEqual(['restore', '--staged', '--', 'CLAUDE.MD']);
  });

  it('handles commit-msg.draft (pattern match) via git restore --staged', async () => {
    const restoreCalls: string[][] = [];

    _spawnHook = (cmd, args) => {
      const a = Array.isArray(args) ? (args as string[]) : [];
      if (cmd === 'git' && a[0] === 'status')
        return makeProc(0, 'M  commit-msg.draft\n');
      if (cmd === 'git' && a[0] === 'add') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'restore') {
        restoreCalls.push(a);
        return makeProc(0, '');
      }
      if (cmd === 'git' && a[0] === 'diff' && a[1] === '--cached') {
        if (restoreCalls.length === 0) return makeProc(0, 'commit-msg.draft\n');
        return makeProc(0, '');
      }
      if (cmd === 'git' && a[0] === 'rev-parse') return makeProc(0, 'sha\n');
      return makeProc(0, '');
    };

    await runAutofix('/worktree', '/project', ['echo hi'], () => {});

    expect(restoreCalls).toHaveLength(1);
    expect(restoreCalls[0]).toEqual([
      'restore',
      '--staged',
      '--',
      'commit-msg.draft',
    ]);
  });

  it('makes no git restore calls when no staged paths are banned', async () => {
    const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

    _spawnHook = (cmd, args) => {
      const a = Array.isArray(args) ? (args as string[]) : [];
      spawnCalls.push({ cmd: cmd as string, args: a });
      if (cmd === 'git' && a[0] === 'status')
        return makeProc(0, 'M  src/clean.ts\n');
      if (cmd === 'git' && a[0] === 'diff' && a[1] === '--cached')
        return makeProc(0, 'src/clean.ts\n');
      if (cmd === 'git' && a[0] === 'rev-parse') {
        if (a[1] === '--abbrev-ref') return makeProc(0, 'feature/x\n');
        return makeProc(0, 'sha123\n');
      }
      return makeProc(0, '');
    };

    const result = await runAutofix(
      '/worktree',
      '/project',
      ['echo hi'],
      () => {},
    );

    expect(result.commitSha).toBeDefined();
    const restoreCalls = spawnCalls.filter(
      (c) => c.cmd === 'git' && c.args[0] === 'restore',
    );
    expect(restoreCalls).toHaveLength(0);
  });

  it('skips commit and returns success:true when only banned files were staged', async () => {
    const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

    _spawnHook = (cmd, args) => {
      const a = Array.isArray(args) ? (args as string[]) : [];
      spawnCalls.push({ cmd: cmd as string, args: a });
      if (cmd === 'git' && a[0] === 'status')
        return makeProc(0, 'M  CLAUDE.md\n');
      if (cmd === 'git' && a[0] === 'add') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'restore') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'diff' && a[1] === '--cached') {
        const restoreCount = spawnCalls.filter(
          (c) => c.cmd === 'git' && c.args[0] === 'restore',
        ).length;
        if (restoreCount === 0) return makeProc(0, 'CLAUDE.md\n');
        return makeProc(0, '');
      }
      return makeProc(0, '');
    };

    const result = await runAutofix(
      '/worktree',
      '/project',
      ['echo hi'],
      () => {},
    );

    expect(result.success).toBe(true);
    expect(result.commitSha).toBeUndefined();
    expect(result.summary).toContain('skipped commit');

    const commitCalls = spawnCalls.filter(
      (c) => c.cmd === 'git' && c.args[0] === 'commit',
    );
    expect(commitCalls).toHaveLength(0);
  });

  it('commits only clean files when mixed banned + clean files are staged', async () => {
    const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

    _spawnHook = (cmd, args) => {
      const a = Array.isArray(args) ? (args as string[]) : [];
      spawnCalls.push({ cmd: cmd as string, args: a });
      if (cmd === 'git' && a[0] === 'status')
        return makeProc(0, 'M  src/app.ts\nM  CLAUDE.md\n');
      if (cmd === 'git' && a[0] === 'add') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'restore') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'diff' && a[1] === '--cached') {
        const restoreCount = spawnCalls.filter(
          (c) => c.cmd === 'git' && c.args[0] === 'restore',
        ).length;
        if (restoreCount === 0) return makeProc(0, 'CLAUDE.md\nsrc/app.ts\n');
        return makeProc(0, 'src/app.ts\n');
      }
      if (cmd === 'git' && a[0] === 'diff' && a[1] === '--name-only')
        return makeProc(0, 'src/app.ts\n');
      if (cmd === 'git' && a[0] === 'commit') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'push') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'rev-parse') {
        if (a[1] === '--abbrev-ref') return makeProc(0, 'feature/x\n');
        return makeProc(0, 'cleansha\n');
      }
      return makeProc(0, '');
    };

    const result = await runAutofix(
      '/worktree',
      '/project',
      ['echo hi'],
      () => {},
    );

    expect(result.commitSha).toBe('cleansha');
    expect(result.touchedFiles).toEqual(['src/app.ts']);

    const restoreCalls = spawnCalls.filter(
      (c) => c.cmd === 'git' && c.args[0] === 'restore',
    );
    expect(restoreCalls).toHaveLength(1);
    expect(restoreCalls[0].args).toContain('CLAUDE.md');
    expect(restoreCalls[0].args).not.toContain('src/app.ts');
  });

  it('does not call fs.unlink or git restore --worktree for banned files', async () => {
    const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

    _spawnHook = (cmd, args) => {
      const a = Array.isArray(args) ? (args as string[]) : [];
      spawnCalls.push({ cmd: cmd as string, args: a });
      if (cmd === 'git' && a[0] === 'status')
        return makeProc(0, 'M  CLAUDE.md\nM  src/a.ts\n');
      if (cmd === 'git' && a[0] === 'add') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'restore') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'diff' && a[1] === '--cached') {
        const rc = spawnCalls.filter(
          (c) => c.cmd === 'git' && c.args[0] === 'restore',
        ).length;
        if (rc === 0) return makeProc(0, 'CLAUDE.md\nsrc/a.ts\n');
        return makeProc(0, 'src/a.ts\n');
      }
      if (cmd === 'git' && a[0] === 'diff' && a[1] === '--name-only')
        return makeProc(0, 'src/a.ts\n');
      if (cmd === 'git' && a[0] === 'commit') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'push') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'rev-parse') {
        if (a[1] === '--abbrev-ref') return makeProc(0, 'feature/x\n');
        return makeProc(0, 'sha\n');
      }
      return makeProc(0, '');
    };

    await runAutofix('/worktree', '/project', ['echo hi'], () => {});

    // No worktree restore (--worktree flag)
    const worktreeRestore = spawnCalls.filter(
      (c) =>
        c.cmd === 'git' &&
        c.args[0] === 'restore' &&
        c.args.includes('--worktree'),
    );
    expect(worktreeRestore).toHaveLength(0);
  });

  it('emits autofix_banned_file_unstaged audit event for each banned file', async () => {
    const restoreCalls: string[][] = [];

    _spawnHook = (cmd, args) => {
      const a = Array.isArray(args) ? (args as string[]) : [];
      if (cmd === 'git' && a[0] === 'status')
        return makeProc(0, 'M  CLAUDE.md\nM  .commit-msg\nM  src/ok.ts\n');
      if (cmd === 'git' && a[0] === 'add') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'restore') {
        restoreCalls.push(a);
        return makeProc(0, '');
      }
      if (cmd === 'git' && a[0] === 'diff' && a[1] === '--cached') {
        if (restoreCalls.length === 0)
          return makeProc(0, 'CLAUDE.md\n.commit-msg\nsrc/ok.ts\n');
        return makeProc(0, 'src/ok.ts\n');
      }
      if (cmd === 'git' && a[0] === 'diff' && a[1] === '--name-only')
        return makeProc(0, 'src/ok.ts\n');
      if (cmd === 'git' && a[0] === 'commit') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'push') return makeProc(0, '');
      if (cmd === 'git' && a[0] === 'rev-parse') {
        if (a[1] === '--abbrev-ref') return makeProc(0, 'feature/x\n');
        return makeProc(0, 'sha\n');
      }
      return makeProc(0, '');
    };

    await runAutofix('/worktree', '/project', ['echo hi'], () => {});

    const bannedEvents = vi
      .mocked(recordEvent)
      .mock.calls.filter(
        ([e]) => e.event_type === 'autofix_banned_file_unstaged',
      );
    expect(bannedEvents).toHaveLength(2);

    const files = bannedEvents.map(
      ([e]) => (e.payload as { file: string }).file,
    );
    expect(files).toContain('CLAUDE.md');
    expect(files).toContain('.commit-msg');
  });
});
