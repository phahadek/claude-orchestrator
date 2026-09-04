/**
 * Per-checkout reader-writer lock serializing a deploy's `install-deps` step
 * (`npm ci` against the project checkout) against test.request lane runs
 * that resolve their modules through that same checkout's `node_modules` —
 * a worktree has none of its own (see testRequestLane.ts's doc comment on
 * why a project with no `bootstrap_script` shares the checkout's install).
 * `npm ci` removes and reinstalls `node_modules` wholesale; a run in flight
 * during that window loses its module tree mid-execution.
 *
 * `npm ci` (the writer, via `withCheckoutInstallLock`) is exclusive against
 * everything. Test runs (readers, via `withCheckoutTestRunLock`) are
 * exclusive against `npm ci` but *not* against each other — two test runs
 * against the same project already run concurrently (see the per-project
 * test-lane concurrency cap), and serializing them against a plain mutex
 * here would silently cut that concurrency to 1. A queued writer blocks
 * readers that arrive after it, so it cannot starve behind a steady stream
 * of new reads.
 *
 * Only relevant to a project that actually shares its checkout's install —
 * see `sharesCheckoutNodeModules`. A project with a `bootstrap_script`
 * provisions each worktree's own dependencies and must not acquire this
 * lock, or it becomes an unnecessary throughput cap.
 */

import path from 'path';
import { loadOrchestratorConfig } from '../session/orchestrator-config';

type Waiter = { kind: 'read' | 'write'; grant: () => void };

class CheckoutRWLock {
  private readers = 0;
  private writerActive = false;
  private queue: Waiter[] = [];

  private pump(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (next.kind === 'write') {
        if (this.readers > 0 || this.writerActive) break;
        this.queue.shift();
        this.writerActive = true;
        next.grant();
        break;
      }
      // A queued write ahead of this read must run first — do not let
      // later reads jump it and starve the writer.
      if (this.writerActive) break;
      this.queue.shift();
      this.readers++;
      next.grant();
    }
  }

  acquireRead(): Promise<() => void> {
    return new Promise((resolve) => {
      this.queue.push({
        kind: 'read',
        grant: () =>
          resolve(() => {
            this.readers--;
            this.pump();
          }),
      });
      this.pump();
    });
  }

  /**
   * `syncTracker.granted` is set synchronously (within this call, before it
   * returns) when the write lock was granted without waiting — the initial
   * `pump()` call below runs entirely inside the `Promise` executor, so by
   * the time `new Promise(...)` returns, `grant()` has already run if it was
   * going to run synchronously at all.
   */
  acquireWrite(): {
    promise: Promise<() => void>;
    syncTracker: { granted: boolean };
  } {
    const syncTracker = { granted: false };
    const promise = new Promise<() => void>((resolve) => {
      this.queue.push({
        kind: 'write',
        grant: () => {
          syncTracker.granted = true;
          resolve(() => {
            this.writerActive = false;
            this.pump();
          });
        },
      });
      this.pump();
    });
    return { promise, syncTracker };
  }

  isIdle(): boolean {
    return this.readers === 0 && !this.writerActive && this.queue.length === 0;
  }

  /** Current reader count and queue depth, for surfacing a writer's wait to callers. */
  occupancy(): { readers: number; queueDepth: number } {
    return { readers: this.readers, queueDepth: this.queue.length };
  }
}

const checkoutLocks = new Map<string, CheckoutRWLock>();

function getLock(dir: string): { key: string; lock: CheckoutRWLock } {
  const key = path.resolve(dir);
  let lock = checkoutLocks.get(key);
  if (!lock) {
    lock = new CheckoutRWLock();
    checkoutLocks.set(key, lock);
  }
  return { key, lock };
}

function cleanupIfIdle(key: string, lock: CheckoutRWLock): void {
  if (lock.isIdle() && checkoutLocks.get(key) === lock) {
    checkoutLocks.delete(key);
  }
}

/**
 * True when a project (identified by its checkout or worktree directory —
 * both resolve to the same `.claude-orchestrator.yml`) has no
 * `bootstrap_script` configured, meaning its worktrees provision no
 * dependencies of their own and resolve modules through the checkout's
 * `node_modules` instead.
 */
export function sharesCheckoutNodeModules(dir: string): boolean {
  return !loadOrchestratorConfig(dir).bootstrap_script;
}

/** Test-only introspection: number of checkout keys with a live/pending lock. */
export function __checkoutInstallLockMapSizeForTest(): number {
  return checkoutLocks.size;
}

export interface CheckoutInstallLockHooks {
  /** Fires only when the write lock is not granted synchronously — i.e. an actual wait began. */
  onWaitStart?: (info: { readers: number; queueDepth: number }) => void;
  /** Always fires once the write lock is granted, carrying elapsed ms from request to grant. */
  onAcquired?: (waitedMs: number) => void;
}

/** Exclusive acquisition — used by the deploy's install-deps step. */
export async function withCheckoutInstallLock<T>(
  checkoutDir: string,
  fn: () => Promise<T>,
  hooks?: CheckoutInstallLockHooks,
): Promise<T> {
  const { key, lock } = getLock(checkoutDir);
  const requestedAt = Date.now();
  const occupancyBeforeRequest = lock.occupancy();
  const { promise, syncTracker } = lock.acquireWrite();
  if (!syncTracker.granted) {
    hooks?.onWaitStart?.(occupancyBeforeRequest);
  }
  const release = await promise;
  hooks?.onAcquired?.(Date.now() - requestedAt);
  try {
    return await fn();
  } finally {
    release();
    cleanupIfIdle(key, lock);
  }
}

/** Shared acquisition — used by test.request lane runs. */
export async function withCheckoutTestRunLock<T>(
  checkoutDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const { key, lock } = getLock(checkoutDir);
  const release = await lock.acquireRead();
  try {
    return await fn();
  } finally {
    release();
    cleanupIfIdle(key, lock);
  }
}
