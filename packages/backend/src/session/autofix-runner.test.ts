import { describe, it, expect } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runAutofix, getChangedFiles } from './autofix-runner';

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

  // runAutofix (default baseBranch = 'dev') now unconditionally computes the
  // PR's changed-file set via `git diff --name-only dev...HEAD` and scopes
  // `git add` to those paths. Create a 'dev' branch at the initial commit, then
  // add a placeholder commit on feature/test that already touches the file the
  // autofix command will rewrite, so it's part of the "PR-owned" changed-file
  // set the autofix commit is allowed to stage.
  await git(['branch', 'dev'], worktreeDir);
  fs.writeFileSync(
    path.join(worktreeDir, 'autofix_output.txt'),
    'placeholder\n',
  );
  await git(['add', 'autofix_output.txt'], worktreeDir);
  await git(
    [...GIT_AUTHOR, 'commit', '-m', 'add placeholder autofix_output.txt'],
    worktreeDir,
  );

  await git(['push', '-u', 'origin', 'feature/test'], worktreeDir);

  return {
    worktreeDir,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

describe('runAutofix()', () => {
  // Fixture performs a real bare git init, clone, config writes, a commit,
  // and a push before the test body even starts; not millisecond-bounded
  // under process-spawn contention.
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
  }, 15000);
});

describe('getChangedFiles()', () => {
  // Reproduces PR #1290's shape: the local worktree's `dev` branch pointer is
  // stale relative to `origin/dev` (fetched but never fast-forwarded, as
  // happens on a long-lived worktree/branch stack). A file whose only
  // touching commit already landed on origin/dev before the PR branched off
  // must not appear in the changed-file set, even though it's still absent
  // from the stale local `dev` ref.
  it('diffs against origin/<base> instead of a stale local base ref', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-stale-'));
    const originDir = path.join(base, 'origin.git');
    const worktreeDir = path.join(base, 'worktree');
    try {
      fs.mkdirSync(originDir);
      await git(['init', '--bare', originDir], base);
      await git(['clone', originDir, worktreeDir], base);
      await git(['config', 'user.email', 'test@test.com'], worktreeDir);
      await git(['config', 'user.name', 'Test'], worktreeDir);

      // C1: initial commit on dev.
      fs.writeFileSync(path.join(worktreeDir, 'readme.txt'), 'hello\n');
      await git(['add', 'readme.txt'], worktreeDir);
      await git([...GIT_AUTHOR, 'commit', '-m', 'init'], worktreeDir);
      await git(['branch', '-M', 'dev'], worktreeDir);
      await git(['push', '-u', 'origin', 'dev'], worktreeDir);

      // Create the local 'dev' pointer at C1 — this is the stale ref a
      // long-lived worktree keeps around after fetching but not
      // fast-forwarding its local branch.
      const staleDevSha = await git(['rev-parse', 'dev'], worktreeDir);

      // C2: lands on dev via another PR, touching a file unrelated to the
      // one under test (e.g. tests/ops/test_canary_verifier.py in #1290).
      fs.writeFileSync(path.join(worktreeDir, 'unrelated_file.py'), 'x = 1\n');
      await git(['add', 'unrelated_file.py'], worktreeDir);
      await git(
        [...GIT_AUTHOR, 'commit', '-m', 'sibling PR touches unrelated file'],
        worktreeDir,
      );
      await git(['push', 'origin', 'dev'], worktreeDir);

      // Feature branch branches off the up-to-date dev (C2), then adds the
      // PR's own commit. origin/dev is fetched and up to date at C2, but the
      // local 'dev' branch is force-reset back to the stale C1 to simulate
      // the worktree never fast-forwarding it.
      await git(['checkout', '-b', 'feature/test', 'dev'], worktreeDir);
      fs.writeFileSync(path.join(worktreeDir, 'feature_file.txt'), 'new\n');
      await git(['add', 'feature_file.txt'], worktreeDir);
      await git([...GIT_AUTHOR, 'commit', '-m', 'PR commit'], worktreeDir);
      await git(['branch', '-f', 'dev', staleDevSha], worktreeDir);

      const changedFiles = await getChangedFiles(worktreeDir, 'dev');

      expect(changedFiles).toContain('feature_file.txt');
      expect(changedFiles).not.toContain('unrelated_file.py');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 15000);
});
