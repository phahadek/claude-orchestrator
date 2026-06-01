import { describe, it, expect } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runAutofix } from './autofix-runner';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

const GIT_AUTHOR = ['-c', 'user.name=Test', '-c', 'user.email=test@test.com'];

async function setupTestRepo(): Promise<{
  worktreeDir: string;
  cleanup: () => void;
}> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-test-'));
  const originDir = path.join(base, 'origin.git');
  const worktreeDir = path.join(base, 'worktree');

  fs.mkdirSync(originDir);
  await git(['init', '--bare', originDir], base);
  await git(['clone', originDir, worktreeDir], base);
  await git(['config', 'user.email', 'test@test.com'], worktreeDir);
  await git(['config', 'user.name', 'Test'], worktreeDir);
  await git(['config', 'core.autocrlf', 'false'], worktreeDir);

  fs.writeFileSync(path.join(worktreeDir, 'readme.txt'), 'hello\n');
  await git(['add', 'readme.txt'], worktreeDir);
  await git([...GIT_AUTHOR, 'commit', '-m', 'init'], worktreeDir);
  await git(['branch', '-M', 'feature/test'], worktreeDir);
  await git(['push', '-u', 'origin', 'feature/test'], worktreeDir);

  return {
    worktreeDir,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

describe('runAutofix()', () => {
  it('commit message ends with [skip ci]', async () => {
    const { worktreeDir, cleanup } = await setupTestRepo();
    try {
      const autofixCmd = `node -e "require('fs').writeFileSync('autofix_output.txt', 'done')"`;

      await runAutofix(worktreeDir, worktreeDir, [autofixCmd], () => {});

      const commitMsg = await git(
        ['log', '--format=%s', '--grep=apply autofix', '-1'],
        worktreeDir,
      );
      expect(commitMsg).toMatch(/\[skip ci\]$/);
    } finally {
      cleanup();
    }
  });
});
