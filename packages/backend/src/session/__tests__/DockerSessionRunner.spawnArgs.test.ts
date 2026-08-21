import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

vi.mock('../../config', () => ({
  config: { claudePath: '/fake/claude' },
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

// Capture the args passed to spawn('docker', ...) so we can assert on them.
let capturedDockerArgs: string[] = [];

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
  spawn: vi.fn((_cmd: string, args: string[]) => {
    capturedDockerArgs = args;
    return makeMockProc();
  }),
  execSync: vi.fn(() => ''),
}));

// planningScratchDir does real fs work (mkdir/rm the scratch dir) —
// irrelevant to these spawn-arg assertions and unsafe against a fake
// '/fake/worktree' path.
vi.mock('../planningScratchDir', () => ({
  createScratchDir: vi.fn(() => '/fake/worktree/.claude/scratch/fake'),
  removeScratchDir: vi.fn(),
}));

import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import { DockerSessionRunner } from '../DockerSessionRunner';
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

/** The `docker run -d ... <containerName> ...` command string for the session container (3rd execSync call). */
function sessionContainerRunCommand(): string {
  const calls = vi.mocked(execSync).mock.calls;
  const call = calls.find(
    (c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('sleep infinity'),
  );
  if (!call) throw new Error('session container docker run command not found');
  return call[0] as string;
}

const defaultOptions = {
  worktreePath: '/fake/worktree',
  model: undefined as string | undefined,
  allowedTools: ['Bash'],
};

beforeEach(() => {
  capturedDockerArgs = [];
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

describe('DockerSessionRunner spawn args', () => {
  it('initial spawn passes --session-id <sessionId> to claude and not --resume', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    // The docker exec args are: ['exec', '-i', containerName, claudeBin, ...claudeArgs]
    // claudeArgs start after claudeBin at index 4.
    const claudeArgs = capturedDockerArgs.slice(4);
    expect(claudeArgs).toContain('--session-id');
    expect(claudeArgs).toContain(SESSION_ID);
    expect(claudeArgs).not.toContain('--resume');
    const idx = claudeArgs.indexOf('--session-id');
    expect(claudeArgs[idx + 1]).toBe(SESSION_ID);
  });

  it('resume spawn passes --resume <resumeSessionId> to claude and not --session-id', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
    await runner.run(undefined, RESUME_ID, defaultOptions, () => {});

    const claudeArgs = capturedDockerArgs.slice(4);
    expect(claudeArgs).toContain('--resume');
    expect(claudeArgs).toContain(RESUME_ID);
    expect(claudeArgs).not.toContain('--session-id');
    const idx = claudeArgs.indexOf('--resume');
    expect(claudeArgs[idx + 1]).toBe(RESUME_ID);
  });
});

describe('DockerSessionRunner --permission-mode', () => {
  it('uses acceptEdits for a standard (code) session', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      { ...defaultOptions, sessionType: 'standard' },
      () => {},
    );

    const claudeArgs = capturedDockerArgs.slice(4);
    const idx = claudeArgs.indexOf('--permission-mode');
    expect(idx).not.toBe(-1);
    expect(claudeArgs[idx + 1]).toBe('acceptEdits');
  });

  it('uses acceptEdits when sessionType is absent (back-compat default)', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    const claudeArgs = capturedDockerArgs.slice(4);
    const idx = claudeArgs.indexOf('--permission-mode');
    expect(claudeArgs[idx + 1]).toBe('acceptEdits');
  });

  it.each(['groom', 'design', 'ops'] as const)(
    'does not use acceptEdits for a %s (planning) session',
    async (sessionType) => {
      const runner = new DockerSessionRunner(SESSION_ID);
      await runner.run(
        'hello',
        undefined,
        { ...defaultOptions, sessionType },
        () => {},
      );

      const claudeArgs = capturedDockerArgs.slice(4);
      const idx = claudeArgs.indexOf('--permission-mode');
      expect(idx).not.toBe(-1);
      expect(claudeArgs[idx + 1]).toBe('default');
    },
  );
});

describe('DockerSessionRunner --disallowed-tools', () => {
  it.each(['groom', 'design', 'ops'] as const)(
    'includes --disallowed-tools Skill, Write, Edit, ScheduleWakeup, CronCreate, CronDelete, CronList for a %s (planning) session',
    async (sessionType) => {
      const runner = new DockerSessionRunner(SESSION_ID);
      await runner.run(
        'hello',
        undefined,
        { ...defaultOptions, sessionType },
        () => {},
      );

      const claudeArgs = capturedDockerArgs.slice(4);
      const idx = claudeArgs.indexOf('--disallowed-tools');
      expect(idx).not.toBe(-1);
      expect(claudeArgs[idx + 1]).toBe('Skill');
      expect(claudeArgs[idx + 2]).toBe('Write');
      expect(claudeArgs[idx + 3]).toBe('Edit');
      expect(claudeArgs[idx + 4]).toBe('ScheduleWakeup');
      expect(claudeArgs[idx + 5]).toBe('CronCreate');
      expect(claudeArgs[idx + 6]).toBe('CronDelete');
      expect(claudeArgs[idx + 7]).toBe('CronList');
    },
  );

  it.each(['standard', 'review', 'depth_review'] as const)(
    'includes only --disallowed-tools ScheduleWakeup, CronCreate, CronDelete, CronList (no Write/Edit) for a %s (non-planning) session',
    async (sessionType) => {
      const runner = new DockerSessionRunner(SESSION_ID);
      await runner.run(
        'hello',
        undefined,
        { ...defaultOptions, sessionType },
        () => {},
      );

      const claudeArgs = capturedDockerArgs.slice(4);
      const idx = claudeArgs.indexOf('--disallowed-tools');
      expect(idx).not.toBe(-1);
      expect(claudeArgs[idx + 1]).toBe('ScheduleWakeup');
      expect(claudeArgs[idx + 2]).toBe('CronCreate');
      expect(claudeArgs[idx + 3]).toBe('CronDelete');
      expect(claudeArgs[idx + 4]).toBe('CronList');
      expect(claudeArgs).not.toContain('Write');
      expect(claudeArgs).not.toContain('Edit');
    },
  );
});

describe('DockerSessionRunner --add-dir (filesystem read envelope)', () => {
  function addDirValues(args: string[]): string[] {
    return args.reduce<string[]>((acc, arg, i) => {
      if (arg === '--add-dir') acc.push(args[i + 1]);
      return acc;
    }, []);
  }

  it.each(['groom', 'design', 'ops', 'docs', 'split'] as const)(
    'includes the per-type baseline --add-dir entries for a %s (planning) session — no more unconditional "/"',
    async (sessionType) => {
      const runner = new DockerSessionRunner(SESSION_ID);
      await runner.run(
        'hello',
        undefined,
        { ...defaultOptions, sessionType },
        () => {},
      );

      const claudeArgs = capturedDockerArgs.slice(4);
      expect(addDirValues(claudeArgs).sort()).toEqual(
        [...CONFIG_BASELINE].sort(),
      );
      expect(claudeArgs).not.toContain('/');
    },
  );

  it.each(['standard', 'review'] as const)(
    'omits --add-dir for a %s (non-planning) session',
    async (sessionType) => {
      const runner = new DockerSessionRunner(SESSION_ID);
      await runner.run(
        'hello',
        undefined,
        { ...defaultOptions, sessionType },
        () => {},
      );

      const claudeArgs = capturedDockerArgs.slice(4);
      expect(claudeArgs).not.toContain('--add-dir');
    },
  );

  it('omits --add-dir when sessionType is absent', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    const claudeArgs = capturedDockerArgs.slice(4);
    expect(claudeArgs).not.toContain('--add-dir');
  });

  it('adds exactly one granted read:path: root to --add-dir on top of the baseline', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
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

    const claudeArgs = capturedDockerArgs.slice(4);
    expect(addDirValues(claudeArgs).sort()).toEqual(
      [...CONFIG_BASELINE, grantedPath].sort(),
    );
  });

  it('mounts each baseline + granted path read-only on the session container docker run invocation', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
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

    const runCmd = sessionContainerRunCommand();
    for (const dir of [...CONFIG_BASELINE, grantedPath]) {
      expect(runCmd).toContain(`-v "${dir}:${dir}:ro"`);
    }
  });

  it('adds no extra -v mounts on the session container for a non-planning session', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      { ...defaultOptions, sessionType: 'standard' },
      () => {},
    );

    const runCmd = sessionContainerRunCommand();
    for (const dir of CONFIG_BASELINE) {
      expect(runCmd).not.toContain(`-v "${dir}:${dir}:ro"`);
    }
  });
});

describe('DockerSessionRunner --mcp-config / --append-system-prompt-file', () => {
  it('passes --mcp-config <path> --strict-mcp-config when mcpConfigPath is set', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      { ...defaultOptions, mcpConfigPath: '/fake/mcp-config.json' },
      () => {},
    );

    const claudeArgs = capturedDockerArgs.slice(4);
    const idx = claudeArgs.indexOf('--mcp-config');
    expect(idx).not.toBe(-1);
    expect(claudeArgs[idx + 1]).toBe('/fake/mcp-config.json');
    expect(claudeArgs).toContain('--strict-mcp-config');
  });

  it('omits --mcp-config when mcpConfigPath is absent', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    const claudeArgs = capturedDockerArgs.slice(4);
    expect(claudeArgs).not.toContain('--mcp-config');
    expect(claudeArgs).not.toContain('--strict-mcp-config');
  });

  it('passes --append-system-prompt-file <path> when systemPromptFilePath is set', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      { ...defaultOptions, systemPromptFilePath: '/fake/system-prompt.txt' },
      () => {},
    );

    const claudeArgs = capturedDockerArgs.slice(4);
    const idx = claudeArgs.indexOf('--append-system-prompt-file');
    expect(idx).not.toBe(-1);
    expect(claudeArgs[idx + 1]).toBe('/fake/system-prompt.txt');
  });

  it('omits --append-system-prompt-file when systemPromptFilePath is absent', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    const claudeArgs = capturedDockerArgs.slice(4);
    expect(claudeArgs).not.toContain('--append-system-prompt-file');
  });
});

describe('DockerSessionRunner test-command deny patterns', () => {
  let worktreeDir: string;

  beforeEach(() => {
    worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-deny-test-'));
    fs.writeFileSync(
      path.join(worktreeDir, '.claude-orchestrator.yml'),
      'test:\n  - npm test\n',
    );
  });

  afterEach(() => {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  });

  it('denies the configured test commands for a standard (code) session', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      { ...defaultOptions, worktreePath: worktreeDir, sessionType: 'standard' },
      () => {},
    );

    const claudeArgs = capturedDockerArgs.slice(4);
    const settingsIdx = claudeArgs.indexOf('--settings');
    expect(settingsIdx).not.toBe(-1);
    const settings = JSON.parse(claudeArgs[settingsIdx + 1]);
    expect(settings.permissions.deny).toEqual(
      getTestCommandDenyPatterns(['npm test']),
    );
  });

  it('does not deny test commands for a non-code session (e.g. review)', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      { ...defaultOptions, worktreePath: worktreeDir, sessionType: 'review' },
      () => {},
    );

    const claudeArgs = capturedDockerArgs.slice(4);
    expect(claudeArgs).not.toContain('--settings');
  });
});
