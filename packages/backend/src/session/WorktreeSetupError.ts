export class WorktreeSetupError extends Error {
  readonly isBranchAlreadyExists: boolean;

  constructor(message: string, opts: { isBranchAlreadyExists: boolean }) {
    super(message);
    this.name = 'WorktreeSetupError';
    this.isBranchAlreadyExists = opts.isBranchAlreadyExists;
  }
}
