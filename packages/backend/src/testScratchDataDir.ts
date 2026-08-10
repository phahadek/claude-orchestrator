import path from 'path';

// Package-anchored (via this module's own __dirname) rather than
// process.cwd()-anchored, so the scratch dir always lands under
// packages/backend/ regardless of where vitest was invoked from — see
// testSetupDb.ts for the consumer and .gitignore for the matching entry.
export function resolveTestScratchDataDir(
  pid: number,
  backendSrcDir: string = __dirname,
): string {
  return path.join(
    backendSrcDir,
    '..',
    '.test-scratch-datadir-DO-NOT-COMMIT',
    `pid-${pid}`,
  );
}
