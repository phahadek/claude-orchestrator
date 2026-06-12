import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'child_process';
import { getAllProjects } from '../config';
import type { ProjectConfig } from '../config';
import { getSession, getPRBySessionId } from '../db/queries';
import { recordEvent } from '../audit/AuditLog';

const TERMINAL_STATUSES = new Set(['done', 'error', 'killed']);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export async function runBootWorktreeReconciliation(options?: {
  listProjects?: () => ProjectConfig[];
}): Promise<void> {
  const listProjects = options?.listProjects ?? getAllProjects;
  const projects = listProjects();

  let removed = 0;
  let fsDeleted = 0;
  let skipped = 0;
  let failed = 0;

  for (const project of projects) {
    const worktreesDir = path.join(project.projectDir, '.claude', 'worktrees');
    const worktreesDirNorm = normalizeSlashes(worktreesDir);

    // Enumerate git-registered worktrees for this project
    let registeredPaths: string[];
    try {
      const out = execSync('git worktree list --porcelain', {
        cwd: project.projectDir,
        encoding: 'utf8',
      }) as string;
      registeredPaths = parseRegisteredPaths(out);
    } catch {
      registeredPaths = [];
    }

    // Build map of session IDs that are git-registered directly under .claude/worktrees/
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
    for (const [sessionId, wtPath] of registeredPathMap) {
      const session = getSession(sessionId);

      if (session && !TERMINAL_STATUSES.has(session.status)) {
        skipped++;
        continue;
      }

      let branchName: string | undefined;
      try {
        const head = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: wtPath,
          encoding: 'utf8',
        }).trim();
        if (head !== 'HEAD') branchName = head;
      } catch {
        // stale — skip branch detection
      }

      try {
        execSync(`git worktree remove --force "${wtPath}"`, {
          cwd: project.projectDir,
        });

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
          },
        });
      }
    }

    // Phase 2: fs-delete unregistered UUID dirs whose session is terminal or absent
    let entries: string[];
    try {
      entries = fs.readdirSync(worktreesDir);
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      if (!UUID_RE.test(entry)) continue;
      if (registeredSessionIds.has(entry)) continue; // handled in phase 1

      const worktreePath = path.join(worktreesDir, entry);

      try {
        if (!fs.statSync(worktreePath).isDirectory()) continue;
      } catch {
        continue;
      }

      const session = getSession(entry);
      if (session && !TERMINAL_STATUSES.has(session.status)) {
        skipped++;
        continue;
      }

      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
        fsDeleted++;
        console.log(
          `[WorktreeReconciler] fs-deleted orphaned dir for session ${entry.slice(0, 8)} (project ${project.id})`,
        );
      } catch (err) {
        console.error(
          `[WorktreeReconciler] failed to fs-delete orphaned dir ${worktreePath}: ${err}`,
        );
      }
    }

    // Prune stale git metadata
    try {
      execSync('git worktree prune', { cwd: project.projectDir });
    } catch (pruneErr) {
      console.warn(
        `[WorktreeReconciler] git worktree prune failed for project ${project.id}: ${pruneErr}`,
      );
    }
  }

  if (removed > 0 || fsDeleted > 0 || failed > 0) {
    console.log(
      `[WorktreeReconciler] boot sweep complete — removed: ${removed}, fs-deleted: ${fsDeleted}, failed: ${failed}, skipped: ${skipped}`,
    );
  }
}
