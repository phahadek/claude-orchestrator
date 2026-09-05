import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildScopedEnv,
  checkToolchainVersions,
  formatToolchainMismatch,
} from '../gateEnv';

describe('buildScopedEnv()', () => {
  let worktreeA: string;
  let worktreeB: string;

  beforeEach(() => {
    worktreeA = fs.mkdtempSync(path.join(os.tmpdir(), 'gateenv-a-'));
    worktreeB = fs.mkdtempSync(path.join(os.tmpdir(), 'gateenv-b-'));
  });

  afterEach(() => {
    fs.rmSync(worktreeA, { recursive: true, force: true });
    fs.rmSync(worktreeB, { recursive: true, force: true });
  });

  it('returns process.env unchanged when cacheEnv is undefined', () => {
    expect(buildScopedEnv(worktreeA, undefined)).toBe(process.env);
  });

  it('returns process.env unchanged when cacheEnv is empty', () => {
    expect(buildScopedEnv(worktreeA, {})).toBe(process.env);
  });

  it('points declared vars at a path inside the worktree, creating it if absent', () => {
    const env = buildScopedEnv(worktreeA, {
      ESLINT_CACHE_LOCATION: '.cache/eslint',
    });
    const expected = path.join(worktreeA, '.cache/eslint');
    expect(env.ESLINT_CACHE_LOCATION).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.statSync(expected).isDirectory()).toBe(true);
  });

  it('gives two concurrent worktrees different cache directories for the same var', () => {
    const cacheEnv = { RUFF_CACHE_DIR: '.ruff_cache' };
    const envA = buildScopedEnv(worktreeA, cacheEnv);
    const envB = buildScopedEnv(worktreeB, cacheEnv);
    expect(envA.RUFF_CACHE_DIR).not.toBe(envB.RUFF_CACHE_DIR);
    expect(envA.RUFF_CACHE_DIR).toContain(worktreeA);
    expect(envB.RUFF_CACHE_DIR).toContain(worktreeB);
  });

  it('leaves the rest of process.env intact alongside the scoped vars', () => {
    const env = buildScopedEnv(worktreeA, { FOO_CACHE: '.foo' });
    expect(env.PATH).toBe(process.env.PATH);
  });
});

describe('checkToolchainVersions()', () => {
  it('returns null when no checks are declared', async () => {
    expect(await checkToolchainVersions('/tmp', undefined)).toBeNull();
    expect(await checkToolchainVersions('/tmp', [])).toBeNull();
  });

  it('returns null when the version command output contains the expected string', async () => {
    const result = await checkToolchainVersions(process.cwd(), [
      { version_command: 'node -e "console.log(\'v9.9.9\')"', expected: 'v9.9.9' },
    ]);
    expect(result).toBeNull();
  });

  it('reports a mismatch when the version command output lacks the expected string', async () => {
    const result = await checkToolchainVersions(process.cwd(), [
      { version_command: 'node -e "console.log(\'v1.0.0\')"', expected: 'v9.9.9' },
    ]);
    expect(result).not.toBeNull();
    expect(result?.expected).toBe('v9.9.9');
    expect(result?.actual).toContain('v1.0.0');
  });

  it('formats a mismatch distinctly from a code failure', () => {
    const msg = formatToolchainMismatch({
      versionCommand: 'eslint --version',
      expected: 'v9.0.0',
      actual: 'v7.0.0',
    });
    expect(msg).toContain('toolchain version mismatch');
    expect(msg).toContain('eslint --version');
  });
});
