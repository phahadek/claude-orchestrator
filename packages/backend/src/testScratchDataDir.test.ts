import { describe, it, expect } from 'vitest';
import path from 'path';
import { execFileSync } from 'child_process';
import { resolveTestScratchDataDir } from './testScratchDataDir';

const backendSrcDir = __dirname;
const backendRoot = path.resolve(backendSrcDir, '..');
const repoRoot = path.resolve(backendRoot, '..', '..');

describe('resolveTestScratchDataDir', () => {
  it('resolves under packages/backend/ regardless of process.cwd()', () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(repoRoot);
      const resolved = resolveTestScratchDataDir(1234, backendSrcDir);
      expect(resolved.startsWith(backendRoot + path.sep)).toBe(true);
      expect(resolved.startsWith(repoRoot + path.sep)).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('is pid-scoped and distinct across two simulated worker pids', () => {
    const a = resolveTestScratchDataDir(111, backendSrcDir);
    const b = resolveTestScratchDataDir(222, backendSrcDir);
    expect(a).not.toBe(b);
    expect(a).toContain('pid-111');
    expect(b).toContain('pid-222');
  });
});

describe('.gitignore rule for the scratch dir', () => {
  it('matches the scratch directory at both the repository root and packages/backend/', () => {
    const rootCandidate = '.test-scratch-datadir-DO-NOT-COMMIT/pid-1/bar';
    const backendCandidate =
      'packages/backend/.test-scratch-datadir-DO-NOT-COMMIT/pid-1/bar';

    for (const candidate of [rootCandidate, backendCandidate]) {
      const output = execFileSync('git', ['check-ignore', '-q', candidate], {
        cwd: repoRoot,
      });
      // check-ignore exits 0 (no throw) when the path is ignored; nothing further to assert.
      expect(output).toBeDefined();
    }
  });
});
