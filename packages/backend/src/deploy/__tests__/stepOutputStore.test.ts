import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  STEP_OUTPUT_MAX_BYTES,
  stepOutputPath,
  writeStepOutput,
  readStepOutput,
  pruneStepOutputs,
} from '../stepOutputStore';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-output-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('stepOutputStore', () => {
  it('round-trips output byte for byte', () => {
    const out = 'héllo\n'.repeat(1000);
    expect(writeStepOutput('p', 'run1', 'build', out, dir)).toBe(true);
    expect(
      fs.readFileSync(stepOutputPath('p', 'run1', 'build', dir), 'utf8'),
    ).toBe(out);
    expect(readStepOutput('p', 'run1', 'build', dir)).toBe(out);
  });

  it('returns null when no file exists', () => {
    expect(readStepOutput('p', 'run1', 'build', dir)).toBeNull();
  });

  it('stores head+tail with an elision marker beyond the byte cap', () => {
    const out = 'H'.repeat(STEP_OUTPUT_MAX_BYTES) + 'T'.repeat(1000);
    writeStepOutput('p', 'run1', 'build', out, dir);
    const stored = readStepOutput('p', 'run1', 'build', dir) as string;
    expect(stored).toContain('bytes elided');
    expect(stored.startsWith('H')).toBe(true);
    expect(stored.endsWith('T'.repeat(1000))).toBe(true);
    expect(Buffer.byteLength(stored)).toBeLessThan(STEP_OUTPUT_MAX_BYTES + 100);
  });

  it('returns false instead of throwing on I/O or unsafe-path errors', () => {
    expect(writeStepOutput('p', 'run1', '../x', 'o', dir)).toBe(false);
    const blocker = path.join(dir, 'deploy-output');
    fs.writeFileSync(blocker, 'file, not dir');
    expect(writeStepOutput('p', 'run1', 'build', 'o', dir)).toBe(false);
  });

  it('prunes all but the newest runs', () => {
    for (let i = 1; i <= 4; i++) {
      writeStepOutput('p', `run${i}`, 'build', 'o', dir);
      const d = path.dirname(stepOutputPath('p', `run${i}`, 'build', dir));
      const t = new Date(2026, 0, i);
      fs.utimesSync(d, t, t);
    }
    pruneStepOutputs('p', 2, dir);
    const left = fs.readdirSync(path.join(dir, 'deploy-output', 'p')).sort();
    expect(left).toEqual(['run3', 'run4']);
  });
});
