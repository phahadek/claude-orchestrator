import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { revertBannedFiles } from './PRFileReverter';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

const GIT_AUTHOR = ['-c', 'user.name=Test', '-c', 'user.email=test@test.com'];

/** Set up a bare "origin" repo and a local worktree clone for testing. */
async function setupTestRepo(): Promise<{
  originDir: string;
  worktreeDir: string;
  cleanup: () => void;
}> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reverter-test-'));
  const originDir = path.join(base, 'origin.git');
  const worktreeDir = path.join(base, 'worktree');

  fs.mkdirSync(originDir);
  await git(['init', '--bare', originDir], base);
  await git(['clone', originDir, worktreeDir], base);
  await git(['config', 'user.email', 'test@test.com'], worktreeDir);
  await git(['config', 'user.name', 'Test'], worktreeDir);
  // Disable CRLF conversion so file content comparisons are consistent on Windows
  await git(['config', 'core.autocrlf', 'false'], worktreeDir);

  // Initial commit on dev
  fs.writeFileSync(path.join(worktreeDir, 'readme.txt'), 'hello\n');
  await git(['add', 'readme.txt'], worktreeDir);
  await git([...GIT_AUTHOR, 'commit', '-m', 'init'], worktreeDir);
  await git(['branch', '-M', 'dev'], worktreeDir);
  await git(['push', '-u', 'origin', 'dev'], worktreeDir);

  // Create feature branch
  await git(['checkout', '-b', 'feature/test'], worktreeDir);
  await git(['push', '-u', 'origin', 'feature/test'], worktreeDir);

  return {
    originDir,
    worktreeDir,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

describe('revertBannedFiles()', () => {
  let worktreeDir = '';
  let cleanup: () => void = () => {};

  beforeEach(async () => {
    const setup = await setupTestRepo();
    worktreeDir = setup.worktreeDir;
    cleanup = setup.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it('returns { commitSha: null } and does not push when bannedFiles is empty', async () => {
    const result = await revertBannedFiles({
      worktreePath: worktreeDir,
      baseBranch: 'dev',
      bannedFiles: [],
      prNumber: 1,
      repo: 'owner/repo',
    });
    expect(result.commitSha).toBeNull();
    expect(result.reverted).toHaveLength(0);
  });

  it('restores a tracked banned file (CLAUDE.md) from origin/<base> and pushes', async () => {
    // Add CLAUDE.md to dev (base branch) and push it
    await git(['checkout', 'dev'], worktreeDir);
    fs.writeFileSync(path.join(worktreeDir, 'CLAUDE.md'), 'base content\n');
    await git(['add', 'CLAUDE.md'], worktreeDir);
    await git(
      [...GIT_AUTHOR, 'commit', '-m', 'add CLAUDE.md to dev'],
      worktreeDir,
    );
    await git(['push', 'origin', 'dev'], worktreeDir);

    // Switch to feature branch, merge dev, then override CLAUDE.md with injected content
    await git(['checkout', 'feature/test'], worktreeDir);
    await git(['merge', 'dev', '--no-edit'], worktreeDir);
    fs.writeFileSync(
      path.join(worktreeDir, 'CLAUDE.md'),
      'orchestrator-injected content\n',
    );
    await git(['add', 'CLAUDE.md'], worktreeDir);
    await git([...GIT_AUTHOR, 'commit', '-m', 'inject CLAUDE.md'], worktreeDir);
    await git(['push', 'origin', 'feature/test'], worktreeDir);

    const result = await revertBannedFiles({
      worktreePath: worktreeDir,
      baseBranch: 'dev',
      bannedFiles: ['CLAUDE.md'],
      prNumber: 1,
      repo: 'owner/repo',
    });

    expect(result.commitSha).not.toBeNull();
    expect(result.reverted).toContain('CLAUDE.md');

    // Worktree must have base content — the revert sticks so git add won't re-stage it
    const worktreeContent = fs.readFileSync(
      path.join(worktreeDir, 'CLAUDE.md'),
      'utf8',
    );
    expect(worktreeContent).toBe('base content\n');

    // The HEAD commit on the branch must have the base-branch CLAUDE.md content
    const committedContent = await git(['show', 'HEAD:CLAUDE.md'], worktreeDir);
    expect(committedContent).toBe('base content');
  });

  it('removes an untracked (gitignored) banned file via git rm -f and pushes', async () => {
    // Feature branch: commit a file that was NOT on origin/dev (simulates new gitignored file)
    await git(['checkout', 'feature/test'], worktreeDir);
    fs.writeFileSync(path.join(worktreeDir, '.commit-msg'), 'fix: something\n');
    await git(['add', '-f', '.commit-msg'], worktreeDir);
    await git([...GIT_AUTHOR, 'commit', '-m', 'add .commit-msg'], worktreeDir);
    await git(['push', 'origin', 'feature/test'], worktreeDir);

    const result = await revertBannedFiles({
      worktreePath: worktreeDir,
      baseBranch: 'dev',
      bannedFiles: ['.commit-msg'],
      prNumber: 1,
      repo: 'owner/repo',
    });

    expect(result.commitSha).not.toBeNull();
    expect(result.reverted).toContain('.commit-msg');

    // File should not be in the HEAD commit
    let exists = true;
    try {
      await git(['show', 'HEAD:.commit-msg'], worktreeDir);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('does NOT restore injected worktree content after revert — the base content sticks', async () => {
    const injectedContent = '# Orchestrator injected\nrules here\n';

    // Add CLAUDE.md to origin/dev
    await git(['checkout', 'dev'], worktreeDir);
    fs.writeFileSync(path.join(worktreeDir, 'CLAUDE.md'), 'base\n');
    await git(['add', 'CLAUDE.md'], worktreeDir);
    await git([...GIT_AUTHOR, 'commit', '-m', 'base CLAUDE.md'], worktreeDir);
    await git(['push', 'origin', 'dev'], worktreeDir);

    // Feature branch: inject CLAUDE.md
    await git(['checkout', 'feature/test'], worktreeDir);
    await git(['merge', 'dev', '--no-edit'], worktreeDir);
    fs.writeFileSync(path.join(worktreeDir, 'CLAUDE.md'), injectedContent);
    await git(['add', 'CLAUDE.md'], worktreeDir);
    await git([...GIT_AUTHOR, 'commit', '-m', 'inject'], worktreeDir);
    await git(['push', 'origin', 'feature/test'], worktreeDir);

    await revertBannedFiles({
      worktreePath: worktreeDir,
      baseBranch: 'dev',
      bannedFiles: ['CLAUDE.md'],
      prNumber: 1,
      repo: 'owner/repo',
    });

    // Worktree CLAUDE.md must have base content (NOT the injected content)
    // so that a subsequent `git add .` does not re-stage the banned file.
    const content = fs.readFileSync(
      path.join(worktreeDir, 'CLAUDE.md'),
      'utf8',
    );
    expect(content).toBe('base\n');
  });

  it('is idempotent — second call when no banned files remain returns { commitSha: null }', async () => {
    // Add CLAUDE.md to origin/dev
    await git(['checkout', 'dev'], worktreeDir);
    fs.writeFileSync(path.join(worktreeDir, 'CLAUDE.md'), 'base\n');
    await git(['add', 'CLAUDE.md'], worktreeDir);
    await git([...GIT_AUTHOR, 'commit', '-m', 'base CLAUDE.md'], worktreeDir);
    await git(['push', 'origin', 'dev'], worktreeDir);

    // Feature branch: inject CLAUDE.md
    await git(['checkout', 'feature/test'], worktreeDir);
    await git(['merge', 'dev', '--no-edit'], worktreeDir);
    fs.writeFileSync(path.join(worktreeDir, 'CLAUDE.md'), 'injected\n');
    await git(['add', 'CLAUDE.md'], worktreeDir);
    await git([...GIT_AUTHOR, 'commit', '-m', 'inject'], worktreeDir);
    await git(['push', 'origin', 'feature/test'], worktreeDir);

    // First call — should revert
    const first = await revertBannedFiles({
      worktreePath: worktreeDir,
      baseBranch: 'dev',
      bannedFiles: ['CLAUDE.md'],
      prNumber: 1,
      repo: 'owner/repo',
    });
    expect(first.commitSha).not.toBeNull();

    // Second call — CLAUDE.md in HEAD matches origin/dev; no staged diff expected
    const second = await revertBannedFiles({
      worktreePath: worktreeDir,
      baseBranch: 'dev',
      bannedFiles: ['CLAUDE.md'],
      prNumber: 1,
      repo: 'owner/repo',
    });
    expect(second.commitSha).toBeNull();
  });

  it('PR #410 regression: second push after revert does not re-introduce CLAUDE.md', async () => {
    // Set up: CLAUDE.md on origin/dev (base content)
    await git(['checkout', 'dev'], worktreeDir);
    fs.writeFileSync(path.join(worktreeDir, 'CLAUDE.md'), 'base content\n');
    await git(['add', 'CLAUDE.md'], worktreeDir);
    await git([...GIT_AUTHOR, 'commit', '-m', 'base CLAUDE.md'], worktreeDir);
    await git(['push', 'origin', 'dev'], worktreeDir);

    await git(['checkout', 'feature/test'], worktreeDir);
    await git(['merge', 'dev', '--no-edit'], worktreeDir);

    // Session accidentally commits injected CLAUDE.md (the initial contamination)
    fs.writeFileSync(
      path.join(worktreeDir, 'CLAUDE.md'),
      'orchestrator-injected\n',
    );
    await git(['add', 'CLAUDE.md'], worktreeDir);
    await git(
      [...GIT_AUTHOR, 'commit', '-m', 'session work + injected CLAUDE.md'],
      worktreeDir,
    );
    await git(['push', 'origin', 'feature/test'], worktreeDir);

    // Auto-revert fires (PR #410 step 3)
    const revertResult = await revertBannedFiles({
      worktreePath: worktreeDir,
      baseBranch: 'dev',
      bannedFiles: ['CLAUDE.md'],
      prNumber: 410,
      repo: 'owner/repo',
    });
    expect(revertResult.commitSha).not.toBeNull();

    // After the revert, the worktree has base content — NOT the injected content
    const contentAfterRevert = fs.readFileSync(
      path.join(worktreeDir, 'CLAUDE.md'),
      'utf8',
    );
    expect(contentAfterRevert).toBe('base content\n');

    // git status must not show CLAUDE.md as modified — it won't be re-staged
    const statusOutput = await git(['status', '--porcelain'], worktreeDir);
    const claudeMdInStatus = statusOutput
      .split('\n')
      .some((line) => line.includes('CLAUDE.md'));
    expect(claudeMdInStatus).toBe(false);

    // The 3-dot diff from dev to HEAD must NOT contain CLAUDE.md
    const diffOutput = await git(
      ['diff', 'origin/dev...HEAD', '--name-only'],
      worktreeDir,
    );
    const diffLines = diffOutput.split('\n').filter(Boolean);
    expect(diffLines).not.toContain('CLAUDE.md');
  });
});
