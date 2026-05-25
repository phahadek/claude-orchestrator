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
