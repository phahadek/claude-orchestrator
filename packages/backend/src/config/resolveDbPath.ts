import path from 'path';

/**
 * Resolves a configured db.path against the data directory, never against
 * process.cwd() — a CWD-relative path silently pointed a production install
 * at an empty database at the wrong location (systemd sets CWD, not the
 * operator, so a relative path there is never intentional).
 */
export function resolveDbPath(rawPath: string, dataDir: string): string {
  if (rawPath === ':memory:') return rawPath;
  return path.isAbsolute(rawPath) ? rawPath : path.join(dataDir, rawPath);
}

/**
 * Returns the absolute paths a relative db.path resolved to before the fix
 * above — process.cwd() (the pre-2.0.0 default) and the backend package
 * root (the CWD when the backend is launched from within its own package
 * directory, e.g. `npm run dev`). An upgrade that leaves a populated
 * database at one of these is the exact silent-empty-dashboard failure mode
 * this module was built to prevent; see assertDatabaseSchema.ts for where
 * these candidates are probed.
 *
 * An absolute rawPath, or ':memory:', was never ambiguous, so there are no
 * legacy candidates for it.
 */
export function resolveLegacyDbCandidates(
  rawPath: string,
  backendPackageRoot: string,
): string[] {
  if (rawPath === ':memory:' || path.isAbsolute(rawPath)) return [];
  const candidates = [
    path.join(process.cwd(), rawPath),
    path.join(backendPackageRoot, rawPath),
  ];
  return Array.from(new Set(candidates));
}
