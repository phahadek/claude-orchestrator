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

/** A `claude` OS process observed in the process table by {@link scanClaudeSessionProcesses}. */
export interface ClaudeSessionProcess {
  pid: number;
  /**
   * The session uuid extracted from `--session-id <uuid>` or `--resume
   * <uuid>`, or null when neither flag is present — e.g. `claude
   * remote-control`, the operator's own console process. A null here must
   * never be treated as a reap candidate: there is no uuid to resolve to a
   * session row, so there is nothing to reconcile against.
   */
  sessionId: string | null;
  /** Seconds since the process started, per `ps -eo etimes=`. */
  etimeSeconds: number;
}

const SESSION_ID_ARG_RE = /--session-id\s+(\S+)/;
const RESUME_ARG_RE = /--resume\s+(\S+)/;
const PS_LINE_RE = /^\s*(\d+)\s+(\d+)\s+(.*)$/;

/**
 * Enumerates every OS process carrying a `--session-id <uuid>` or `--resume
 * <uuid>` argument, using the same `ps`-backed scan primitive as
 * isSessionProcessAlive (kept as a single enumeration mechanism rather than
 * introducing a second one). Used by the orphan-process sweep in
 * sessionLivenessReconciler.ts to find processes the map- and
 * row-driven reconcilers can never reach (their DB row is already terminal,
 * or missing, so neither the map sweep nor the liveness sweeps iterate it).
 *
 * Fails safe: an unreadable process table returns an empty list, so a
 * transient `ps` failure can never authorize reaping anything.
 */
export function scanClaudeSessionProcesses(): ClaudeSessionProcess[] {
  try {
    const out = execSync('ps -eo pid=,etimes=,args=', {
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const processes: ClaudeSessionProcess[] = [];
    for (const line of out.split('\n')) {
      const match = line.match(PS_LINE_RE);
      if (!match) continue;
      const [, pidStr, etimeStr, args] = match;
      const idMatch = args.match(SESSION_ID_ARG_RE) ?? args.match(RESUME_ARG_RE);
      processes.push({
        pid: Number(pidStr),
        sessionId: idMatch ? idMatch[1] : null,
        etimeSeconds: Number(etimeStr),
      });
    }
    return processes;
  } catch (err) {
    logger.error(
      `[processLiveness] ps scan failed, returning no candidates (fail-safe): ${(err as Error).message}`,
    );
    return [];
  }
}
