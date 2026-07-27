/**
 * Regression coverage for the checkout-lockdown revert: a planning session
 * must leave every path under the checkout writable — no OS-level
 * enforcement — while still receiving a writable per-session scratch dir
 * that is removed when the session ends.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

vi.mock('../../config', () => ({
  config: { claudePath: '/fake/claude' },
  BASH_MAX_OUTPUT_LENGTH: 30000,
  BASH_DEFAULT_TIMEOUT_MS: 300000,
  PLANNING_DISALLOWED_TOOLS: ['Skill', 'Write', 'Edit'],
}));

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
  spawn: vi.fn(() => makeMockProc()),
  execSync: vi.fn(() => ''),
}));

import { CliSessionRunner } from '../CliSessionRunner';

function canWrite(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';

describe('CliSessionRunner — planning sessions leave the checkout writable', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'checkout-writable-test-'),
    );
    fs.writeFileSync(path.join(projectDir, 'README.md'), 'hello\n');
    fs.mkdirSync(path.join(projectDir, '.git'));
    fs.writeFileSync(
      path.join(projectDir, '.git', 'HEAD'),
      'ref: refs/heads/main\n',
    );
    fs.mkdirSync(path.join(projectDir, '.claude', 'session-prompts'), {
      recursive: true,
    });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('leaves .git, .claude/session-prompts, and a source file writable throughout the session, with no permission change', async () => {
    const before = {
      readme: fs.statSync(path.join(projectDir, 'README.md')).mode,
      gitHead: fs.statSync(path.join(projectDir, '.git', 'HEAD')).mode,
      sessionPrompts: fs.statSync(
        path.join(projectDir, '.claude', 'session-prompts'),
      ).mode,
    };

    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      {
        worktreePath: projectDir,
        model: undefined,
        allowedTools: ['Bash'],
        sessionType: 'groom',
      },
      () => {},
    );

    expect(canWrite(path.join(projectDir, 'README.md'))).toBe(true);
    expect(canWrite(path.join(projectDir, '.git', 'HEAD'))).toBe(true);
    expect(canWrite(path.join(projectDir, '.claude', 'session-prompts'))).toBe(
      true,
    );

    expect(fs.statSync(path.join(projectDir, 'README.md')).mode).toBe(
      before.readme,
    );
    expect(fs.statSync(path.join(projectDir, '.git', 'HEAD')).mode).toBe(
      before.gitHead,
    );
    expect(
      fs.statSync(path.join(projectDir, '.claude', 'session-prompts')).mode,
    ).toBe(before.sessionPrompts);
  });

  it('creates a writable scratch dir for the session and removes it when the session ends', async () => {
    const scratchDir = path.join(projectDir, '.claude', 'scratch', SESSION_ID);

    const runner = new CliSessionRunner(SESSION_ID);
    const runPromise = runner.run(
      'hello',
      undefined,
      {
        worktreePath: projectDir,
        model: undefined,
        allowedTools: ['Bash'],
        sessionType: 'groom',
      },
      () => {},
    );

    // createScratchDir runs synchronously before the first await in run(),
    // so it already exists once run() has been invoked.
    expect(fs.existsSync(scratchDir)).toBe(true);
    expect(canWrite(scratchDir)).toBe(true);

    await runPromise;

    // Removed once the session ends.
    expect(fs.existsSync(scratchDir)).toBe(false);
  });
});
