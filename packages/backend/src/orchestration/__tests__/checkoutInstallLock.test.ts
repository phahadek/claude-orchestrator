/**
 * Tests for the optional hooks argument to withCheckoutInstallLock
 * (packages/backend/src/orchestration/checkoutInstallLock.ts) — the
 * lock-wait/lock-acquired instrumentation used to surface a deploy's
 * install-deps step waiting behind in-flight test-lane readers.
 *
 * Deliberately kept out of testRequestLane.test.ts, which owns the
 * pre-existing lock contention tests, to avoid a worktree collision with a
 * sibling task editing that file.
 */

import { describe, it, expect } from 'vitest';
import {
  withCheckoutInstallLock,
  withCheckoutTestRunLock,
} from '../checkoutInstallLock';

describe('withCheckoutInstallLock hooks', () => {
  it('calls onAcquired with a duration and skips onWaitStart when there is no contention', async () => {
    const waitStarts: unknown[] = [];
    const acquiredDurations: number[] = [];

    await withCheckoutInstallLock(
      '/tmp/checkout-hooks-no-contention',
      async () => {},
      {
        onWaitStart: (info) => waitStarts.push(info),
        onAcquired: (waitedMs) => acquiredDurations.push(waitedMs),
      },
    );

    expect(waitStarts).toEqual([]);
    expect(acquiredDurations).toHaveLength(1);
    expect(acquiredDurations[0]).toBeGreaterThanOrEqual(0);
  });

  it('fires onWaitStart exactly once with the readers/queueDepth, and onAcquired only after the reader releases', async () => {
    const dir = '/tmp/checkout-hooks-contended';
    let releaseRead: () => void;
    const readPromise = withCheckoutTestRunLock(
      dir,
      () =>
        new Promise<void>((resolve) => {
          releaseRead = resolve;
        }),
    );
    // Let the reader actually acquire before the writer requests the lock.
    await new Promise((r) => setTimeout(r, 0));

    const waitStarts: { readers: number; queueDepth: number }[] = [];
    let acquired = false;
    const installPromise = withCheckoutInstallLock(
      dir,
      async () => {
        acquired = true;
      },
      {
        onWaitStart: (info) => waitStarts.push(info),
        onAcquired: () => {
          expect(acquired).toBe(false);
        },
      },
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(waitStarts).toHaveLength(1);
    expect(waitStarts[0]).toEqual({ readers: 1, queueDepth: 0 });
    expect(acquired).toBe(false);

    releaseRead!();
    await readPromise;
    await installPromise;
    expect(acquired).toBe(true);
  });

  it('measures waitedMs from lock request to grant, not from function entry', async () => {
    const dir = '/tmp/checkout-hooks-waited-ms';
    let releaseRead: () => void;
    const readPromise = withCheckoutTestRunLock(
      dir,
      () =>
        new Promise<void>((resolve) => {
          releaseRead = resolve;
        }),
    );
    await new Promise((r) => setTimeout(r, 0));

    let waitedMs = -1;
    const installPromise = withCheckoutInstallLock(dir, async () => {}, {
      onAcquired: (ms) => {
        waitedMs = ms;
      },
    });

    await new Promise((r) => setTimeout(r, 30));
    releaseRead!();
    await readPromise;
    await installPromise;

    expect(waitedMs).toBeGreaterThanOrEqual(25);
  });

  it('omitting the hooks argument entirely preserves current behaviour', async () => {
    let ran = false;
    await expect(
      withCheckoutInstallLock('/tmp/checkout-hooks-no-hooks', async () => {
        ran = true;
      }),
    ).resolves.toBeUndefined();
    expect(ran).toBe(true);
  });
});
