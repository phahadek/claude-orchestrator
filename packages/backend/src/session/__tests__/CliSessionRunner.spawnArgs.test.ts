import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  SCHEDULING_DISALLOWED_TOOLS: [
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

// planningScratchDir does real fs work (mkdir/rm the scratch dir) —
// irrelevant to these spawn-arg assertions and unsafe against a fake
// '/fake/worktree' path.
vi.mock('../planningScratchDir', () => ({
  createScratchDir: vi.fn(() => '/fake/worktree/.claude/scratch/fake'),
  removeScratchDir: vi.fn(),
  getScratchDir: vi.fn(() => '/fake/worktree/.claude/scratch/fake'),
}));

import path from 'path';
import fs from 'fs';
import os from 'os';
import { CliSessionRunner } from '../CliSessionRunner';
import { getTestCommandDenyPatterns } from '../orchestrator-config';

const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';
const RESUME_ID = 'bbbbcccc-dddd-eeee-ffff-aaaaaaaaaaaa';

const CONFIG_BASELINE = [
  path.join('/fake/config', 'procedures.md'),
  path.join('/fake/config', 'task-writing.md'),
  path.join('/fake/config', 'README.md'),
  path.join('/fake/config', 'guidelines-baseline.json'),
  path.join('/fake/config', 'projects', 'worktree', 'context.md'),
  path.join('/fake/config', 'projects', 'worktree', 'investigation-guide.md'),
  path.join('/fake/config', 'projects', 'worktree', 'grooming.json'),
];

const defaultOptions = {
  worktreePath: '/fake/worktree',
  model: undefined as string | undefined,
  allowedTools: ['Bash'],
};

beforeEach(() => {
  capturedSpawnArgs = [];
  capturedSpawnOptions = {};
  // getSessionAddDirs (orchestrator-config.ts) resolves the central config
  // tree via $ORCHESTRATOR_CONFIG_DIR — set it to a fixed path so the
  // baseline is deterministic and doesn't depend on real fs layout relative
  // to the fake worktree path.
  process.env.ORCHESTRATOR_CONFIG_DIR = '/fake/config';
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.ORCHESTRATOR_CONFIG_DIR;
});

describe('CliSessionRunner env stripping', () => {
  afterEach(() => {
    delete process.env.DB_PATH;
    delete process.env.ORCHESTRATOR_DEVICE_TOKEN;
  });

  it('strips DB_PATH from the child env', async () => {
    process.env.DB_PATH = '/fake/production.db';
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    const env = capturedSpawnOptions.env as Record<string, string>;
    expect(env.DB_PATH).toBeUndefined();
  });

  it('strips the shared ORCHESTRATOR_DEVICE_TOKEN from the child env even when set on the backend process', async () => {
    process.env.ORCHESTRATOR_DEVICE_TOKEN = 'shared-device-token';
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    const env = capturedSpawnOptions.env as Record<string, string>;
    expect(env.ORCHESTRATOR_DEVICE_TOKEN).toBeUndefined();
  });

  it('does not strip unrelated env vars (e.g. PROJECT_DIR)', async () => {
    process.env.PROJECT_DIR = '/fake/project';
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    const env = capturedSpawnOptions.env as Record<string, string>;
    expect(env.PROJECT_DIR).toBe('/fake/project');
    delete process.env.PROJECT_DIR;
  });

  it('a session-scoped extraEnv credential file path passes through untouched', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      {
        ...defaultOptions,
        extraEnv: {
          ORCHESTRATOR_ROUTE_CREDENTIAL_FILE: '/fake/data/session.token',
        },
      },
      () => {},
    );

    const env = capturedSpawnOptions.env as Record<string, string>;
    expect(env.ORCHESTRATOR_ROUTE_CREDENTIAL_FILE).toBe(
      '/fake/data/session.token',
    );
  });
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

  it.each(['standard', 'review', 'depth_review'] as const)(
    'includes only --disallowed-tools ScheduleWakeup, CronCreate, CronDelete, CronList (no Write/Edit) for a %s (non-planning) session',
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
      expect(capturedSpawnArgs[idx + 1]).toBe('ScheduleWakeup');
      expect(capturedSpawnArgs[idx + 2]).toBe('CronCreate');
      expect(capturedSpawnArgs[idx + 3]).toBe('CronDelete');
      expect(capturedSpawnArgs[idx + 4]).toBe('CronList');
      expect(capturedSpawnArgs).not.toContain('Write');
      expect(capturedSpawnArgs).not.toContain('Edit');
    },
  );

  it('includes the scheduling-only --disallowed-tools set when sessionType is absent', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    const idx = capturedSpawnArgs.indexOf('--disallowed-tools');
    expect(idx).not.toBe(-1);
    expect(capturedSpawnArgs[idx + 1]).toBe('ScheduleWakeup');
    expect(capturedSpawnArgs[idx + 2]).toBe('CronCreate');
    expect(capturedSpawnArgs[idx + 3]).toBe('CronDelete');
    expect(capturedSpawnArgs[idx + 4]).toBe('CronList');
  });
});

describe('CliSessionRunner --add-dir (filesystem read envelope)', () => {
  function addDirValues(args: string[]): string[] {
    return args.reduce<string[]>((acc, arg, i) => {
      if (arg === '--add-dir') acc.push(args[i + 1]);
      return acc;
    }, []);
  }

  it.each(['groom', 'design', 'ops', 'docs', 'split'] as const)(
    'includes the per-type baseline --add-dir entries for a %s (planning) session — no more unconditional "/"',
    async (sessionType) => {
      const runner = new CliSessionRunner(SESSION_ID);
      await runner.run(
        'hello',
        undefined,
        { ...defaultOptions, sessionType },
        () => {},
      );

      expect(addDirValues(capturedSpawnArgs).sort()).toEqual(
        [...CONFIG_BASELINE].sort(),
      );
      expect(capturedSpawnArgs).not.toContain('/');
    },
  );

  it('gate-verify sessions (dispatched with sessionType "ops") get the same baseline', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      { ...defaultOptions, sessionType: 'ops' },
      () => {},
    );

    expect(addDirValues(capturedSpawnArgs).sort()).toEqual(
      [...CONFIG_BASELINE].sort(),
    );
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

  it('a granted capability naming an out-of-tree host path is executable for an ops session (allowlisted, not baseline-confined)', async () => {
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
    expect(addDirValues(capturedSpawnArgs).sort()).toEqual(
      [...CONFIG_BASELINE].sort(),
    );
  });

  it('adds exactly one granted read:path: root to --add-dir on top of the baseline', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    const grantedPath = '/srv/orchestrator/data/some-project';
    await runner.run(
      'hello',
      undefined,
      {
        ...defaultOptions,
        sessionType: 'ops',
        granted: [`read:path:${grantedPath}`],
      },
      () => {},
    );

    expect(addDirValues(capturedSpawnArgs).sort()).toEqual(
      [...CONFIG_BASELINE, grantedPath].sort(),
    );
  });
});

describe('CliSessionRunner test-command deny patterns', () => {
  let worktreeDir: string;

  beforeEach(() => {
    worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-deny-test-'));
    fs.writeFileSync(
      path.join(worktreeDir, '.claude-orchestrator.yml'),
      'test:\n  - npm test\n  - npm run test:unit\n',
    );
  });

  afterEach(() => {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  });

  it('denies the configured test commands for a standard (code) session', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      { ...defaultOptions, worktreePath: worktreeDir, sessionType: 'standard' },
      () => {},
    );

    const settingsIdx = capturedSpawnArgs.indexOf('--settings');
    expect(settingsIdx).not.toBe(-1);
    const settings = JSON.parse(capturedSpawnArgs[settingsIdx + 1]);
    expect(settings.permissions.deny).toEqual(
      getTestCommandDenyPatterns(['npm test', 'npm run test:unit']),
    );
  });

  it('merges the test-command deny list with autoCompactEnabled into one --settings JSON', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      {
        ...defaultOptions,
        worktreePath: worktreeDir,
        sessionType: 'standard',
        disableAutoCompact: true,
      },
      () => {},
    );

    const settingsIdx = capturedSpawnArgs.indexOf('--settings');
    const settings = JSON.parse(capturedSpawnArgs[settingsIdx + 1]);
    expect(settings.autoCompactEnabled).toBe(false);
    expect(settings.permissions.deny).toEqual(
      getTestCommandDenyPatterns(['npm test', 'npm run test:unit']),
    );
  });

  it('does not deny test commands for a non-code session (e.g. review)', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      { ...defaultOptions, worktreePath: worktreeDir, sessionType: 'review' },
      () => {},
    );

    expect(capturedSpawnArgs).not.toContain('--settings');
  });

  it('leaves the coarse npm/npx/node/tsc allow entries in --allowed-tools untouched', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      {
        ...defaultOptions,
        worktreePath: worktreeDir,
        sessionType: 'standard',
        allowedTools: [
          'Bash(npm:*)',
          'Bash(npx:*)',
          'Bash(node:*)',
          'Bash(tsc:*)',
        ],
      },
      () => {},
    );

    expect(capturedSpawnArgs).toContain('Bash(npm:*)');
    expect(capturedSpawnArgs).toContain('Bash(npx:*)');
    expect(capturedSpawnArgs).toContain('Bash(node:*)');
    expect(capturedSpawnArgs).toContain('Bash(tsc:*)');
  });
});
