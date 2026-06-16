import path from 'path';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { TaskBackend } from '../tasks/TaskBackend';
import { logger } from '../logger';
import { parseSection } from '../notion/NotionClient';
import type { GitHubClient } from '../github/GitHubClient';
import {
  getPRByNotionTaskId,
  getEventsBySession,
  getDenialsBySession,
} from '../db/queries';
import type { WorktreeEscapeViolation, SessionEvent } from '../db/types';
import { eventKind } from './eventKind';

// ── Public interfaces ────────────────────────────────────────────────────────

export interface SessionAudit {
  sessionId: string;
  prOpened: boolean;
  prTargetsBranch: string | null;
  taskStatusAfter: string | null;
  violations: (string | WorktreeEscapeViolation)[];
  specMismatch: string | null;
  auditedAt: string;
}

/** Minimal interface used to route audit failures back to a live session. */
export interface ISessionManager {
  send(sessionId: string, message: string): void;
  /** Returns true when a live process is running for the given session id. */
  isAlive(sessionId: string): boolean;
  /** Register a Promise that resolves when the post-revert worktree sync completes.
   *  ReviewOrchestrator awaits this before fetching the PR diff for a re-review. */
  registerRevertSync?(
    prNumber: number,
    repo: string,
    syncPromise: Promise<void>,
  ): void;
  /**
   * Single owner of the (DB session status + Notion task status + WS broadcast) trio
   * for non-zero / killed exit paths. All error/killed call sites must go through
   * this method instead of calling updateSessionStatus directly.
   */
  markSessionErrored?(
    sessionId: string,
    status: 'error' | 'killed',
    reason: string,
  ): void;
}

/**
 * Check a single tool-use block for a worktree escape.
 * Used in-flight as tool_use events stream in from the session.
 * Returns a violation if the tool writes outside the worktree, or null if safe.
 */
export function detectInFlightEscape(
  toolName: string,
  toolInput: Record<string, unknown>,
  worktreePath: string,
): WorktreeEscapeViolation | null {
  const block: ToolUseBlock = { name: toolName, input: toolInput };
  const paths = extractPathsFromBlock(block);
  const normalizedWorktree = normalizePath(worktreePath);
  const worktreePrefix = normalizedWorktree.endsWith(path.sep)
    ? normalizedWorktree
    : normalizedWorktree + path.sep;

  for (const p of paths) {
    const resolved = normalizePath(p, worktreePath);
    if (
      resolved !== normalizedWorktree &&
      !resolved.startsWith(worktreePrefix)
    ) {
      return {
        type: 'worktree_escape',
        tool: toolName,
        path: p,
        escapedTo: resolved,
      };
    }
  }
  return null;
}

/** Minimal session shape needed by the auditor — avoids a circular import. */
export interface AuditableSession {
  sessionId: string;
  taskId: string;
  prUrl: string | undefined;
  sessionType: string;
  worktreePath: string | null;
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
    _sessionManager?: ISessionManager,
  ) {}

  private resolveBackend(): TaskBackend {
    if (typeof this.notionClientOrProjectId === 'string') {
      return getTaskBackend(this.notionClientOrProjectId);
    }
    return this.notionClientOrProjectId;
  }

  private resolveBaseBranch(): string {
    if (typeof this.notionClientOrProjectId === 'string') {
      const { getProjectById } =
        require('../config.js') as typeof import('../config');
      return getProjectById(this.notionClientOrProjectId)?.baseBranch ?? 'dev';
    }
    return 'dev';
  }

  /**
   * Run all post-session checks and return a SessionAudit record.
   * Non-blocking: GitHub/Notion failures are caught and skipped, not thrown.
   */
  async audit(
    session: AuditableSession,
    exitCode: number | null,
  ): Promise<SessionAudit> {
    const violations: (string | WorktreeEscapeViolation)[] = [];
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
          logger.warn(
            `[SessionAuditor] GitHub fetchPR failed — skipping PR checks: ${err}`,
          );
        }

        if (pr) {
          // 2. PR targets correct branch?
          prTargetsBranch = pr.baseBranch;
          const expectedBaseBranch = this.resolveBaseBranch();
          if (pr.baseBranch !== expectedBaseBranch) {
            violations.push(
              `PR targets ${pr.baseBranch} instead of ${expectedBaseBranch}`,
            );
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

          // 6. PR content matches task spec? (informational only — not a re-prompt gate)
          specMismatch = await this.compareToSpec(
            repo,
            prNumber,
            session.taskId,
          );
        }
      }
    }

    if (session.worktreePath) {
      try {
        const escapes = await this.auditWorktreeEscape(
          session.sessionId,
          session.worktreePath,
        );
        violations.push(...escapes);
      } catch (err) {
        logger.warn(`[SessionAuditor] auditWorktreeEscape failed: ${err}`);
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

    return audit;
  }

  /**
   * Scan session_events for tool calls that wrote to paths outside the worktree.
   * Checks Write/Edit tool file_path inputs and Bash command write targets.
   * Skips tool calls that were denied (permission_denials) — they never executed.
   */
  async auditWorktreeEscape(
    sessionId: string,
    worktreePath: string,
  ): Promise<WorktreeEscapeViolation[]> {
    const events = getEventsBySession(sessionId);
    const denials = getDenialsBySession(sessionId);
    const deniedIds = new Set(denials.map((d) => d.tool_use_id));

    const violations: WorktreeEscapeViolation[] = [];
    const normalizedWorktree = normalizePath(worktreePath);
    const worktreePrefix = normalizedWorktree.endsWith(path.sep)
      ? normalizedWorktree
      : normalizedWorktree + path.sep;

    for (const event of events) {
      const blocks = extractToolUseBlocks(event);
      for (const block of blocks) {
        if (block.id && deniedIds.has(block.id)) continue;
        const paths = extractPathsFromBlock(block);
        for (const p of paths) {
          const resolved = normalizePath(p, worktreePath);
          if (
            resolved !== normalizedWorktree &&
            !resolved.startsWith(worktreePrefix)
          ) {
            violations.push({
              type: 'worktree_escape',
              tool: block.name,
              path: p,
              escapedTo: resolved,
            });
          }
        }
      }
    }

    return violations;
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
      logger.warn(
        `[SessionAuditor] fetchDiff failed — skipping spec comparison: ${err}`,
      );
      return null;
    }

    let taskMarkdown: string | null;
    try {
      taskMarkdown = await this.resolveBackend().fetchTaskPage(taskId);
    } catch (err) {
      logger.warn(
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
}

// ── Private helpers ──────────────────────────────────────────────────────────

interface ToolUseBlock {
  name: string;
  input: Record<string, unknown>;
  id?: string;
}

/** Extract all tool_use blocks from a session event payload. */
function extractToolUseBlocks(event: SessionEvent): ToolUseBlock[] {
  const blocks: ToolUseBlock[] = [];
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(event.payload) as Record<string, unknown>;
  } catch {
    return blocks;
  }

  if (eventKind(event) === 'tool_use') {
    const name = payload.name as string | undefined;
    const id = payload.id as string | undefined;
    const input = (payload.input ?? {}) as Record<string, unknown>;
    if (name) blocks.push({ name, input, id });
  } else if (eventKind(event) === 'text') {
    const message = payload.message as Record<string, unknown> | undefined;
    const content = message?.content as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          blocks.push({
            name: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
            id: block.id as string | undefined,
          });
        }
      }
    }
  }

  return blocks;
}

/** Extract absolute file paths that should be checked for worktree escape. */
function extractPathsFromBlock(block: ToolUseBlock): string[] {
  const { name, input } = block;
  if (name === 'Write' || name === 'Edit') {
    const filePath = input.file_path as string | undefined;
    return filePath ? [filePath] : [];
  }
  if (name === 'Bash') {
    const command = input.command as string | undefined;
    return command ? extractWriteTargetsFromCommand(command) : [];
  }
  return [];
}

/**
 * Extract only actual write targets from a shell command string.
 * Handles output redirects (>/>>), tee, and cp/mv destinations.
 * URLs are stripped first to prevent https:// fragments matching as paths.
 */
function extractWriteTargetsFromCommand(command: string): string[] {
  const stripped = command.replace(/https?:\/\/[^\s"'`;\n]*/gi, '');
  const targets: string[] = [];

  // Output redirects: > path or >> path
  for (const match of stripped.matchAll(/>>?\s*([^\s"'`;\n|&]+)/g)) {
    targets.push(match[1]);
  }
  // tee destinations: tee [-flags] path
  for (const match of stripped.matchAll(
    // eslint-disable-next-line security/detect-unsafe-regex -- Reason: verified non-backtracking; (?:-\S+\s+)* has non-overlapping char classes (non-whitespace then whitespace), no catastrophic path exists.
    /\btee\s+(?:-\S+\s+)*([^\s"'`;\n|&]+)/g,
  )) {
    targets.push(match[1]);
  }
  // cp/mv destinations: cp/mv [-flags] src dest
  for (const match of stripped.matchAll(
    // eslint-disable-next-line security/detect-unsafe-regex -- Reason: verified non-backtracking; (?:-\S+\s+)* alternates non-whitespace+whitespace with no overlap; anchored by \b and trailing \s+.
    /\b(?:cp|mv)\s+(?:-\S+\s+)*\S+\s+([^\s"'`;\n|&]+)/g,
  )) {
    targets.push(match[1]);
  }

  // /dev/null (and other null sinks) are not real write targets.
  return targets.filter((t) => t !== '/dev/null');
}

/**
 * Normalize a path to a canonical absolute form for comparison.
 * Converts Git-Bash /c/... paths to Windows C:\... on Windows hosts.
 * When baseDir is provided, drive-rootless absolute paths (e.g. /Users/foo)
 * inherit the drive letter from baseDir via path.resolve, preventing false-positive
 * worktree_escape violations when the Claude CLI reports Unix-style paths on Windows.
 */
function normalizePath(p: string, baseDir?: string): string {
  // Git-Bash /c/foo → C:\foo. Must precede path.resolve, which would otherwise
  // mangle the single-letter drive segment into a literal \c\ component.
  const gitBashMatch = /^\/([a-zA-Z])\//i.exec(p);
  if (gitBashMatch) {
    p = `${gitBashMatch[1].toUpperCase()}:\\${p.slice(3)}`;
  }
  return baseDir ? path.resolve(baseDir, p) : path.normalize(p);
}
