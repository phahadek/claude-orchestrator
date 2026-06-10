import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'child_process';
import { getAllProjects } from '../config';
import type { ProjectConfig } from '../config';
import { getSession, getPRBySessionId } from '../db/queries';
import { recordEvent } from '../audit/AuditLog';

const TERMINAL_STATUSES = new Set(['done', 'error', 'killed']);

export async function runBootWorktreeReconciliation(options?: {
  listProjects?: () => ProjectConfig[];
}): Promise<void> {
  const listProjects = options?.listProjects ?? getAllProjects;
  const projects = listProjects();

  let removed = 0;
  let skipped = 0;
  let failed = 0;

  for (const project of projects) {
    const worktreesDir = path.join(project.projectDir, '.claude', 'worktrees');

    let entries: string[];
    try {
      entries = fs.readdirSync(worktreesDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const worktreePath = path.join(worktreesDir, entry);

      try {
        if (!fs.statSync(worktreePath).isDirectory()) continue;
      } catch {
        continue;
      }

      const sessionId = entry;
      const session = getSession(sessionId);

      if (session && !TERMINAL_STATUSES.has(session.status)) {
        skipped++;
        continue;
      }

      let branchName: string | undefined;
      try {
        const head = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: worktreePath,
          encoding: 'utf8',
        }).trim();
        if (head !== 'HEAD') branchName = head;
      } catch {
        // worktree may be stale — skip branch detection
      }

      try {
        execSync(`git worktree remove --force "${worktreePath}"`, {
          cwd: project.projectDir,
        });

        try {
          execSync('git worktree prune', { cwd: project.projectDir });
        } catch (pruneErr) {
          console.warn(
            `[WorktreeReconciler] git worktree prune failed for project ${project.id}: ${pruneErr}`,
          );
        }

        const pr = getPRBySessionId(sessionId);
        const deleteBranch =
          !pr || pr.state === 'merged' || pr.state === 'closed';
        if (deleteBranch && branchName) {
          try {
            execSync(`git branch -D "${branchName}"`, {
              cwd: project.projectDir,
            });
          } catch (branchErr) {
            console.warn(
              `[WorktreeReconciler] failed to delete branch ${branchName} for session ${sessionId.slice(0, 8)}: ${branchErr}`,
            );
          }
        }

        removed++;
        console.log(
          `[WorktreeReconciler] removed worktree for session ${sessionId.slice(0, 8)} (project ${project.id})`,
        );
      } catch (err) {
        failed++;
        console.error(
          `[WorktreeReconciler] failed to remove worktree ${worktreePath} for session ${sessionId.slice(0, 8)}: ${err}`,
        );
        recordEvent({
          event_type: 'worktree_remove_failed',
          actor_type: 'system',
          project_id: project.id,
          payload: {
            session_id: sessionId,
            worktree_path: worktreePath,
            error: String(err),
          },
        });
      }
    }
  }

  if (removed > 0 || failed > 0) {
    console.log(
      `[WorktreeReconciler] boot sweep complete — removed: ${removed}, failed: ${failed}, skipped: ${skipped}`,
    );
  }
}
