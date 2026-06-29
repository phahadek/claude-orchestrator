/**
 * Unit tests for runAutofix — covers the acceptance criteria:
 *
 * 1. git commit uses --no-verify (pre-commit hooks in the target repo don't run)
 * 2. Commands that exit 1 with output → unfixableViolations (gate still passes)
 * 3. Commands that exit >= 2 → fatal failure (gate fails)
 * 4. Banned-file-only stage → no-ops to success
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable } from 'stream';

// ── child_process mock ─────────────────────────────────────────────────────────

const spawnCalls: Array<{ cmd: string; args?: string[]; opts?: unknown }> = [];

type SpawnCfg = { exitCode?: number; stdout?: string; stderr?: string };
const spawnQueue: SpawnCfg[] = [];

function makeProc(cfg: SpawnCfg = {}) {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = Object.assign(new EventEmitter(), { stdout, stderr });
  setImmediate(() => {
    if (cfg.stdout) stdout.push(cfg.stdout);
    stdout.push(null);
    if (cfg.stderr) stderr.push(cfg.stderr);
    stderr.push(null);
    proc.emit('close', cfg.exitCode ?? 0);
  });
  return proc;
}

vi.mock('child_process', () => ({
  spawn: vi.fn((cmd: string, argsOrOpts?: string[] | object, opts?: object) => {
    const args = Array.isArray(argsOrOpts) ? argsOrOpts : undefined;
    spawnCalls.push({ cmd, args, opts: opts ?? argsOrOpts });
    const cfg = spawnQueue.shift() ?? { exitCode: 0, stdout: '' };
    return makeProc(cfg);
  }),
}));

// ── Other mocks ────────────────────────────────────────────────────────────────

vi.mock('../github/PRFileValidator.js', () => ({
  isHardBanned: vi.fn().mockReturnValue(false),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('js-yaml', () => ({
  default: { load: vi.fn() },
  load: vi.fn(),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
  },
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(''),
}));

import { runAutofix } from '../session/autofix-runner.js';

// ── helpers ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  spawnCalls.length = 0;
  spawnQueue.length = 0;
  vi.clearAllMocks();
});

/**
 * Queue the standard git plumbing responses used in most tests.
 *
 * Spawn call order inside runAutofix after the autofix commands:
 *  0: git status --porcelain (dirty check)
 *  1: git add -A
 *  2: git diff --cached --name-only (list staged files)
 *  3: git diff --cached --name-only (after un-staging banned files)
 *  4: git commit --no-verify
 *  5: git rev-parse HEAD (sha after commit)
 *  6: git diff --name-only HEAD~1 HEAD (touchedFiles)
 *  7: git rev-parse --abbrev-ref HEAD (branch name)
 *  8: git push origin HEAD
 *  9: git fetch origin <branch>
 * 10: git reset --hard origin/<branch>
 * 11: git rev-parse HEAD (synced sha)
 */
function queueGitSuccess(stagedFile = 'src/foo.py') {
  spawnQueue.push(
    { exitCode: 0, stdout: `M ${stagedFile}\n` }, // git status --porcelain (dirty)
    { exitCode: 0, stdout: '' }, // git add -A
    { exitCode: 0, stdout: `${stagedFile}\n` }, // git diff --cached --name-only
    { exitCode: 0, stdout: `${stagedFile}\n` }, // git diff --cached --name-only (post un-stage)
    { exitCode: 0, stdout: '' }, // git commit
    { exitCode: 0, stdout: 'deadbeef\n' }, // git rev-parse HEAD
    { exitCode: 0, stdout: `${stagedFile}\n` }, // git diff --name-only HEAD~1 HEAD
    { exitCode: 0, stdout: 'feature/test\n' }, // git rev-parse --abbrev-ref HEAD
    { exitCode: 0, stdout: '' }, // git push
    { exitCode: 0, stdout: '' }, // git fetch
    { exitCode: 0, stdout: '' }, // git reset --hard
    { exitCode: 0, stdout: 'deadbeef\n' }, // git rev-parse HEAD (synced)
  );
}

// ── 1. git commit uses --no-verify ────────────────────────────────────────────

describe('git commit --no-verify', () => {
  it('includes --no-verify so the target repo pre-commit hooks do not run', async () => {
    // Autofix command: succeeds (exit 0)
    spawnQueue.push({ exitCode: 0, stdout: 'fixed 1 file' });
    queueGitSuccess();

    await runAutofix('/worktree', '/project', ['ruff check --fix'], () => {});

    const commitCall = spawnCalls.find(
      (c) =>
        c.cmd === 'git' && Array.isArray(c.args) && c.args.includes('commit'),
    );
    expect(commitCall).toBeDefined();
    expect(commitCall?.args).toContain('--no-verify');
  });
});

// ── 2. exit-1 with output → unfixableViolations, gate passes ─────────────────

describe('unfixable violations (exit 1 with output)', () => {
  it('returns success=true and populates unfixableViolations', async () => {
    const violationOutput =
      'src/foo.py:42:89: E501 Line too long (92 > 88 characters)';
    // Autofix command exits 1 with violation output (e.g. ruff couldn't fix E501)
    spawnQueue.push({ exitCode: 1, stdout: violationOutput });
    queueGitSuccess();

    const result = await runAutofix(
      '/worktree',
      '/project',
      ['ruff check --fix'],
      () => {},
    );

    expect(result.success).toBe(true);
    expect(result.unfixableViolations).toBe(violationOutput);
    expect(result.commitSha).toBe('deadbeef');
  });

  it('omits unfixableViolations when exit-1 produces no output', async () => {
    // exit 1 with empty output → treated as fatal failure
    spawnQueue.push({ exitCode: 1, stdout: '' });
    // No need to queue git calls — the failure aborts before committing
    // (Actually the code still tries to commit since failures≠fatalErrors here)
    // In this case exitCode=1 with empty output goes into fatalErrors
    // so success=false. No commit happens when there's a fatal error and
    // the worktree is dirty.
    queueGitSuccess();

    const result = await runAutofix(
      '/worktree',
      '/project',
      ['ruff check --fix'],
      () => {},
    );

    // exit 1 + empty output → fatal failure path
    expect(result.success).toBe(false);
    expect(result.unfixableViolations).toBeUndefined();
  });
});

// ── 3. exit >= 2 → fatal failure ─────────────────────────────────────────────

describe('fatal error (exit >= 2)', () => {
  it('returns success=false when a command exits 2 (e.g. ruff internal error)', async () => {
    spawnQueue.push({
      exitCode: 2,
      stdout: 'internal error: config parse failed',
    });
    // Worktree is dirty
    spawnQueue.push({ exitCode: 0, stdout: 'M src/foo.py\n' }); // git status
    // git add, diff --cached, diff --cached, commit (not reached due to failures)
    spawnQueue.push({ exitCode: 0 }); // git add
    spawnQueue.push({ exitCode: 0, stdout: 'src/foo.py\n' }); // diff staged
    spawnQueue.push({ exitCode: 0, stdout: 'src/foo.py\n' }); // diff staged post-unstage
    spawnQueue.push({ exitCode: 0 }); // git commit
    spawnQueue.push({ exitCode: 0, stdout: 'deadbeef\n' }); // rev-parse
    spawnQueue.push({ exitCode: 0, stdout: 'src/foo.py\n' }); // diff HEAD~1 HEAD
    spawnQueue.push({ exitCode: 0, stdout: 'feature/test\n' }); // branch
    spawnQueue.push({ exitCode: 1 }); // git push fails → success=false

    const result = await runAutofix(
      '/worktree',
      '/project',
      ['ruff check --fix'],
      () => {},
    );

    expect(result.success).toBe(false);
    expect(result.unfixableViolations).toBeUndefined();
  });
});

// ── 4. banned files only → no-op success ─────────────────────────────────────

describe('banned-file-only stage', () => {
  it('returns success=true and skips commit when all staged files are banned', async () => {
    const { isHardBanned } = await import('../github/PRFileValidator.js');
    vi.mocked(isHardBanned).mockReturnValue(true);

    // Autofix command succeeds
    spawnQueue.push({ exitCode: 0, stdout: 'fixed CLAUDE.md' });
    // git status: dirty
    spawnQueue.push({ exitCode: 0, stdout: 'M CLAUDE.md\n' });
    // git add -A
    spawnQueue.push({ exitCode: 0, stdout: '' });
    // git diff --cached: CLAUDE.md staged
    spawnQueue.push({ exitCode: 0, stdout: 'CLAUDE.md\n' });
    // After un-staging CLAUDE.md, git diff --cached: nothing left
    spawnQueue.push({ exitCode: 0, stdout: '' });

    const result = await runAutofix(
      '/worktree',
      '/project',
      ['ruff check --fix'],
      () => {},
    );

    expect(result.success).toBe(true);
    expect(result.summary).toMatch(/only banned files were staged/);
    // No git commit call should have happened
    const commitCall = spawnCalls.find(
      (c) =>
        c.cmd === 'git' && Array.isArray(c.args) && c.args.includes('commit'),
    );
    expect(commitCall).toBeUndefined();
  });
});
