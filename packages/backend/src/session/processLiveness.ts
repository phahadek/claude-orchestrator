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
const PS_ARGS_LINE_RE = /^\s*(\d+)\s+(.*)$/;

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
      const idMatch =
        args.match(SESSION_ID_ARG_RE) ?? args.match(RESUME_ARG_RE);
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

/**
 * Enumerates every OS process whose command line contains `worktreePath` —
 * the attribution key for a session's test-command process tree (`pytest`,
 * `uv run task test`, ...) spawned as a Bash-tool child of the session's own
 * CLI process. Such a tree carries neither `--session-id` nor `--resume` of
 * its own, so it is structurally invisible to scanClaudeSessionProcesses
 * (whose own doc warns a null sessionId there must never be treated as a
 * reap candidate — there is nothing to resolve it against). The worktree
 * path is what ties the tree back to a session unambiguously instead: every
 * process in it runs with that path as its cwd and/or references it via argv
 * (a venv interpreter under `<worktree>/.venv/bin/python`, a report path,
 * etc).
 *
 * Never matches a Remote Control process: RC sessions have no worktree_path
 * row in this DB and never run inside a per-task worktree, so their cmdline
 * has no occasion to contain one.
 *
 * Fails safe: an unreadable process table returns an empty list, so a
 * transient `ps` failure can never authorize killing anything.
 */
export function scanWorktreeProcesses(worktreePath: string): number[] {
  try {
    const out = execSync('ps -eo pid=,args=', {
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const pids: number[] = [];
    for (const line of out.split('\n')) {
      const match = line.match(PS_ARGS_LINE_RE);
      if (!match) continue;
      const [, pidStr, args] = match;
      if (args.includes(worktreePath)) pids.push(Number(pidStr));
    }
    return pids;
  } catch (err) {
    logger.error(
      `[processLiveness] worktree process scan failed, returning no candidates (fail-safe): ${(err as Error).message}`,
    );
    return [];
  }
}

/**
 * Kills every OS process rooted in `worktreePath` (per scanWorktreeProcesses)
 * with SIGKILL. The backstop for hosts where the per-session cgroup
 * (sessionCgroup.ts's killSessionCgroup) is unavailable — no cgroup-v2
 * delegation, or non-Linux — so a worktree can still be safely removed even
 * when the cgroup-scoped kill was a no-op. Individual-pid SIGKILL (not a
 * process-group kill) is sufficient here because every member of the tree
 * independently matches the worktree-path scan, not just its root. Returns
 * the number of kill signals actually sent.
 */
export function killWorktreeProcessTree(worktreePath: string): number {
  let killed = 0;
  for (const pid of scanWorktreeProcesses(worktreePath)) {
    try {
      process.kill(pid, 'SIGKILL');
      killed++;
    } catch {
      // Already exited between the scan and this kill — not an error.
    }
  }
  return killed;
}
