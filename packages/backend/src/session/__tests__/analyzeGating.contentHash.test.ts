import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { computeWholeTreeContentHash } from '../analyzeGating';

// ── computeWholeTreeContentHash — F2's whole-tree content-hash key ──────────
//
// F2 (the orchestrator-run test gate) keys its shared cache
// (test_request_runs) on this hash, so it must be sensitive to any change
// in the tree — not just files matching a trigger_paths glob.

function initGitRepo(dir: string): void {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@example.com', { cwd: dir });
  execSync('git config user.name test', { cwd: dir });
}

function writeAndTrack(dir: string, file: string, content: string): void {
  const fullPath = path.join(dir, file);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  execSync(`git add ${file}`, { cwd: dir });
}

describe('computeWholeTreeContentHash', () => {
  let worktree: string;

  beforeEach(() => {
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'content-hash-test-'));
    initGitRepo(worktree);
  });

  afterEach(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it('returns null for an empty tree — callers must not key a run on a null hash', async () => {
    const hash = await computeWholeTreeContentHash(worktree);
    expect(hash).toBeNull();
  });

  it('is deterministic for the same tree content', async () => {
    writeAndTrack(worktree, 'a.txt', 'hello');
    writeAndTrack(worktree, 'b.txt', 'world');

    const first = await computeWholeTreeContentHash(worktree);
    const second = await computeWholeTreeContentHash(worktree);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a tracked file changes content — a push after PR-open must not hit stale cache', async () => {
    writeAndTrack(worktree, 'a.txt', 'hello');
    const before = await computeWholeTreeContentHash(worktree);

    fs.writeFileSync(path.join(worktree, 'a.txt'), 'hello, world');
    const after = await computeWholeTreeContentHash(worktree);

    expect(after).not.toBe(before);
  });

  it('changes when a new tracked file is added, even outside any trigger_paths glob', async () => {
    writeAndTrack(worktree, 'a.txt', 'hello');
    const before = await computeWholeTreeContentHash(worktree);

    writeAndTrack(worktree, 'unrelated/deep/file.bin', 'binary-ish content');
    const after = await computeWholeTreeContentHash(worktree);

    expect(after).not.toBe(before);
  });

  it('is stable regardless of git-tracked file listing order', async () => {
    writeAndTrack(worktree, 'z.txt', 'zzz');
    writeAndTrack(worktree, 'a.txt', 'aaa');
    const hash = await computeWholeTreeContentHash(worktree);

    const worktree2 = fs.mkdtempSync(
      path.join(os.tmpdir(), 'content-hash-test-'),
    );
    try {
      initGitRepo(worktree2);
      writeAndTrack(worktree2, 'a.txt', 'aaa');
      writeAndTrack(worktree2, 'z.txt', 'zzz');
      const hash2 = await computeWholeTreeContentHash(worktree2);
      expect(hash2).toBe(hash);
    } finally {
      fs.rmSync(worktree2, { recursive: true, force: true });
    }
  });

  it('is unaffected by staging an untracked file with no byte change — dev-loop test.request runs against the untracked file must not be invalidated by the pre-PR `git add`', async () => {
    writeAndTrack(worktree, 'a.txt', 'hello');
    fs.writeFileSync(path.join(worktree, 'untracked.txt'), 'new content');

    const beforeStaging = await computeWholeTreeContentHash(worktree);
    execSync('git add untracked.txt', { cwd: worktree });
    const afterStaging = await computeWholeTreeContentHash(worktree);

    expect(afterStaging).toBe(beforeStaging);
  });

  it('excludes gitignored files from the hash', async () => {
    writeAndTrack(worktree, 'a.txt', 'hello');
    writeAndTrack(worktree, '.gitignore', 'dist/\n');
    const before = await computeWholeTreeContentHash(worktree);

    fs.mkdirSync(path.join(worktree, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'dist', 'build.js'), 'artifact');
    const after = await computeWholeTreeContentHash(worktree);

    expect(after).toBe(before);
  });
});
