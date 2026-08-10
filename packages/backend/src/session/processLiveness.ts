import { execSync } from 'child_process';
import { logger } from '../logger';

/**
 * True if an OS process is currently running this session — a `claude
 * --session-id <id>` CLI invocation, or the equivalent `docker exec ...
 * --session-id <id>` for Docker-mode sessions (see CliSessionRunner and
 * DockerSessionRunner, both of which pass `--session-id` on a fresh spawn,
 * or `--resume <id>` when resuming an existing session — e.g. every
 * idle-session wake). Deliberately independent of SessionManager's in-memory
 * `this.sessions` map / isAlive() — the liveness reconciler exists precisely
 * because that map can diverge from the real process table in either
 * direction, and reusing it as the liveness signal would be the same
 * near-miss the reconciler is meant to close.
 *
 * Fails safe: an unreadable process table is treated as "alive" so a
 * transient `ps` failure can never authorize a destructive terminal write.
 */
export function isSessionProcessAlive(sessionId: string): boolean {
  try {
    const out = execSync('ps -eo args=', {
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return (
      out.includes(`--session-id ${sessionId}`) ||
      out.includes(`--resume ${sessionId}`)
    );
  } catch (err) {
    logger.error(
      `[processLiveness] ps check failed for ${sessionId.slice(0, 8)}, treating as alive (fail-safe): ${(err as Error).message}`,
    );
    return true;
  }
}
