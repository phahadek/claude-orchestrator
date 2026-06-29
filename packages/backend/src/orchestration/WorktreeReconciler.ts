import path from 'node:path';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger';
import { getAllProjects, normalizePath } from '../config';
import type { ProjectConfig } from '../config';
import { getSession, getPRBySessionId } from '../db/queries';
import { recordEvent } from '../audit/AuditLog';
import { runWithConcurrency } from '../utils/concurrency';
import type { Scheduler } from './Scheduler';

const execAsync = promisify(exec);

// A worktree is reclaimed only when its session is definitively terminal.
// This guard is safe because a session's DB row is inserted (SessionManager.ts)
// before its worktree is created (git worktree add). If a session ID is absent
// from the DB, no live session owns that worktree and it is safe to prune.
const TERMINAL_STATUSES = new Set(['done', 'error', 'killed']);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SWEEP_CONCURRENCY = 4;
const MAINTENANCE_INTERVAL_MS = 30 * 60_000;

async function fsExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

function parseRegisteredPaths(porcelainOutput: string): string[] {
  const paths: string[] = [];
  for (const line of porcelainOutput.split('\n')) {
    if (line.startsWith('worktree ')) {
      paths.push(line.slice(9).trim());
    }
  }
  return paths;
}

interface ProjectStats {
  removed: number;
  fsDeleted: number;
  skipped: number;
  failed: number;
  pruned: number;
}

async function reconcileProject(
  project: ProjectConfig,
  platform: NodeJS.Platform = process.platform,
): Promise<ProjectStats> {
  const stats: ProjectStats = {
    removed: 0,
    fsDeleted: 0,
    skipped: 0,
    failed: 0,
    pruned: 0,
  };

  const projectDir = normalizePath(project.projectDir, platform);
  const worktreesDir = path.join(projectDir, '.claude', 'worktrees');
  const worktreesDirNorm = normalizeSlashes(worktreesDir);

  // Phase: enumerate git-registered worktrees
  let registeredPaths: string[];
  const listStart = Date.now();
  try {
    const { stdout: out } = await execAsync('git worktree list --porcelain', {
      cwd: projectDir,
    });
    registeredPaths = parseRegisteredPaths(out);
  } catch {
    registeredPaths = [];
  }
  const worktree_list_duration_ms = Date.now() - listStart;

  // Build map of session IDs git-registered directly under .claude/worktrees/
  const registeredSessionIds = new Set<string>();
  const registeredPathMap = new Map<string, string>(); // sessionId → wtPath
  for (const wtPath of registeredPaths) {
    const normPath = normalizeSlashes(wtPath);
    const sessionId = normPath.substring(normPath.lastIndexOf('/') + 1);
    if (sessionId && normPath === `${worktreesDirNorm}/${sessionId}`) {
      registeredSessionIds.add(sessionId);
      registeredPathMap.set(sessionId, wtPath);
    }
  }

  // Phase 1: git-remove registered worktrees whose session is terminal or absent
  let worktree_remove_duration_ms = 0;
  let worktree_branch_delete_duration_ms = 0;

  for (const [sessionId, wtPath] of registeredPathMap) {
    const session = getSession(sessionId);

    if (session && !TERMINAL_STATUSES.has(session.status)) {
      stats.skipped++;
      continue;
    }

    if (!(await fsExists(wtPath))) {
      stats.pruned++;
      logger.debug(
        `[WorktreeReconciler] worktree dir already gone for session ${sessionId.slice(0, 8)}, letting prune reap registration`,
      );
      continue;
    }

    let branchName: string | undefined;
    try {
      const { stdout: head } = await execAsync(
        'git rev-parse --abbrev-ref HEAD',
        {
          cwd: wtPath,
        },
      );
      if (head.trim() !== 'HEAD') branchName = head.trim();
    } catch {
      // stale — skip branch detection
    }

    try {
      const removeStart = Date.now();
      await execAsync(`git worktree remove --force "${wtPath}"`, {
        cwd: projectDir,
      });
      worktree_remove_duration_ms += Date.now() - removeStart;

      const pr = getPRBySessionId(sessionId);
      const deleteBranch =
        !pr || pr.state === 'merged' || pr.state === 'closed';
      if (deleteBranch && branchName) {
        try {
          const branchStart = Date.now();
          await execAsync(`git branch -D "${branchName}"`, {
            cwd: projectDir,
          });
          worktree_branch_delete_duration_ms += Date.now() - branchStart;
        } catch (branchErr) {
          logger.warn(
            `[WorktreeReconciler] failed to delete branch ${branchName} for session ${sessionId.slice(0, 8)}: ${branchErr}`,
          );
        }
      }

      stats.removed++;
      logger.info(
        `[WorktreeReconciler] removed worktree for session ${sessionId.slice(0, 8)} (project ${project.id})`,
      );
    } catch (err) {
      let fallbackOk = false;
      if (await fsExists(wtPath)) {
        try {
          await fs.promises.rm(wtPath, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 500,
          });
          fallbackOk = true;
          logger.info(
            `[WorktreeReconciler] fs.promises.rm fallback succeeded for session ${sessionId.slice(0, 8)} after git worktree remove failed`,
          );
        } catch (rmErr) {
          logger.error(
            `[WorktreeReconciler] fs.promises.rm fallback also failed for session ${sessionId.slice(0, 8)}: ${rmErr}`,
          );
        }
      }
      stats.failed++;
      logger.error(
        `[WorktreeReconciler] failed to remove worktree ${wtPath} for session ${sessionId.slice(0, 8)}: ${err}`,
      );
      recordEvent({
        event_type: 'worktree_remove_failed',
        actor_type: 'system',
        project_id: project.id,
        payload: {
          session_id: sessionId,
          worktree_path: wtPath,
          error: String(err),
          fallbackOk,
        },
      });
    }
    // Fix A: per-worktree prune ensures stale registration is reaped even if a sibling remove also fails
    try {
      await execAsync('git worktree prune', { cwd: projectDir });
    } catch (pruneErr) {
      logger.warn(
        `[WorktreeReconciler] post-remove prune failed for project ${project.id}: ${pruneErr}`,
      );
    }
  }

  // Phase 2: fs-delete unregistered UUID dirs whose session is terminal or absent
  let entries: string[];
  try {
    entries = await fs.promises.readdir(worktreesDir);
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    if (!UUID_RE.test(entry)) continue;
    if (registeredSessionIds.has(entry)) continue; // handled in phase 1

    const worktreePath = path.join(worktreesDir, entry);

    try {
      if (!(await fs.promises.stat(worktreePath)).isDirectory()) continue;
    } catch {
      continue;
    }

    const session = getSession(entry);
    if (session && !TERMINAL_STATUSES.has(session.status)) {
      stats.skipped++;
      continue;
    }

    try {
      await fs.promises.rm(worktreePath, { recursive: true, force: true });
      stats.fsDeleted++;
      logger.info(
        `[WorktreeReconciler] fs-deleted orphaned dir for session ${entry.slice(0, 8)} (project ${project.id})`,
      );
    } catch (err) {
      logger.error(
        `[WorktreeReconciler] failed to fs-delete orphaned dir ${worktreePath}: ${err}`,
      );
    }
  }

  // Phase: prune stale git metadata
  const pruneStart = Date.now();
  try {
    await execAsync('git worktree prune', { cwd: projectDir });
  } catch (pruneErr) {
    logger.warn(
      `[WorktreeReconciler] git worktree prune failed for project ${project.id}: ${pruneErr}`,
    );
  }
  const worktree_prune_duration_ms = Date.now() - pruneStart;

  logger.info('[WorktreeReconciler] per-repo profile', {
    project_id: project.id,
    worktree_list_duration_ms,
    worktree_remove_duration_ms,
    worktree_branch_delete_duration_ms,
    worktree_prune_duration_ms,
  });

  return stats;
}

async function runSweep(options?: {
  listProjects?: () => ProjectConfig[];
  platform?: NodeJS.Platform;
}): Promise<void> {
  const listProjects = options?.listProjects ?? getAllProjects;
  const platform = options?.platform ?? process.platform;
  const projects = listProjects();

  const results = await runWithConcurrency(
    projects,
    SWEEP_CONCURRENCY,
    (project) => reconcileProject(project, platform),
  );

  let removed = 0;
  let fsDeleted = 0;
  let skipped = 0;
  let failed = 0;
  let pruned = 0;

  for (const r of results) {
    removed += r.removed;
    fsDeleted += r.fsDeleted;
    skipped += r.skipped;
    failed += r.failed;
    pruned += r.pruned;
  }

  if (removed > 0 || fsDeleted > 0 || failed > 0 || pruned > 0) {
    logger.info(
      `[WorktreeReconciler] sweep complete — removed: ${removed}, fs-deleted: ${fsDeleted}, pruned: ${pruned}, failed: ${failed}, skipped: ${skipped}`,
    );
  }
}

export async function runBootWorktreeReconciliation(options?: {
  listProjects?: () => ProjectConfig[];
  platform?: NodeJS.Platform;
}): Promise<void> {
  return runSweep(options);
}

export function register(scheduler: Scheduler): void {
  scheduler.register({
    name: 'worktree_reconciler',
    intervalMs: MAINTENANCE_INTERVAL_MS,
    runOnBoot: true,
    concurrency: 'skip-if-running',
    run: async () => {
      await runSweep();
    },
  });
}
