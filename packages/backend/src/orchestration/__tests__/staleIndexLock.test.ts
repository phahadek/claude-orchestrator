import { describe, it, expect, vi } from 'vitest';
import {
  recoverStaleIndexLock,
  type StaleIndexLockDeps,
} from '../staleIndexLock.js';

function makeDeps(overrides: Partial<StaleIndexLockDeps>): StaleIndexLockDeps {
  return {
    resolveGitDir: vi.fn(async () => '/repo/.git/worktrees/abc123'),
    statLock: vi.fn(async () => ({ size: 0 })),
    hasLiveGitProcess: vi.fn(async () => false),
    removeLock: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('recoverStaleIndexLock', () => {
  it('removes a 0-byte lock when no live git process holds it', async () => {
    const removeLock = vi.fn(async () => {});
    const deps = makeDeps({ removeLock });

    const result = await recoverStaleIndexLock('/repo/wt/abc123', deps);

    expect(result).toBe(true);
    expect(removeLock).toHaveBeenCalledWith(
      '/repo/.git/worktrees/abc123/index.lock',
    );
  });

  it('does not remove the lock when a live git process holds it', async () => {
    const removeLock = vi.fn(async () => {});
    const deps = makeDeps({
      hasLiveGitProcess: vi.fn(async () => true),
      removeLock,
    });

    const result = await recoverStaleIndexLock('/repo/wt/abc123', deps);

    expect(result).toBe(false);
    expect(removeLock).not.toHaveBeenCalled();
  });

  it('does not remove the lock when it is non-zero bytes (in-flight write)', async () => {
    const removeLock = vi.fn(async () => {});
    const deps = makeDeps({
      statLock: vi.fn(async () => ({ size: 128 })),
      removeLock,
    });

    const result = await recoverStaleIndexLock('/repo/wt/abc123', deps);

    expect(result).toBe(false);
    expect(removeLock).not.toHaveBeenCalled();
  });

  it('is a no-op when there is no lock file', async () => {
    const removeLock = vi.fn(async () => {});
    const deps = makeDeps({
      statLock: vi.fn(async () => null),
      removeLock,
    });

    const result = await recoverStaleIndexLock('/repo/wt/abc123', deps);

    expect(result).toBe(false);
    expect(removeLock).not.toHaveBeenCalled();
  });

  it('is a no-op when the git dir cannot be resolved', async () => {
    const statLock = vi.fn(async () => ({ size: 0 }));
    const deps = makeDeps({
      resolveGitDir: vi.fn(async () => null),
      statLock,
    });

    const result = await recoverStaleIndexLock('/repo/wt/abc123', deps);

    expect(result).toBe(false);
    expect(statLock).not.toHaveBeenCalled();
  });

  it('returns false and does not throw when removeLock fails', async () => {
    const deps = makeDeps({
      removeLock: vi.fn(async () => {
        throw new Error('EACCES');
      }),
    });

    const result = await recoverStaleIndexLock('/repo/wt/abc123', deps);

    expect(result).toBe(false);
  });
});
