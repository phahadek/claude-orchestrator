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
