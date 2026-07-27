import path from 'node:path';
import fs from 'node:fs';
import { logger } from '../logger';

/**
 * Planning sessions (groom/design/ops/split) share `cwd` === the project
 * checkout across concurrent sessions. `.claude/scratch/<sessionId>` is
 * their writable per-session scratch area for output that shouldn't land
 * in tracked files — independent of any enforcement over the rest of the
 * checkout.
 */
function scratchRoot(projectDir: string): string {
  return path.join(projectDir, '.claude', 'scratch');
}

export function getScratchDir(projectDir: string, sessionId: string): string {
  return path.join(scratchRoot(projectDir), sessionId);
}

export function createScratchDir(
  projectDir: string,
  sessionId: string,
): string {
  const scratchDir = getScratchDir(projectDir, sessionId);
  fs.mkdirSync(scratchDir, { recursive: true });
  fs.chmodSync(scratchDir, 0o755);
  return scratchDir;
}

export function removeScratchDir(scratchDir: string): void {
  try {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  } catch (err) {
    logger.warn(
      `[planningScratchDir] failed to remove scratch dir ${scratchDir}: ${err}`,
    );
  }
}
