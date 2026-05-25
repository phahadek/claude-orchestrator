import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  hasNonEmptyDiff,
  detectMergeConflict,
  getCurrentBranch,
} from '../localBranchHelpers.js';

const execAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execAsync('git', args, { cwd });
  return stdout.trim();
}

// ── Shared repo factory ──────────────────────────────────────────────────────

async function makeRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-branch-test-'));
  await git(['init'], dir);
  await git(['config', 'user.email', 'test@test.com'], dir);
  await git(['config', 'user.name', 'Test User'], dir);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base content\n');
  await git(['add', '.'], dir);
  await git(['commit', '-m', 'initial'], dir);
  await git(['branch', '-M', 'dev'], dir);
  return dir;
}

// ── schema.ts migration test ─────────────────────────────────────────────────

describe('schema.ts migration', () => {
  it('includes local_branches table with correct schema and index', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../db/schema.ts'),
      'utf-8',
    );
    expect(source).toContain('CREATE TABLE IF NOT EXISTS local_branches');
    expect(source).toContain('INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(source).toContain("status        TEXT NOT NULL DEFAULT 'open'");
    expect(source).toContain('review_result TEXT');
    expect(source).toContain(
      'CREATE INDEX IF NOT EXISTS idx_local_branches_project_status ON local_branches(project_id, status)',
    );
  });
});

// ── getCurrentBranch ─────────────────────────────────────────────────────────

describe('getCurrentBranch', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeRepo();
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('returns the current branch name', async () => {
    const branch = await getCurrentBranch(repoDir);
    expect(branch).toBe('dev');
  });

  it('returns the feature branch after checkout', async () => {
    await git(['checkout', '-b', 'feature/test'], repoDir);
    const branch = await getCurrentBranch(repoDir);
    expect(branch).toBe('feature/test');
  });
});

// ── hasNonEmptyDiff ──────────────────────────────────────────────────────────

describe('hasNonEmptyDiff', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeRepo();
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('returns false when feature branch has no changes vs dev', async () => {
    await git(['checkout', '-b', 'feature/no-changes'], repoDir);
    const result = await hasNonEmptyDiff(repoDir, 'dev', 'feature/no-changes');
    expect(result).toBe(false);
  });

  it('returns true when feature branch has commits vs dev', async () => {
    await git(['checkout', '-b', 'feature/has-changes'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'new.txt'), 'new content\n');
    await git(['add', '.'], repoDir);
    await git(['commit', '-m', 'add file'], repoDir);

    const result = await hasNonEmptyDiff(repoDir, 'dev', 'feature/has-changes');
    expect(result).toBe(true);
  });
});

// ── detectMergeConflict ──────────────────────────────────────────────────────

describe('detectMergeConflict', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeRepo();
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('returns false for a clean fast-forwardable branch', async () => {
    await git(['checkout', '-b', 'feature/clean'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'new.txt'), 'new content\n');
    await git(['add', '.'], repoDir);
    await git(['commit', '-m', 'add file'], repoDir);
    await git(['checkout', 'dev'], repoDir);

    const result = await detectMergeConflict(repoDir, 'dev', 'feature/clean');
    expect(result).toBe(false);
  });

  it('leaves the worktree in pre-merge state (on baseBranch) after clean merge', async () => {
    await git(['checkout', '-b', 'feature/clean'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'new.txt'), 'new content\n');
    await git(['add', '.'], repoDir);
    await git(['commit', '-m', 'add file'], repoDir);
    await git(['checkout', 'dev'], repoDir);

    await detectMergeConflict(repoDir, 'dev', 'feature/clean');

    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir);
    expect(branch).toBe('dev');
  });

  it('returns true when git merge --no-commit --no-ff would conflict', async () => {
    // Create feature branch that modifies the same file as dev after branching
    await git(['checkout', '-b', 'feature/conflict'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'base.txt'), 'feature version\n');
    await git(['add', '.'], repoDir);
    await git(['commit', '-m', 'feature change'], repoDir);

    // Add a conflicting change on dev after the branch point
    await git(['checkout', 'dev'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'base.txt'), 'dev version\n');
    await git(['add', '.'], repoDir);
    await git(['commit', '-m', 'dev change'], repoDir);

    const result = await detectMergeConflict(
      repoDir,
      'dev',
      'feature/conflict',
    );
    expect(result).toBe(true);
  });

  it('cleans up via git merge --abort — worktree left in pre-merge state', async () => {
    await git(['checkout', '-b', 'feature/conflict'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'base.txt'), 'feature version\n');
    await git(['add', '.'], repoDir);
    await git(['commit', '-m', 'feature change'], repoDir);

    await git(['checkout', 'dev'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'base.txt'), 'dev version\n');
    await git(['add', '.'], repoDir);
    await git(['commit', '-m', 'dev change'], repoDir);

    await detectMergeConflict(repoDir, 'dev', 'feature/conflict');

    // Worktree should be on dev with no conflict markers
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir);
    expect(branch).toBe('dev');

    const fileContent = fs.readFileSync(
      path.join(repoDir, 'base.txt'),
      'utf-8',
    );
    expect(fileContent).not.toContain('<<<<<<<');
    expect(fileContent.replace(/\r\n/g, '\n')).toBe('dev version\n');
  });
});
