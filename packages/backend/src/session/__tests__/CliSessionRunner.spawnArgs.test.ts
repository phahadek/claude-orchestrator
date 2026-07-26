import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

vi.mock('../../config', () => ({
  config: { claudePath: '/fake/claude' },
  BASH_MAX_OUTPUT_LENGTH: 30000,
  BASH_DEFAULT_TIMEOUT_MS: 300000,
  PLANNING_DISALLOWED_TOOLS: [
    'Skill',
    'Write',
    'Edit',
    'ScheduleWakeup',
    'CronCreate',
    'CronDelete',
    'CronList',
  ],
}));

// We capture the args and options passed to spawn so we can assert on them.
let capturedSpawnArgs: string[] = [];
let capturedSpawnOptions: Record<string, unknown> = {};

function makeMockProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: Object.assign(stdin, { writable: true, end: vi.fn() }),
    pid: 999,
    exitCode: null as number | null,
  });
  // Push EOF then emit exit so readline closes and run() resolves.
  setImmediate(() => {
    stdout.push(null);
    proc.emit('exit', 0);
  });
  return proc;
}

vi.mock('child_process', () => ({
  spawn: vi.fn(
    (_cmd: string, args: string[], options: Record<string, unknown>) => {
      capturedSpawnArgs = args;
      capturedSpawnOptions = options;
      return makeMockProc();
    },
  ),
  execSync: vi.fn(() => ''),
}));

// checkoutLockdown does real fs/DB work (mkdir the scratch dir, chmod the
// checkout, persist a ref-count row) — irrelevant to these spawn-arg
// assertions and unsafe against a fake '/fake/worktree' path. Covered by
// its own dedicated test file instead.
vi.mock('../checkoutLockdown', () => ({
  acquireCheckoutLockdown: vi.fn(() => '/fake/worktree/.claude/scratch/fake'),
  releaseCheckoutLockdown: vi.fn(),
}));

import { CliSessionRunner } from '../CliSessionRunner';

const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';
const RESUME_ID = 'bbbbcccc-dddd-eeee-ffff-aaaaaaaaaaaa';

const defaultOptions = {
  worktreePath: '/fake/worktree',
  model: undefined as string | undefined,
  allowedTools: ['Bash'],
};

beforeEach(() => {
  capturedSpawnArgs = [];
  capturedSpawnOptions = {};
  vi.clearAllMocks();
});

describe('CliSessionRunner spawn args', () => {
  it('initial spawn includes --session-id <sessionId> and not --resume', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    expect(capturedSpawnArgs).toContain('--session-id');
    expect(capturedSpawnArgs).toContain(SESSION_ID);
    expect(capturedSpawnArgs).not.toContain('--resume');
    // --session-id must immediately precede SESSION_ID
    const idx = capturedSpawnArgs.indexOf('--session-id');
    expect(capturedSpawnArgs[idx + 1]).toBe(SESSION_ID);
  });

  it('resume spawn includes --resume <resumeSessionId> and not --session-id', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run(undefined, RESUME_ID, defaultOptions, () => {});

    expect(capturedSpawnArgs).toContain('--resume');
    expect(capturedSpawnArgs).toContain(RESUME_ID);
    expect(capturedSpawnArgs).not.toContain('--session-id');
    const idx = capturedSpawnArgs.indexOf('--resume');
    expect(capturedSpawnArgs[idx + 1]).toBe(RESUME_ID);
  });

  it('spawn env carries BASH_MAX_OUTPUT_LENGTH=30000 and BASH_DEFAULT_TIMEOUT_MS=300000', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    const env = capturedSpawnOptions.env as Record<string, string>;
    expect(env.BASH_MAX_OUTPUT_LENGTH).toBe('30000');
    expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe('300000');
  });

  it('includes --settings autoCompactEnabled:false when disableAutoCompact is true', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      { ...defaultOptions, disableAutoCompact: true },
      () => {},
    );

    const settingsIdx = capturedSpawnArgs.indexOf('--settings');
    expect(settingsIdx).not.toBe(-1);
    expect(capturedSpawnArgs[settingsIdx + 1]).toBe(
      '{"autoCompactEnabled":false}',
    );
  });

  it('does not include --settings when disableAutoCompact is false', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      { ...defaultOptions, disableAutoCompact: false },
      () => {},
    );

    expect(capturedSpawnArgs).not.toContain('--settings');
  });

  it('does not include --settings when disableAutoCompact is absent', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    expect(capturedSpawnArgs).not.toContain('--settings');
  });

  it('includes --effort xhigh when effort is "xhigh"', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      { ...defaultOptions, effort: 'xhigh' },
      () => {},
    );

    const idx = capturedSpawnArgs.indexOf('--effort');
    expect(idx).not.toBe(-1);
    expect(capturedSpawnArgs[idx + 1]).toBe('xhigh');
  });

  it('omits --effort when effort is empty string', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      { ...defaultOptions, effort: '' },
      () => {},
    );

    expect(capturedSpawnArgs).not.toContain('--effort');
  });

  it('omits --effort when effort is undefined', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    expect(capturedSpawnArgs).not.toContain('--effort');
  });

  it('disableAutoCompact can be set independently per spawn', async () => {
    const runner1 = new CliSessionRunner(SESSION_ID);
    await runner1.run(
      'hello',
      undefined,
      { ...defaultOptions, disableAutoCompact: true },
      () => {},
    );
    const argsWithDisabled = [...capturedSpawnArgs];

    const runner2 = new CliSessionRunner(SESSION_ID);
    await runner2.run(
      'hello',
      undefined,
      { ...defaultOptions, disableAutoCompact: false },
      () => {},
    );
    const argsWithEnabled = [...capturedSpawnArgs];

    expect(argsWithDisabled).toContain('--settings');
    expect(argsWithEnabled).not.toContain('--settings');
  });
});

describe('CliSessionRunner --permission-mode', () => {
  it('uses acceptEdits for a standard (code) session', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      { ...defaultOptions, sessionType: 'standard' },
      () => {},
    );

    const idx = capturedSpawnArgs.indexOf('--permission-mode');
    expect(idx).not.toBe(-1);
    expect(capturedSpawnArgs[idx + 1]).toBe('acceptEdits');
  });

  it('uses acceptEdits when sessionType is absent (back-compat default)', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    const idx = capturedSpawnArgs.indexOf('--permission-mode');
    expect(capturedSpawnArgs[idx + 1]).toBe('acceptEdits');
  });

  it.each(['groom', 'design', 'ops'] as const)(
    'does not use acceptEdits for a %s (planning) session',
    async (sessionType) => {
      const runner = new CliSessionRunner(SESSION_ID);
      await runner.run(
        'hello',
        undefined,
        { ...defaultOptions, sessionType },
        () => {},
      );

      const idx = capturedSpawnArgs.indexOf('--permission-mode');
      expect(idx).not.toBe(-1);
      expect(capturedSpawnArgs[idx + 1]).not.toBe('acceptEdits');
    },
  );
});

describe('CliSessionRunner --disallowed-tools', () => {
  it.each(['groom', 'design', 'ops'] as const)(
    'includes --disallowed-tools Skill, Write, Edit, ScheduleWakeup, CronCreate, CronDelete, CronList for a %s (planning) session',
    async (sessionType) => {
      const runner = new CliSessionRunner(SESSION_ID);
      await runner.run(
        'hello',
        undefined,
        { ...defaultOptions, sessionType },
        () => {},
      );

      const idx = capturedSpawnArgs.indexOf('--disallowed-tools');
      expect(idx).not.toBe(-1);
      expect(capturedSpawnArgs[idx + 1]).toBe('Skill');
      expect(capturedSpawnArgs[idx + 2]).toBe('Write');
      expect(capturedSpawnArgs[idx + 3]).toBe('Edit');
      expect(capturedSpawnArgs[idx + 4]).toBe('ScheduleWakeup');
      expect(capturedSpawnArgs[idx + 5]).toBe('CronCreate');
      expect(capturedSpawnArgs[idx + 6]).toBe('CronDelete');
      expect(capturedSpawnArgs[idx + 7]).toBe('CronList');
    },
  );

  it.each(['standard', 'review'] as const)(
    'omits --disallowed-tools for a %s (non-planning) session',
    async (sessionType) => {
      const runner = new CliSessionRunner(SESSION_ID);
      await runner.run(
        'hello',
        undefined,
        { ...defaultOptions, sessionType },
        () => {},
      );

      expect(capturedSpawnArgs).not.toContain('--disallowed-tools');
    },
  );

  it('omits --disallowed-tools when sessionType is absent', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    expect(capturedSpawnArgs).not.toContain('--disallowed-tools');
  });
});

describe('CliSessionRunner --add-dir (directory sandbox lift)', () => {
  it.each(['groom', 'design', 'ops'] as const)(
    'includes --add-dir / for a %s (planning) session — no project-dir confinement',
    async (sessionType) => {
      const runner = new CliSessionRunner(SESSION_ID);
      await runner.run(
        'hello',
        undefined,
        { ...defaultOptions, sessionType },
        () => {},
      );

      const idx = capturedSpawnArgs.indexOf('--add-dir');
      expect(idx).not.toBe(-1);
      expect(capturedSpawnArgs[idx + 1]).toBe('/');
    },
  );

  it('gate-verify sessions (dispatched with sessionType "ops") get the same lift', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      { ...defaultOptions, sessionType: 'ops' },
      () => {},
    );

    expect(capturedSpawnArgs).toContain('--add-dir');
  });

  it.each(['standard', 'review'] as const)(
    'omits --add-dir for a %s (non-planning) session — stays confined to its worktree',
    async (sessionType) => {
      const runner = new CliSessionRunner(SESSION_ID);
      await runner.run(
        'hello',
        undefined,
        { ...defaultOptions, sessionType },
        () => {},
      );

      expect(capturedSpawnArgs).not.toContain('--add-dir');
    },
  );

  it('omits --add-dir when sessionType is absent', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    expect(capturedSpawnArgs).not.toContain('--add-dir');
  });

  it('a granted capability naming an out-of-tree host path is executable for an ops session (allowlisted + not dir-confined)', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    const grantedTool = 'Bash(find /srv/orchestrator/data:*)';
    await runner.run(
      'hello',
      undefined,
      {
        ...defaultOptions,
        sessionType: 'ops',
        allowedTools: ['Bash', grantedTool],
      },
      () => {},
    );

    const allowedIdx = capturedSpawnArgs.indexOf('--allowed-tools');
    expect(allowedIdx).not.toBe(-1);
    expect(capturedSpawnArgs).toContain(grantedTool);
    expect(capturedSpawnArgs).toContain('--add-dir');
    expect(capturedSpawnArgs[capturedSpawnArgs.indexOf('--add-dir') + 1]).toBe(
      '/',
    );
  });
});
