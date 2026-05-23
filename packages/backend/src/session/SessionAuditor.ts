import { getTaskBackend } from '../tasks/TaskBackend';
import type { TaskBackend } from '../tasks/TaskBackend';
import { parseSection } from '../notion/NotionClient';
import type { GitHubClient } from '../github/GitHubClient';
import { getPRByNotionTaskId } from '../db/queries';

// ── Public interfaces ────────────────────────────────────────────────────────

export interface SessionAudit {
  sessionId: string;
  prOpened: boolean;
  prTargetsBranch: string | null;
  taskStatusAfter: string | null;
  violations: string[];
  specMismatch: string | null;
  auditedAt: string;
}

/** Minimal interface used to route audit failures back to a live session. */
export interface ISessionManager {
  send(sessionId: string, message: string): void;
}

/** Minimal session shape needed by the auditor — avoids a circular import. */
export interface AuditableSession {
  sessionId: string;
  taskId: string;
  prUrl: string | undefined;
  sessionType: string;
}

// ── SessionAuditor ───────────────────────────────────────────────────────────

export class SessionAuditor {
  /**
   * The first parameter accepts either a TaskBackend (legacy injection — used by
   * tests) or a project id (string). When it is a project id, the backend is
   * resolved per-call via `getTaskBackend(projectId)`. This dual shape preserves
   * the test pattern that pre-existed the per-project routing refactor.
   */
  constructor(
    private notionClientOrProjectId: TaskBackend | string,
    private githubClient?: GitHubClient,
    private sessionManager?: ISessionManager,
  ) {}

  private resolveBackend(): TaskBackend {
    if (typeof this.notionClientOrProjectId === 'string') {
      return getTaskBackend(this.notionClientOrProjectId);
    }
    return this.notionClientOrProjectId;
  }

  /**
   * Run all post-session checks and return a SessionAudit record.
   * Non-blocking: GitHub/Notion failures are caught and skipped, not thrown.
   */
  async audit(
    session: AuditableSession,
    exitCode: number | null,
  ): Promise<SessionAudit> {
    const violations: string[] = [];
    let prTargetsBranch: string | null = null;
    let specMismatch: string | null = null;

    // 1. PR opened on clean exit?
    const prOpened =
      session.prUrl != null ||
      (!!session.taskId && getPRByNotionTaskId(session.taskId) != null);
    if (exitCode === 0 && !prOpened) {
      violations.push('Clean exit but no PR opened');
    }

    if (session.prUrl && this.githubClient) {
      const prMatch = session.prUrl.match(
        /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/,
      );
      if (prMatch) {
        const repo = prMatch[1];
        const prNumber = parseInt(prMatch[2], 10);

        let pr: import('../github/types').PullRequest | null = null;
        try {
          pr = await this.githubClient.fetchPR(repo, prNumber);
        } catch (err) {
          console.warn(
            `[SessionAuditor] GitHub fetchPR failed — skipping PR checks: ${err}`,
          );
        }

        if (pr) {
          // 2. PR targets correct branch (dev)?
          prTargetsBranch = pr.baseBranch;
          if (pr.baseBranch !== 'dev') {
            violations.push(`PR targets ${pr.baseBranch} instead of dev`);
          }

          // 3. PR title format: must start with "feat: "
          if (!pr.title.startsWith('feat: ')) {
            violations.push('PR title does not match format');
          }

          // 4. PR body readable (no escaped newlines)?
          if (pr.body && pr.body.includes('\\n')) {
            violations.push('PR body contains escaped newlines');
          }

          // 5. PR body has required sections?
          const body = pr.body ?? '';
          if (!body.includes('## Summary')) {
            violations.push('PR body missing required section: ## Summary');
          }
          if (
            !body.includes('## Test plan') &&
            !body.includes('## Automated Tests')
          ) {
            violations.push('PR body missing required section: ## Test plan');
          }

          // 6. PR content matches task spec?
          specMismatch = await this.compareToSpec(
            repo,
            prNumber,
            session.taskId,
          );
          if (specMismatch) {
            violations.push(specMismatch);
          }
        }
      }
    }

    const audit: SessionAudit = {
      sessionId: session.sessionId,
      prOpened,
      prTargetsBranch,
      taskStatusAfter: null,
      violations,
      specMismatch,
      auditedAt: new Date().toISOString(),
    };

    if (violations.length > 0) {
      this.routeFailuresToSession(session.sessionId, violations);
    }

    return audit;
  }

  /**
   * Compare the files changed in a PR against the "Files / paths affected"
   * section of the Notion task spec. Returns a summary string if there is a
   * mismatch, or null if everything looks consistent (or if the check cannot
   * be performed).
   */
  private async compareToSpec(
    repo: string,
    prNumber: number,
    taskId: string,
  ): Promise<string | null> {
    if (!this.githubClient || !taskId) return null;

    let diffFiles: string[] = [];
    try {
      const prDiff = await this.githubClient.fetchDiff(prNumber, repo);
      diffFiles = prDiff.filesChanged;
    } catch (err) {
      console.warn(
        `[SessionAuditor] fetchDiff failed — skipping spec comparison: ${err}`,
      );
      return null;
    }

    let taskMarkdown: string | null;
    try {
      taskMarkdown = await this.resolveBackend().fetchTaskPage(taskId);
    } catch (err) {
      console.warn(
        `[SessionAuditor] fetchTaskPage failed — skipping spec comparison: ${err}`,
      );
      return null;
    }

    const filesSection = taskMarkdown
      ? parseSection(taskMarkdown, 'files')
      : '';
    if (!filesSection.trim()) return null;

    // Extract file paths from the filesSection (lines containing slashes or dots)
    const specFiles = filesSection
      .split('\n')
      .map((line) => line.replace(/^[-*\s]+/, '').trim())
      .filter((line) => line.includes('/') || line.includes('.'));

    if (specFiles.length === 0) return null;

    // Files in PR but not in spec
    const unexpected = diffFiles.filter(
      (f) => !specFiles.some((s) => f.includes(s) || s.includes(f)),
    );
    // Files expected by spec but not in PR
    const missing = specFiles.filter(
      (s) => !diffFiles.some((f) => f.includes(s) || s.includes(f)),
    );

    const parts: string[] = [];
    if (unexpected.length > 0) {
      parts.push(
        `PR modifies files not listed in task spec: ${unexpected.join(', ')}`,
      );
    }
    if (missing.length > 0) {
      parts.push(`PR does not touch expected file: ${missing.join(', ')}`);
    }

    return parts.length > 0 ? parts.join('; ') : null;
  }

  private routeFailuresToSession(
    sessionId: string,
    violations: string[],
  ): void {
    if (!this.sessionManager) return;
    const message = [
      'Audit findings for your PR:',
      '',
      ...violations.map((v) => `❌ ${v}`),
      '',
      'Please address these issues and push a fix.',
    ].join('\n');

    try {
      this.sessionManager.send(sessionId, message);
    } catch {
      // Session may have already exited — violations still stored in SQLite
    }
  }
}
