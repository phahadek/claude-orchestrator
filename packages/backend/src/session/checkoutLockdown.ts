import path from 'node:path';
import fs from 'node:fs';
import { logger } from '../logger';
import { getSession } from '../db/queries';
import {
  insertPlanningCheckoutLock,
  deletePlanningCheckoutLock,
  getPlanningCheckoutLock,
  countPlanningCheckoutLocks,
  getAllPlanningCheckoutLocks,
} from '../db/queries';

/**
 * Planning sessions (groom/design/ops/split) share `cwd` === the project
 * checkout across concurrent sessions. This module reference-counts a
 * lockdown over that checkout (DB-backed, see planning_checkout_locks) so
 * the first concurrent planning session locks it and only the last one to
 * end unlocks it — with a carved-out writable scratch dir per session.
 *
 * Three subdirectories of the checkout are never touched by the lockdown
 * walk: `.claude/worktrees` (independent per-session coding worktrees, which
 * need their own write access regardless of any planning session sharing the
 * project's root cwd), `.claude/scratch` (this module's own writable
 * exception area), and `.claude/session-prompts` (the launcher's own
 * per-session control-plane files — writeMcpConfig/writeSystemPromptFile —
 * which every session, not just planning ones, must be able to write in
 * order to even start).
 */

const TERMINAL_STATUSES = new Set(['done', 'error', 'killed']);

function scratchRoot(projectDir: string): string {
  return path.join(projectDir, '.claude', 'scratch');
}

function worktreesRoot(projectDir: string): string {
  return path.join(projectDir, '.claude', 'worktrees');
}

function sessionPromptsRoot(projectDir: string): string {
  return path.join(projectDir, '.claude', 'session-prompts');
}

/**
 * Paths excluded from the lockdown walk in both directions (strip and
 * restore) — the single source of truth both call sites share, so they
 * cannot drift apart. Exported for the checkoutLockdown.test.ts drift guard.
 */
export function lockdownExcludes(projectDir: string): string[] {
  return [scratchRoot(projectDir), worktreesRoot(projectDir), sessionPromptsRoot(projectDir)];
}

export function getScratchDir(projectDir: string, sessionId: string): string {
  return path.join(scratchRoot(projectDir), sessionId);
}

/** Recursively walks `root`, invoking `apply(currentMode)` on every entry not under `excludes`. */
function walkAndChmod(
  root: string,
  excludes: string[],
  apply: (mode: number) => number,
): void {
  const resolvedExcludes = excludes.map((p) => path.resolve(p));

  function walk(p: string): void {
    if (resolvedExcludes.includes(path.resolve(p))) return;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    // Never chase symlinks — chmod would follow them outside the checkout.
    if (st.isSymbolicLink()) return;
    try {
      fs.chmodSync(p, apply(st.mode));
    } catch (err) {
      logger.warn(`[checkoutLockdown] chmod failed for ${p}: ${err}`);
    }
    if (st.isDirectory()) {
      let entries: string[];
      try {
        entries = fs.readdirSync(p);
      } catch {
        return;
      }
      for (const entry of entries) walk(path.join(p, entry));
    }
  }

  walk(root);
}

/**
 * Strips all write bits (owner/group/other) from every file and directory
 * under `projectDir`, excluding `.claude/worktrees` and `.claude/scratch`.
 * `.git` is included in the walk — verified (see
 * checkoutLockdown.test.ts's "read-only .git allowlist verification" suite,
 * which runs each command for real against a fully read-only repo) that
 * none of the planning read-only Bash allowlist (log/diff/show/status/
 * blame/ls-files/rev-parse) requires a durable write to function, so no
 * path under `.git` needs a carve-out.
 */
function stripWriteRecursive(projectDir: string): void {
  walkAndChmod(projectDir, lockdownExcludes(projectDir), (mode) => mode & ~0o222);
  logger.info(`[checkoutLockdown] locked down checkout: ${projectDir}`);
}

/**
 * Restores owner write access under `projectDir`. Only the owner-write bit
 * is restored (group/other write bits, if a checkout somehow had any, are
 * not) — a solo-owned orchestrator checkout never had them to begin with.
 *
 * The excluded roots themselves are also given a shallow, idempotent
 * owner-write restore (not a recursive walk of their contents). In steady
 * state this is a no-op: the launcher always creates/writes under them
 * before any strip ever walks the tree. Its only real effect is defensive —
 * repairing an excluded root that was left read-only by a lock acquired
 * before this exclusion existed.
 */
function restoreWriteRecursive(projectDir: string): void {
  const excludes = lockdownExcludes(projectDir);
  walkAndChmod(projectDir, excludes, (mode) => mode | 0o200);
  for (const dir of excludes) {
    try {
      const st = fs.lstatSync(dir);
      fs.chmodSync(dir, st.mode | 0o200);
    } catch {
      // Doesn't exist yet — nothing to restore.
    }
  }
  logger.info(`[checkoutLockdown] lifted checkout lockdown: ${projectDir}`);
}

function createScratchDir(projectDir: string, sessionId: string): string {
  const scratchDir = getScratchDir(projectDir, sessionId);
  fs.mkdirSync(scratchDir, { recursive: true });
  fs.chmodSync(scratchDir, 0o755);
  return scratchDir;
}

function removeScratchDir(scratchDir: string): void {
  try {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  } catch (err) {
    logger.warn(
      `[checkoutLockdown] failed to remove scratch dir ${scratchDir}: ${err}`,
    );
  }
}

export interface CheckoutLockdownOptions {
  /**
   * Whether to strip filesystem write permission from the checkout itself.
   * CLI-mode sessions rely on this (no directory sandbox of their own).
   * Docker-mode sessions instead get a read-only bind mount at the runner
   * level, so this should be false there — the OS-level chmod would be
   * redundant (and would need lifting again on the host regardless of
   * container lifecycle).
   */
  applyFsLockdown: boolean;
}

/**
 * Acquires the checkout lockdown for a planning session: creates its
 * writable scratch dir, records it in the ref-counted DB table, and — if
 * this is the first concurrent lock and `applyFsLockdown` is set — strips
 * write permission from the rest of the checkout.
 *
 * Returns the session's scratch dir path.
 */
export function acquireCheckoutLockdown(
  projectDir: string,
  sessionId: string,
  options: CheckoutLockdownOptions,
): string {
  const scratchDir = createScratchDir(projectDir, sessionId);
  insertPlanningCheckoutLock(sessionId, projectDir, scratchDir);

  const count = countPlanningCheckoutLocks(projectDir);
  if (options.applyFsLockdown && count === 1) {
    stripWriteRecursive(projectDir);
  }

  return scratchDir;
}

/**
 * Releases the checkout lockdown held by `sessionId` (no-op if it never
 * held one — e.g. non-planning sessions, or already released): removes its
 * scratch dir, drops the DB row, and — if this was the last concurrent
 * planning session on that checkout — lifts the lockdown.
 */
export function releaseCheckoutLockdown(
  sessionId: string,
  options: CheckoutLockdownOptions,
): void {
  const row = getPlanningCheckoutLock(sessionId);
  if (!row) return;

  removeScratchDir(row.scratch_dir);
  deletePlanningCheckoutLock(sessionId);

  const count = countPlanningCheckoutLocks(row.project_dir);
  if (options.applyFsLockdown && count === 0) {
    restoreWriteRecursive(row.project_dir);
  }
}

/**
 * Boot-time reconciliation: prunes lock rows for sessions that are terminal
 * (or gone entirely — process died before it could release) and restores
 * each touched project's filesystem state to match its post-prune ref
 * count. Idempotent — safe to run even when nothing crashed mid-transition.
 */
export function reconcileCheckoutLockdownAtBoot(options: {
  applyFsLockdown: boolean;
}): void {
  const rows = getAllPlanningCheckoutLocks();
  const touchedDirs = new Set(rows.map((r) => r.project_dir));

  for (const row of rows) {
    const session = getSession(row.session_id);
    const isTerminal = !session || TERMINAL_STATUSES.has(session.status);
    if (!isTerminal) continue;

    logger.info(
      `[checkoutLockdown] boot reconciliation: pruning stale lock for session ${row.session_id.slice(0, 8)}`,
    );
    removeScratchDir(row.scratch_dir);
    deletePlanningCheckoutLock(row.session_id);
  }

  for (const projectDir of touchedDirs) {
    const count = countPlanningCheckoutLocks(projectDir);
    if (!options.applyFsLockdown) continue;
    if (count > 0) {
      stripWriteRecursive(projectDir);
    } else {
      restoreWriteRecursive(projectDir);
    }
  }
}
