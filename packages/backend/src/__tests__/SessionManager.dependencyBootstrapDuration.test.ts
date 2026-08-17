import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ── AC: dependency bootstrap duration is logged for both the cache-pool hit
// path and the bootstrap_script fallback path, so the design's cost
// expectation can be checked against real measurements. ──────────────────────
describe('SessionManager.completeStart() — dependency bootstrap duration logging', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );
  const completeStartIdx = source.indexOf('private async completeStart(');
  const cleanupIdx = source.indexOf(
    'private async cleanupPartialWorktree(',
    completeStartIdx,
  );
  const block = source.slice(completeStartIdx, cleanupIdx);

  it('times the cache-pool call with Date.now()', () => {
    expect(block).toMatch(/const cachePoolStart = Date\.now\(\);/);
  });

  it('logs a parseable duration on the cache-pool hit path', () => {
    const match = block.match(
      /dependency bootstrap duration: path=cache-pool session=\$\{sessionId\.slice\(0, 8\)\} durationMs=\$\{Date\.now\(\) - cachePoolStart\}/,
    );
    expect(match).not.toBeNull();
  });

  it('logs the cache-pool duration only when the pool call reports a hit', () => {
    const durationIdx = block.indexOf('path=cache-pool');
    const handledIdx = block.lastIndexOf('if (handledByCachePool) {', durationIdx);
    expect(handledIdx).toBeGreaterThan(-1);
    expect(durationIdx).toBeGreaterThan(handledIdx);
  });

  it('times the bootstrap_script fallback exec with Date.now()', () => {
    expect(block).toMatch(/const bootstrapStart = Date\.now\(\);/);
  });

  it('logs a parseable duration on the bootstrap_script fallback path', () => {
    const match = block.match(
      /dependency bootstrap duration: path=fallback session=\$\{sessionId\.slice\(0, 8\)\} durationMs=\$\{Date\.now\(\) - bootstrapStart\}/,
    );
    expect(match).not.toBeNull();
  });

  it('logs the fallback duration only after the bootstrap script succeeds', () => {
    const durationIdx = block.indexOf('path=fallback');
    const execIdx = block.indexOf('bash "${orchConfig.bootstrap_script}"');
    const catchIdx = block.indexOf('} catch (err) {', durationIdx);
    expect(execIdx).toBeGreaterThan(-1);
    expect(durationIdx).toBeGreaterThan(execIdx);
    expect(catchIdx).toBeGreaterThan(durationIdx);
  });
});
