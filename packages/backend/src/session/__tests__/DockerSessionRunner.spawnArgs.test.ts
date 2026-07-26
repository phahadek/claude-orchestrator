import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// checkoutLockdown does real fs/DB work (mkdir the scratch dir, chmod the
// checkout, persist a ref-count row) — irrelevant to these spawn-arg
// assertions and unsafe against a fake '/fake/worktree' path. Covered by
// its own dedicated test file instead.
vi.mock('../checkoutLockdown', () => ({
  acquireCheckoutLockdown: vi.fn(() => '/fake/worktree/.claude/scratch/fake'),
  releaseCheckoutLockdown: vi.fn(),
}));

import { DockerSessionRunner } from '../DockerSessionRunner';

const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';
const RESUME_ID = 'bbbbcccc-dddd-eeee-ffff-aaaaaaaaaaaa';

const defaultOptions = {
  worktreePath: '/fake/worktree',
  model: undefined as string | undefined,
  allowedTools: ['Bash'],
};

beforeEach(() => {
  capturedDockerArgs = [];
  vi.clearAllMocks();
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

  it.each(['standard', 'review'] as const)(
    'omits --disallowed-tools for a %s (non-planning) session',
    async (sessionType) => {
      const runner = new DockerSessionRunner(SESSION_ID);
      await runner.run(
        'hello',
        undefined,
        { ...defaultOptions, sessionType },
        () => {},
      );

      const claudeArgs = capturedDockerArgs.slice(4);
      expect(claudeArgs).not.toContain('--disallowed-tools');
    },
  );
});

describe('DockerSessionRunner --add-dir (directory sandbox lift)', () => {
  it.each(['groom', 'design', 'ops'] as const)(
    'includes --add-dir / for a %s (planning) session',
    async (sessionType) => {
      const runner = new DockerSessionRunner(SESSION_ID);
      await runner.run(
        'hello',
        undefined,
        { ...defaultOptions, sessionType },
        () => {},
      );

      const claudeArgs = capturedDockerArgs.slice(4);
      const idx = claudeArgs.indexOf('--add-dir');
      expect(idx).not.toBe(-1);
      expect(claudeArgs[idx + 1]).toBe('/');
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
