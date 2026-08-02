export class WorktreeSetupError extends Error {
  readonly isBranchAlreadyExists: boolean;
  /**
   * True when the underlying failure was classified as a degraded backend
   * spawn (empty stderr + killed/signal outcome) rather than a real git
   * error — see isDegradedSpawnFailure in SessionManager.ts.
   */
  readonly isDegradedSpawn: boolean;

  constructor(
    message: string,
    opts: { isBranchAlreadyExists: boolean; isDegradedSpawn?: boolean },
  ) {
    super(message);
    this.name = 'WorktreeSetupError';
    this.isBranchAlreadyExists = opts.isBranchAlreadyExists;
    this.isDegradedSpawn = opts.isDegradedSpawn ?? false;
  }
}
