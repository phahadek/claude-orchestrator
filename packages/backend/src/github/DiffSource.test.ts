import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (must come before imports of the modules under test) ──────────────

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('util', () => ({
  promisify:
    (fn: (...args: unknown[]) => void) =>
    (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        fn(...args, (err: unknown, result: unknown) => {
          if (err) reject(err);
          else resolve(result);
        });
      }),
}));

import { execFile } from 'child_process';
import { GitHubDiffSource, LocalDiffSource } from './DiffSource';
import type { GitHubClient } from './GitHubClient';
import type { PRDiff } from './types';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── GitHubDiffSource ──────────────────────────────────────────────────────────

describe('GitHubDiffSource', () => {
  it('fetchDiff() returns the diff string from GitHubClient.fetchDiff', async () => {
    const diffText =
      'diff --git a/src/foo.ts b/src/foo.ts\n+export const bar = 2;\n';
    const mockDiff: PRDiff = {
      prId: 42,
      diff: diffText,
      filesChanged: ['src/foo.ts'],
    };
    const github = {
      fetchDiff: vi.fn().mockResolvedValue(mockDiff),
    } as unknown as GitHubClient;

    const source = new GitHubDiffSource(github, 'owner/repo', 42);
    const result = await source.fetchDiff();

    expect(github.fetchDiff).toHaveBeenCalledWith(42, 'owner/repo');
    expect(result).toBe(diffText);
  });

  it('fetchDiff() propagates errors from GitHubClient', async () => {
    const github = {
      fetchDiff: vi.fn().mockRejectedValue(new Error('API error')),
    } as unknown as GitHubClient;

    const source = new GitHubDiffSource(github, 'owner/repo', 99);
    await expect(source.fetchDiff()).rejects.toThrow('API error');
  });
});

// ── LocalDiffSource ───────────────────────────────────────────────────────────

describe('LocalDiffSource', () => {
  it('fetchDiff() runs git diff <base>..<head> in the worktree and returns stdout', async () => {
    const diffOutput = 'diff --git a/README.md b/README.md\n+Hello world\n';
    vi.mocked(execFile).mockImplementation(
      (
        _cmd,
        _args,
        _opts,
        cb: (err: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        cb(null, { stdout: diffOutput, stderr: '' });
        return undefined as any;
      },
    );

    const source = new LocalDiffSource(
      '/path/to/worktree',
      'dev',
      'feature/my-branch',
    );
    const result = await source.fetchDiff();

    expect(execFile).toHaveBeenCalledWith(
      'git',
      ['diff', 'dev..feature/my-branch'],
      { cwd: '/path/to/worktree' },
      expect.any(Function),
    );
    expect(result).toBe(diffOutput);
  });

  it('fetchDiff() propagates git errors', async () => {
    vi.mocked(execFile).mockImplementation(
      (_cmd, _args, _opts, cb: (err: Error) => void) => {
        cb(new Error('fatal: not a git repository'));
        return undefined as any;
      },
    );

    const source = new LocalDiffSource('/bad/path', 'dev', 'feature/x');
    await expect(source.fetchDiff()).rejects.toThrow(
      'fatal: not a git repository',
    );
  });
});
