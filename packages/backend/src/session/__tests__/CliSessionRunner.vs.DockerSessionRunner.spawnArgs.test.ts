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

// Captures args passed to spawn(), keyed by which binary was spawned —
// CliSessionRunner spawns the claude binary directly, DockerSessionRunner
// spawns `docker exec -i <container> <claudeBin> ...claudeArgs`.
let lastCliArgs: string[] = [];
let lastDockerExecArgs: string[] = [];

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
  setImmediate(() => {
    stdout.push(null);
    proc.emit('exit', 0);
  });
  return proc;
}

vi.mock('child_process', () => ({
  spawn: vi.fn((cmd: string, args: string[]) => {
    if (cmd === 'docker') {
      // args: ['exec', '-i', containerName, claudeBin, ...claudeArgs]
      lastDockerExecArgs = args.slice(4);
    } else {
      lastCliArgs = args;
    }
    return makeMockProc();
  }),
  execSync: vi.fn(() => ''),
}));

import { CliSessionRunner } from '../CliSessionRunner';
import { DockerSessionRunner } from '../DockerSessionRunner';

const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';

const defaultOptions = {
  worktreePath: '/fake/worktree',
  model: undefined as string | undefined,
  allowedTools: ['Bash', 'Read'],
};

beforeEach(() => {
  lastCliArgs = [];
  lastDockerExecArgs = [];
  vi.clearAllMocks();
});

function extractFlagList(args: string[], flag: string): string[] {
  const idx = args.indexOf(flag);
  if (idx === -1) return [];
  const rest = args.slice(idx + 1);
  const nextFlagIdx = rest.findIndex((a) => a.startsWith('--'));
  return nextFlagIdx === -1 ? rest : rest.slice(0, nextFlagIdx);
}

describe('CliSessionRunner vs DockerSessionRunner — planning session CLI parity', () => {
  it.each(['groom', 'design', 'ops', 'split'] as const)(
    'produce identical --allowed-tools / --disallowed-tools / --permission-mode / --add-dir for sessionType=%s',
    async (sessionType) => {
      const cliRunner = new CliSessionRunner(SESSION_ID);
      await cliRunner.run(
        'hello',
        undefined,
        { ...defaultOptions, sessionType },
        () => {},
      );
      const cliArgs = lastCliArgs;

      const dockerRunner = new DockerSessionRunner(SESSION_ID);
      await dockerRunner.run(
        'hello',
        undefined,
        { ...defaultOptions, sessionType },
        () => {},
      );
      const dockerArgs = lastDockerExecArgs;

      expect(extractFlagList(dockerArgs, '--allowed-tools')).toEqual(
        extractFlagList(cliArgs, '--allowed-tools'),
      );
      expect(extractFlagList(dockerArgs, '--disallowed-tools')).toEqual(
        extractFlagList(cliArgs, '--disallowed-tools'),
      );

      const cliPermIdx = cliArgs.indexOf('--permission-mode');
      const dockerPermIdx = dockerArgs.indexOf('--permission-mode');
      expect(dockerArgs[dockerPermIdx + 1]).toBe(cliArgs[cliPermIdx + 1]);

      expect(dockerArgs.includes('--add-dir')).toBe(
        cliArgs.includes('--add-dir'),
      );
    },
  );

  it.each(['standard', 'review'] as const)(
    'produce identical (empty) --disallowed-tools / --add-dir for non-planning sessionType=%s',
    async (sessionType) => {
      const cliRunner = new CliSessionRunner(SESSION_ID);
      await cliRunner.run(
        'hello',
        undefined,
        { ...defaultOptions, sessionType },
        () => {},
      );
      const cliArgs = lastCliArgs;

      const dockerRunner = new DockerSessionRunner(SESSION_ID);
      await dockerRunner.run(
        'hello',
        undefined,
        { ...defaultOptions, sessionType },
        () => {},
      );
      const dockerArgs = lastDockerExecArgs;

      expect(dockerArgs.includes('--disallowed-tools')).toBe(
        cliArgs.includes('--disallowed-tools'),
      );
      expect(dockerArgs.includes('--add-dir')).toBe(
        cliArgs.includes('--add-dir'),
      );

      const cliPermIdx = cliArgs.indexOf('--permission-mode');
      const dockerPermIdx = dockerArgs.indexOf('--permission-mode');
      expect(dockerArgs[dockerPermIdx + 1]).toBe(cliArgs[cliPermIdx + 1]);
    },
  );
});
