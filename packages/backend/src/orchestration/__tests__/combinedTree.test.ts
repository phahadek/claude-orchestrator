import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeWholeTreeContentHash } from '../../session/analyzeGating';
import { createGateScratchTree, resolveCombinedTree } from '../combinedTree';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

describe('combinedTree', () => {
  let root: string;
  let wt: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'combined-tree-'));
    const origin = path.join(root, 'origin');
    fs.mkdirSync(origin);
    git(origin, 'init', '-b', 'dev');
    fs.writeFileSync(path.join(origin, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(origin, 'b.txt'), 'b\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-m', 'init');
    wt = path.join(root, 'wt');
    git(root, 'clone', origin, wt);
    git(wt, 'checkout', '-b', 'feature');
    fs.writeFileSync(path.join(wt, 'a.txt'), 'a-feature\n');
    git(wt, 'commit', '-am', 'feature');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function advanceBase(file: string, content: string): void {
    const origin = path.join(root, 'origin');
    fs.writeFileSync(path.join(origin, file), content);
    git(origin, 'commit', '-am', 'base moves');
  }

  it('matches the worktree hash while base is unchanged', async () => {
    const result = await resolveCombinedTree({
      repoDir: wt,
      headSha: git(wt, 'rev-parse', 'HEAD'),
      baseBranch: 'dev',
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.contentHash).toBe(await computeWholeTreeContentHash(wt));
  });

  it('hashes the merge-tree combined tree once base advances', async () => {
    advanceBase('b.txt', 'b-base\n');
    const headSha = git(wt, 'rev-parse', 'HEAD');
    const result = await resolveCombinedTree({
      repoDir: wt,
      headSha,
      baseBranch: 'dev',
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.contentHash).not.toBe(await computeWholeTreeContentHash(wt));

    const scratch = await createGateScratchTree({
      repoDir: wt,
      projectDir: wt,
      sessionWorktreePath: wt,
      headSha,
      treeOid: result.treeOid,
    });
    expect(await computeWholeTreeContentHash(scratch.path)).toBe(
      result.contentHash,
    );
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(headSha);
    expect(git(wt, 'status', '--porcelain')).toBe('');
    await scratch.dispose();
    expect(fs.existsSync(scratch.path)).toBe(false);
  });

  it('gives overlapping scratches for one session distinct paths, and disposing one leaves the other intact', async () => {
    const headSha = git(wt, 'rev-parse', 'HEAD');
    const result = await resolveCombinedTree({
      repoDir: wt,
      headSha,
      baseBranch: 'dev',
    });
    if (result.status !== 'ok') throw new Error('expected ok');
    const args = {
      repoDir: wt,
      projectDir: wt,
      sessionWorktreePath: wt,
      headSha,
      treeOid: result.treeOid,
    };
    const a = await createGateScratchTree(args);
    const b = await createGateScratchTree(args);
    expect(a.path).not.toBe(b.path);
    await a.dispose();
    expect(fs.existsSync(a.path)).toBe(false);
    expect(fs.existsSync(path.join(b.path, 'a.txt'))).toBe(true);
    await b.dispose();
  });

  it('reports a textual conflict', async () => {
    advanceBase('a.txt', 'a-base\n');
    const result = await resolveCombinedTree({
      repoDir: wt,
      headSha: git(wt, 'rev-parse', 'HEAD'),
      baseBranch: 'dev',
    });
    expect(result.status).toBe('conflict');
  });
});
