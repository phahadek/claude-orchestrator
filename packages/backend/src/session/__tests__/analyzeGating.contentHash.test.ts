import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { computeWorktreeContentHash } from '../analyzeGating';

// ── computeWorktreeContentHash — F2's whole-tree content-hash key ───────────
//
// Extends computeTriggerContentHash's per-file-sha256 technique from a
// trigger_paths-only subset to every git-tracked file in the worktree — this
// is the cache key orchestrator_test_content_cache is keyed on.

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

describe('computeWorktreeContentHash', () => {
  let worktree: string;

  beforeEach(() => {
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'content-hash-test-'));
    initGitRepo(worktree);
  });

  afterEach(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it('is deterministic for the same tree content', async () => {
    writeAndTrack(worktree, 'a.txt', 'hello');
    writeAndTrack(worktree, 'b.txt', 'world');

    const first = await computeWorktreeContentHash(worktree);
    const second = await computeWorktreeContentHash(worktree);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a tracked file changes content — a push after PR-open must not hit stale cache', async () => {
    writeAndTrack(worktree, 'a.txt', 'hello');
    const before = await computeWorktreeContentHash(worktree);

    fs.writeFileSync(path.join(worktree, 'a.txt'), 'hello, world');
    const after = await computeWorktreeContentHash(worktree);

    expect(after).not.toBe(before);
  });

  it('changes when a new tracked file is added, even outside any trigger_paths glob', async () => {
    writeAndTrack(worktree, 'a.txt', 'hello');
    const before = await computeWorktreeContentHash(worktree);

    writeAndTrack(worktree, 'unrelated/deep/file.bin', 'binary-ish content');
    const after = await computeWorktreeContentHash(worktree);

    expect(after).not.toBe(before);
  });

  it('is stable regardless of git-tracked file listing order', async () => {
    writeAndTrack(worktree, 'z.txt', 'zzz');
    writeAndTrack(worktree, 'a.txt', 'aaa');
    const hash = await computeWorktreeContentHash(worktree);

    const worktree2 = fs.mkdtempSync(
      path.join(os.tmpdir(), 'content-hash-test-'),
    );
    try {
      initGitRepo(worktree2);
      writeAndTrack(worktree2, 'a.txt', 'aaa');
      writeAndTrack(worktree2, 'z.txt', 'zzz');
      const hash2 = await computeWorktreeContentHash(worktree2);
      expect(hash2).toBe(hash);
    } finally {
      fs.rmSync(worktree2, { recursive: true, force: true });
    }
  });
});
