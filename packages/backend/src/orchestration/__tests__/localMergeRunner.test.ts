import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { squashMergeLocal } from '../localMergeRunner.js';

const execAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execAsync('git', args, { cwd });
  return stdout.trim();
}

async function makeRepo(): Promise<string> {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'local-merge-runner-test-'),
  );
  await git(['init'], dir);
  await git(['config', 'user.email', 'test@test.com'], dir);
  await git(['config', 'user.name', 'Test User'], dir);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base content\n');
  await git(['add', '.'], dir);
  await git(['commit', '-m', 'initial'], dir);
  await git(['branch', '-M', 'dev'], dir);
  return dir;
}

describe('squashMergeLocal — success path', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeRepo();
    await git(['checkout', '-b', 'feature/my-task'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'new.txt'), 'feature content\n');
    await git(['add', '.'], repoDir);
    await git(['commit', '-m', 'feature commit 1'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'new.txt'), 'feature content v2\n');
    await git(['add', '.'], repoDir);
    await git(['commit', '-m', 'feature commit 2'], repoDir);
    await git(['checkout', 'dev'], repoDir);
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('produces a single squash commit on baseBranch', async () => {
    const logBefore = await git(['log', '--oneline', 'dev'], repoDir);
    const linesBefore = logBefore.split('\n').length;

    const result = await squashMergeLocal({
      worktreePath: repoDir,
      baseBranch: 'dev',
      featureBranch: 'feature/my-task',
      taskName: 'my task name',
    });

    expect(result.merged).toBe(true);
    expect(result.commitSha).toBeTruthy();

    const logAfter = await git(['log', '--oneline', 'dev'], repoDir);
    const linesAfter = logAfter.split('\n').length;

    // Exactly one new commit
    expect(linesAfter).toBe(linesBefore + 1);
  });

  it('squash commit message equals taskName', async () => {
    await squashMergeLocal({
      worktreePath: repoDir,
      baseBranch: 'dev',
      featureBranch: 'feature/my-task',
      taskName: 'My Task Title',
    });

    const msg = await git(['log', '-1', '--format=%s', 'dev'], repoDir);
    expect(msg).toBe('My Task Title');
  });

  it('squash commit has bot author/committer identity', async () => {
    await squashMergeLocal({
      worktreePath: repoDir,
      baseBranch: 'dev',
      featureBranch: 'feature/my-task',
      taskName: 'my-task',
    });

    const authorName = await git(['log', '-1', '--format=%an', 'dev'], repoDir);
    const authorEmail = await git(
      ['log', '-1', '--format=%ae', 'dev'],
      repoDir,
    );
    const committerName = await git(
      ['log', '-1', '--format=%cn', 'dev'],
      repoDir,
    );
    const committerEmail = await git(
      ['log', '-1', '--format=%ce', 'dev'],
      repoDir,
    );

    expect(authorName).toBe('claude-orchestrator');
    expect(authorEmail).toBe('bot@claude-code.internal');
    expect(committerName).toBe('claude-orchestrator');
    expect(committerEmail).toBe('bot@claude-code.internal');
  });

  it('removes the feature branch on success', async () => {
    await squashMergeLocal({
      worktreePath: repoDir,
      baseBranch: 'dev',
      featureBranch: 'feature/my-task',
      taskName: 'my-task',
    });

    const branches = await git(['branch'], repoDir);
    expect(branches).not.toContain('feature/my-task');
  });

  it('returns the commit SHA that lands on baseBranch', async () => {
    const result = await squashMergeLocal({
      worktreePath: repoDir,
      baseBranch: 'dev',
      featureBranch: 'feature/my-task',
      taskName: 'my-task',
    });

    const headSha = await git(['rev-parse', 'dev'], repoDir);
    expect(result.commitSha).toBe(headSha);
  });
});

describe('squashMergeLocal — conflict path', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeRepo();

    // Create feature branch that modifies the same file as a later dev commit
    await git(['checkout', '-b', 'feature/conflict-task'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'base.txt'), 'feature version\n');
    await git(['add', '.'], repoDir);
    await git(['commit', '-m', 'feature change'], repoDir);

    // Add conflicting change on dev
    await git(['checkout', 'dev'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'base.txt'), 'dev version\n');
    await git(['add', '.'], repoDir);
    await git(['commit', '-m', 'dev change'], repoDir);
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('returns { merged: false, conflict: true } on conflict', async () => {
    const result = await squashMergeLocal({
      worktreePath: repoDir,
      baseBranch: 'dev',
      featureBranch: 'feature/conflict-task',
      taskName: 'conflict-task',
    });

    expect(result.merged).toBe(false);
    expect(result.conflict).toBe(true);
  });

  it('retains the feature branch on conflict', async () => {
    await squashMergeLocal({
      worktreePath: repoDir,
      baseBranch: 'dev',
      featureBranch: 'feature/conflict-task',
      taskName: 'conflict-task',
    });

    const branches = await git(['branch'], repoDir);
    expect(branches).toContain('feature/conflict-task');
  });

  it('leaves worktree in pre-merge state (no conflict markers) on conflict', async () => {
    await squashMergeLocal({
      worktreePath: repoDir,
      baseBranch: 'dev',
      featureBranch: 'feature/conflict-task',
      taskName: 'conflict-task',
    });

    const currentBranch = await git(
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      repoDir,
    );
    expect(currentBranch).toBe('feature/conflict-task');

    const fileContent = fs.readFileSync(
      path.join(repoDir, 'base.txt'),
      'utf-8',
    );
    expect(fileContent).not.toContain('<<<<<<<');
  });
});
