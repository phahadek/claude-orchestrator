import fs from 'fs';
import path from 'path';
import { validatePRFiles } from '../github/PRFileValidator';
import { revertBannedFiles } from '../github/PRFileReverter';
import { recordEvent } from '../audit/AuditLog';
import type { GitHubClient } from '../github/GitHubClient';
import { logger } from '../logger';

/** Walk a directory tree collecting all .gitignore files, root-first. */
function collectGitignoreSources(
  rootDir: string,
): Array<{ dir: string; content: string }> {
  const results: Array<{ dir: string; content: string }> = [];
  function walk(dir: string): void {
    const rel = path.relative(rootDir, dir).replace(/\\/g, '/');
    const gitignorePath = path.join(dir, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      try {
        results.push({
          dir: rel,
          content: fs.readFileSync(gitignorePath, 'utf8'),
        });
      } catch {
        // ignore unreadable
      }
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') {
        walk(path.join(dir, e.name));
      }
    }
  }
  walk(rootDir);
  return results;
}

export interface FilePollutionCheckOptions {
  github: GitHubClient;
  worktreePath: string;
  repo: string;
  prNumber: number;
  baseBranch: string;
  sessionId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  /** Called with the list of reverted file paths after a successful revert. */
  onReverted?: (files: string[]) => void;
  /** Register a sync promise so callers can await the revert completing before fetching the diff. */
  registerRevertSync?: (
    prNumber: number,
    repo: string,
    promise: Promise<void>,
  ) => void;
  /**
   * Loop guard: if the PR's current HEAD SHA equals this value, skip the
   * entire check. Used by the push-detected path in AgentSession to avoid
   * re-reverting our own orchestrator-revert commit.
   */
  lastRevertSha?: string | null;
  /** When false, the revert commit omits [skip ci]. Default true. */
  skipCi?: boolean;
}

export interface FilePollutionCheckResult {
  headSha: string | null;
  revertCommitSha: string | null;
}

/**
 * Fetch the PR's changed files, validate for banned/gitignored paths, and
 * revert any violations. Posts a GitHub comment when files are reverted.
 *
 * Used by both AgentSession (push-detected path) and ReviewOrchestrator
 * (post-autofix path) so that HARD_BANNED_FILES stays the single source of
 * truth for what must never appear in a PR diff.
 */
export async function runFilePollutionCheck(
  opts: FilePollutionCheckOptions,
): Promise<FilePollutionCheckResult> {
  const { github, worktreePath, repo, prNumber, baseBranch } = opts;
  const sessionId = opts.sessionId ?? null;
  const projectId = opts.projectId ?? null;
  const taskId = opts.taskId ?? null;

  // Fetch the current head SHA for the loop guard check.
  let headSha: string | null = null;
  try {
    const pr = await github.fetchPR(repo, prNumber);
    headSha = pr.headSha ?? null;
  } catch (e) {
    logger.warn(
      `[filePollutionCheck] could not fetch head SHA for PR #${prNumber}: ${e}`,
    );
  }

  // Loop guard: skip if HEAD equals the last orchestrator-revert SHA.
  if (opts.lastRevertSha && headSha === opts.lastRevertSha) {
    return { headSha, revertCommitSha: null };
  }

  try {
    const changedFiles = await github.getPRFiles(repo, prNumber);
    const gitignoreSources = collectGitignoreSources(worktreePath);
    const validation = validatePRFiles(changedFiles, gitignoreSources);

    // Record that the validator ran — observable even when no violations found.
    recordEvent({
      event_type: 'file_pollution_checked',
      actor_type: 'system',
      actor_id: sessionId,
      project_id: projectId,
      task_id: taskId,
      payload: {
        pr_number: prNumber,
        repo,
        head_sha: headSha,
        banned_files_found: validation.bannedFiles.length,
      },
    });

    if (validation.valid) return { headSha, revertCommitSha: null };

    // Register the sync promise BEFORE starting work so ReviewOrchestrator can await it.
    let resolveSyncPromise!: () => void;
    const syncPromise = new Promise<void>((r) => {
      resolveSyncPromise = r;
    });
    opts.registerRevertSync?.(prNumber, repo, syncPromise);

    let commitSha: string | null = null;
    let reverted: string[] = [];
    try {
      ({ commitSha, reverted } = await revertBannedFiles({
        worktreePath,
        baseBranch,
        bannedFiles: validation.bannedFiles,
        prNumber,
        repo,
        skipCi: opts.skipCi ?? true,
      }));
    } finally {
      resolveSyncPromise();
    }

    if (commitSha === null || reverted.length === 0) {
      return { headSha, revertCommitSha: null };
    }

    opts.onReverted?.(reverted);

    recordEvent({
      event_type: 'file_pollution_reverted',
      actor_type: 'system',
      actor_id: sessionId,
      project_id: projectId,
      task_id: taskId,
      payload: {
        files: reverted,
        pr_number: prNumber,
        commit_sha: commitSha,
      },
    });

    const fileList = reverted.map((f) => `- ${f}`).join('\n');
    void github
      .createIssueComment(
        repo,
        prNumber,
        `🔒 Orchestrator auto-reverted the following files from this PR:\n\n${fileList}`,
      )
      .catch((e) =>
        logger.warn(`[filePollutionCheck] createIssueComment failed: ${e}`),
      );

    return { headSha, revertCommitSha: commitSha };
  } catch (e) {
    logger.warn(`[filePollutionCheck] check failed for PR #${prNumber}: ${e}`);
    recordEvent({
      event_type: 'file_pollution_check_failed',
      actor_type: 'system',
      actor_id: sessionId,
      project_id: projectId,
      task_id: taskId,
      payload: {
        pr_number: prNumber,
        repo,
        head_sha: headSha,
        error: String(e),
      },
    });
    return { headSha, revertCommitSha: null };
  }
}
