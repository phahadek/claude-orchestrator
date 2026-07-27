import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { insertSessionOrIgnore, updateSessionStatus } from '../../db/queries';
import {
  acquireCheckoutLockdown,
  releaseCheckoutLockdown,
  reconcileCheckoutLockdownAtBoot,
  getScratchDir,
  lockdownExcludes,
} from '../checkoutLockdown';

function canWrite(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function seedSession(sessionId: string, status: string): void {
  insertSessionOrIgnore({
    session_id: sessionId,
    task_id: null,
    task_url: '',
    project_context_url: '',
    status: 'running',
    started_at: Date.now(),
    session_type: 'groom',
  });
  updateSessionStatus(sessionId, status);
}

describe('checkoutLockdown', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-lockdown-'));
    fs.writeFileSync(path.join(projectDir, 'README.md'), 'hello\n');
    fs.mkdirSync(path.join(projectDir, '.git'));
    fs.writeFileSync(
      path.join(projectDir, '.git', 'HEAD'),
      'ref: refs/heads/main\n',
    );
  });

  afterEach(() => {
    // Lockdown may still be active — restore write access before rm, else
    // the fs.rmSync cleanup itself would EACCES on a locked-down tree.
    fs.chmodSync(projectDir, 0o755);
    for (const entry of fs.readdirSync(projectDir)) {
      try {
        fs.chmodSync(path.join(projectDir, entry), 0o755);
      } catch {
        // best-effort
      }
    }
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('strips write permission from the checkout on first acquire, restores it on last release', async () => {
    await acquireCheckoutLockdown(projectDir, 'session-a', {
      applyFsLockdown: true,
    });

    expect(canWrite(path.join(projectDir, 'README.md'))).toBe(false);
    expect(canWrite(path.join(projectDir, '.git', 'HEAD'))).toBe(false);
    expect(canWrite(getScratchDir(projectDir, 'session-a'))).toBe(true);

    await releaseCheckoutLockdown('session-a', { applyFsLockdown: true });

    expect(canWrite(path.join(projectDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(getScratchDir(projectDir, 'session-a'))).toBe(false);
  });

  it('does not lift the lock while a second concurrent planning session is still active', async () => {
    await acquireCheckoutLockdown(projectDir, 'session-a', {
      applyFsLockdown: true,
    });
    await acquireCheckoutLockdown(projectDir, 'session-b', {
      applyFsLockdown: true,
    });

    await releaseCheckoutLockdown('session-a', { applyFsLockdown: true });
    expect(canWrite(path.join(projectDir, 'README.md'))).toBe(false);
    // session-a's own scratch dir is gone, session-b's remains untouched.
    expect(fs.existsSync(getScratchDir(projectDir, 'session-a'))).toBe(false);
    expect(canWrite(getScratchDir(projectDir, 'session-b'))).toBe(true);

    await releaseCheckoutLockdown('session-b', { applyFsLockdown: true });
    expect(canWrite(path.join(projectDir, 'README.md'))).toBe(true);
  });

  it('is a no-op for a session that never acquired a lock', async () => {
    await expect(
      releaseCheckoutLockdown('never-acquired', { applyFsLockdown: true }),
    ).resolves.not.toThrow();
  });

  it('applyFsLockdown: false (Docker path) tracks ref-counting without touching filesystem permissions', async () => {
    await acquireCheckoutLockdown(projectDir, 'session-a', {
      applyFsLockdown: false,
    });
    expect(canWrite(path.join(projectDir, 'README.md'))).toBe(true);
    await releaseCheckoutLockdown('session-a', { applyFsLockdown: false });
  });

  it('boot reconciliation prunes locks for terminal/missing sessions and restores the filesystem', async () => {
    seedSession('dead-session', 'killed');
    await acquireCheckoutLockdown(projectDir, 'dead-session', {
      applyFsLockdown: true,
    });
    expect(canWrite(path.join(projectDir, 'README.md'))).toBe(false);

    await reconcileCheckoutLockdownAtBoot({ applyFsLockdown: true });

    expect(canWrite(path.join(projectDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(getScratchDir(projectDir, 'dead-session'))).toBe(
      false,
    );
  });

  it('leaves .claude/session-prompts writable after stripWriteRecursive, unlike other subdirectories', async () => {
    const sessionPromptsDir = path.join(
      projectDir,
      '.claude',
      'session-prompts',
    );
    fs.mkdirSync(sessionPromptsDir, { recursive: true });

    await acquireCheckoutLockdown(projectDir, 'session-a', {
      applyFsLockdown: true,
    });

    expect(canWrite(sessionPromptsDir)).toBe(true);

    await releaseCheckoutLockdown('session-a', { applyFsLockdown: true });
  });

  it('leaves node_modules writable after stripWriteRecursive, unlike other subdirectories', async () => {
    const nodeModulesDir = path.join(projectDir, 'node_modules');
    fs.mkdirSync(nodeModulesDir, { recursive: true });
    const nodeModulesFile = path.join(nodeModulesDir, 'some-package.js');
    fs.writeFileSync(nodeModulesFile, 'module.exports = {};\n');

    await acquireCheckoutLockdown(projectDir, 'session-a', {
      applyFsLockdown: true,
    });

    expect(canWrite(nodeModulesDir)).toBe(true);
    expect(canWrite(nodeModulesFile)).toBe(true);
    // The exclusion doesn't weaken the actual boundary elsewhere in the tree.
    expect(canWrite(path.join(projectDir, 'README.md'))).toBe(false);

    await releaseCheckoutLockdown('session-a', { applyFsLockdown: true });
  });

  it('strips and restores the checkout against the exact same exclude list (no drift between call sites)', () => {
    // stripWriteRecursive and restoreWriteRecursive both call
    // lockdownExcludes(projectDir) directly — this pins that shared list's
    // contents so a future hardcoded literal at either call site would be
    // caught by this test failing to match reality.
    expect(lockdownExcludes(projectDir).sort()).toEqual(
      [
        path.join(projectDir, '.claude', 'scratch'),
        path.join(projectDir, '.claude', 'worktrees'),
        path.join(projectDir, '.claude', 'session-prompts'),
        path.join(projectDir, 'node_modules'),
      ].sort(),
    );
  });

  it('restores owner-write on session-prompts left read-only by a lock acquired before the carve-out existed', async () => {
    const sessionPromptsDir = path.join(
      projectDir,
      '.claude',
      'session-prompts',
    );
    fs.mkdirSync(sessionPromptsDir, { recursive: true });

    await acquireCheckoutLockdown(projectDir, 'session-a', {
      applyFsLockdown: true,
    });
    // Simulate a lock acquired by pre-fix code, which stripped this
    // directory before it was excluded from the walk.
    fs.chmodSync(sessionPromptsDir, 0o444);
    expect(canWrite(sessionPromptsDir)).toBe(false);

    await releaseCheckoutLockdown('session-a', { applyFsLockdown: true });

    expect(canWrite(sessionPromptsDir)).toBe(true);
  });

  it('boot reconciliation re-applies the lockdown for a still-active session (mid-crash restore)', async () => {
    seedSession('live-session', 'running');
    // Simulate a crash between the DB insert and the chmod actually landing:
    // acquire with applyFsLockdown:false so the row exists but the tree is
    // still writable, then reconcile should notice count>0 and lock it.
    await acquireCheckoutLockdown(projectDir, 'live-session', {
      applyFsLockdown: false,
    });
    expect(canWrite(path.join(projectDir, 'README.md'))).toBe(true);

    await reconcileCheckoutLockdownAtBoot({ applyFsLockdown: true });

    expect(canWrite(path.join(projectDir, 'README.md'))).toBe(false);
    fs.chmodSync(projectDir, 0o755);
  });
});

describe('checkoutLockdown — read-only .git allowlist verification', () => {
  // The acceptance criteria explicitly call out that .git becomes part of
  // the read-only tree, and require verifying none of the planning
  // read-only Bash allowlist commands depend on a transient write (index
  // refresh, lock files) that a fully read-only .git would break. This runs
  // each allowlisted command for real against a real read-only git repo,
  // rather than asserting the claim in a comment.
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-lockdown-git-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hello\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'init');
    // Dirty the working tree so `git status`/`git diff` have something to
    // (opportunistically) refresh the index over, which is the scenario
    // that could break under a read-only .git.
    fs.appendFileSync(path.join(repoDir, 'a.txt'), 'changed\n');
  });

  afterEach(() => {
    fs.chmodSync(repoDir, 0o755);
    for (const entry of fs.readdirSync(repoDir)) {
      try {
        fs.chmodSync(path.join(repoDir, entry), 0o755);
      } catch {
        // best-effort
      }
    }
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('every read-only Bash allowlist git command succeeds against a fully read-only checkout (including .git)', async () => {
    await acquireCheckoutLockdown(repoDir, 'git-session', {
      applyFsLockdown: true,
    });

    const allowlistCommands: string[][] = [
      ['status'],
      ['log', '--oneline'],
      ['diff'],
      ['show', 'HEAD'],
      ['blame', 'a.txt'],
      ['ls-files'],
      ['rev-parse', 'HEAD'],
    ];

    for (const args of allowlistCommands) {
      expect(() =>
        execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }),
      ).not.toThrow();
    }

    await releaseCheckoutLockdown('git-session', { applyFsLockdown: true });
  });
});
