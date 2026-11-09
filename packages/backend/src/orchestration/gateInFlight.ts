/**
 * Per-worktree marker for a pre-review gate stage that reads the live session
 * worktree. The test lane's pre-test dev merge waits on it so the merge can't
 * change the tree under a stage that is reading it.
 */

const inFlight = new Map<string, Promise<void>>();

/** Runs fn with the worktree marked in flight; waits out any prior holder first. */
export async function withGateInFlight<T>(
  worktreePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  while (inFlight.has(worktreePath)) await inFlight.get(worktreePath);
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  inFlight.set(worktreePath, done);
  try {
    return await fn();
  } finally {
    if (inFlight.get(worktreePath) === done) inFlight.delete(worktreePath);
    release();
  }
}
