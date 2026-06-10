import path from 'path';
import fs from 'fs';
import { execSync, exec as execCb } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';

const exec = promisify(execCb);
import { recordEvent } from '../audit/AuditLog';
import { scrubSecrets } from '../security/scrubSecrets';
import { AgentSession, parseNotionPageIdDashed } from './AgentSession';
import { formatTaskId } from '../tasks/taskId';
import { buildSessionContext } from './ContextBuilder';
import { buildReviewClaudeMd } from './orchestrator-claudemd';
import {
  resolveStartingPoint,
  ensureMilestoneBranch,
  deriveBranchSlug,
} from './branchModel';
import { loadOrchestratorConfig } from './orchestrator-config';
import { WorktreeSetupError } from './WorktreeSetupError';
import { CliSessionRunner } from './CliSessionRunner';
import { ApiSessionRunner } from './ApiSessionRunner';
import type { ISessionRunner } from './SessionRunner';
import {
  DockerSessionRunner,
  reapOrphanContainers,
} from './DockerSessionRunner';
import { getCorporateMode } from '../config/corporateMode';
import {
  config,
  getProjectById,
  normalizePath,
  runtimeSettings,
} from '../config';
import {
  insertSession,
  updateSessionStatus,
  updateSessionWorktreePath,
  markSessionDone,
  markSessionSuperseded,
  insertEvent,
  getSession,
  getSessionsByStatus,
  getPRByNotionTaskId,
  getEventsBySession,
  getPRByNumber,
  getPRBySessionId,
  getStuckResultSessionRows,
  getRunningSessionsWithMergedOrClosedPR,
  hasActiveSessionForTask,
  getOtherRunningSessionsForTask,
  setSessionPauseReason,
  setSessionLastErrorDetail,
  incrementTaskCrashCount,
  setTaskPauseReason,
} from '../db/queries';
import { recoverSession } from './sessionRecovery';
import { eventKind } from './eventKind';
import type { Session } from '../db/types';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { GitHubClient } from '../github/GitHubClient';
import type { ServerMessage } from '../ws/types';
import { deriveDisplayStatusFromDb } from '../tasks/TaskStatusEngine';
import type { DisplayStatus } from '../tasks/TaskStatusEngine';
import { emitTaskUpdated } from '../routes/tasks';
import { parseSection } from '../notion/NotionClient';
import {
  formatReviewFeedback,
  formatApprovedVerdictMessage,
} from '../github/reviewUtils';
import type { PRReviewResult } from '../github/PRReviewService';

/**
 * Derive a prefixed task ID from a task URL, using the project's task source
 * to determine the format.
 * - notion: formatTaskId('notion', parseNotionPageIdDashed(url)) — existing logic
 * - github: extracts issue number from https://github.com/.../issues/<N>
 * - other sources: fall back to notion parsing (safe for YAML/Jira which pass
 *   explicit taskId via StartOptions.taskId anyway)
 */
export function deriveTaskId(taskSource: string, taskUrl: string): string {
  if (taskSource === 'github') {
    const m = taskUrl.match(/\/issues\/(\d+)/);
    if (m) return formatTaskId('github', m[1]);
    // URL not parseable — store the raw URL under github prefix so lookups still work
    return formatTaskId('github', taskUrl);
  }
  return formatTaskId('notion', parseNotionPageIdDashed(taskUrl));
}

/** Max chars per file snippet to avoid bloating the CLAUDE.md. */
const MAX_FILE_CHARS = 8_000;
/** Max total chars for all file snippets combined. */
const MAX_TOTAL_SNIPPET_CHARS = 40_000;

/**
 * Parse file paths from the task spec's "Files" section, read each file from
 * the project directory, and return a markdown block with their contents.
 * Returns undefined if no files are found or all reads fail.
 */
function readTaskFiles(
  taskMarkdown: string,
  projectDir: string,
): string | undefined {
  const filesSection = parseSection(taskMarkdown, 'files');
  if (!filesSection.trim()) return undefined;

  const filePaths = filesSection
    .split('\n')
    .map((line) => line.replace(/^[-*\s]+/, '').trim())
    // Strip backticks, trailing descriptions, and markdown formatting like *(new)*
    .map((line) =>
      line
        .replace(/`/g, '') // remove backticks
        .replace(/\s+\*?\(.*?\)\*?\s*$/, '') // remove *(new)*, (update), etc.
        .replace(/\s+[-—–].*$/, '') // remove "— description" suffixes
        .trim(),
    )
    .filter(
      (line) => line.length > 0 && (line.includes('/') || line.includes('.')),
    );

  if (filePaths.length === 0) return undefined;

  const snippets: string[] = [];
  let totalChars = 0;

  for (const filePath of filePaths) {
    if (totalChars >= MAX_TOTAL_SNIPPET_CHARS) break;

    const fullPath = path.join(projectDir, filePath);
    try {
      if (!fs.existsSync(fullPath)) continue;
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;

      let content = fs.readFileSync(fullPath, 'utf-8');
      if (content.length > MAX_FILE_CHARS) {
        content = content.slice(0, MAX_FILE_CHARS) + '\n[... truncated]';
      }

      snippets.push(`### \`${filePath}\`\n\`\`\`\n${content}\n\`\`\``);
      totalChars += content.length;
    } catch {
      // Skip unreadable files silently
    }
  }

  if (snippets.length === 0) return undefined;

  return (
    `## Referenced Files\n\n` +
    `> These are the current contents of files listed in the task spec.\n` +
    `> They were pre-read by the orchestrator so you can skip exploration.\n\n` +
    snippets.join('\n\n')
  );
}

/**
 * Write a per-session MCP config file to `<worktreePath>/.claude/orchestrator-mcp.json`
 * and return its absolute path. Returns undefined if mcpServers is empty/undefined.
 * Exported for unit testing.
 */
export function writeMcpConfig(
  worktreePath: string,
  mcpServers: Record<string, unknown> | undefined,
): string | undefined {
  if (!mcpServers || Object.keys(mcpServers).length === 0) return undefined;
  const dir = path.join(worktreePath, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'orchestrator-mcp.json');
  fs.writeFileSync(filePath, JSON.stringify({ mcpServers }, null, 2), 'utf-8');
  return filePath;
}

export interface StartOptions {
  taskType?: string;
  sessionType?: 'standard' | 'review';
  customPrompt?: string;
  projectId?: string;
  taskName?: string;
  /** Pre-generated session ID. If omitted, a new UUID is generated internally. */
  sessionId?: string;
  /** Milestone row id used for starting-point resolution in two_tier branch mode. */
  milestoneId?: string | null;
  /** Whether this is a milestone task or a non-milestone task; recorded in the audit log. */
  taskKind?: 'milestone' | 'non_milestone';
  /**
   * Pre-computed task ID in `source:externalId` format (e.g. `github:123`, `notion:<uuid>`).
   * When provided, bypasses URL-based task ID derivation so callers with an already-formatted
   * ID (AutoLauncher, PRReviewService) don't double-parse via Notion-specific logic.
   */
  taskId?: string;
}

/** How long to suppress lastMessage-only task_updated broadcasts per task (ms). */
const LAST_MESSAGE_THROTTLE_MS = 3_000;

const TERMINAL_STATUSES = new Set(['done', 'error', 'killed', 'superseded']);
const ALWAYS_GUARDED_BRANCHES = new Set(['dev', 'main']);

/**
 * Error causes that are operator-intentional and should NOT count against the
 * crash budget (user explicitly killed the session or the PR was closed).
 * All other causes increment the per-task consecutive crash counter; reaching
 * 2+ consecutive counted failures → 🚫 Blocked (circuit breaker).
 */
const UNCOUNTED_REASONS = new Set(['user_kill', 'pr_closed']);

/**
 * Delete the local session/<sessionId> branch if it exists and conditions are met:
 * session row is terminal (done/error/killed) AND (no pr_url OR PR is merged/closed).
 * Dev/main are always guarded. Missing branch is a silent no-op.
 * Exported for backfill tests.
 */
export function pruneSessionBranch(
  sessionId: string,
  projectDir: string,
): void {
  const branchName = `session/${sessionId}`;

  // Safety guard: never delete dev or main (defense-in-depth)
  if (
    ALWAYS_GUARDED_BRANCHES.has(branchName) ||
    ALWAYS_GUARDED_BRANCHES.has(sessionId)
  )
    return;

  // Silent no-op if the branch doesn't exist
  try {
    execSync(`git rev-parse --verify "${branchName}"`, {
      cwd: projectDir,
      stdio: 'pipe',
    });
  } catch {
    return;
  }

  // Gate: session row must be in a terminal status
  const row = getSession(sessionId);
  if (!row || !TERMINAL_STATUSES.has(row.status)) return;

  // Gate: no pr_url → safe to delete; pr_url → only delete when PR is merged/closed
  if (row.pr_url) {
    const prRow = getPRBySessionId(sessionId);
    if (!prRow || prRow.state === 'open') return;
  }

  try {
    execSync(`git branch -D "${branchName}"`, { cwd: projectDir });
    console.log(
      `[SessionManager] pruned ${branchName} (session ${sessionId.slice(0, 8)})`,
    );
  } catch (err) {
    console.error(`[SessionManager] failed to prune ${branchName}: ${err}`);
  }
}

/**
 * Continuation nudge sent to a resumed session after its first CLI event.
 * Exported so tests can verify the exact message without hardcoding it.
 */
export const RESUME_NUDGE_MESSAGE =
  'Continue implementing the task. Check git status and your todo list to see where you left off.';

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, AgentSession>();
  private pendingStarts = new Map<
    string,
    { sessionType: 'standard' | 'review' }
  >();
  /** Concurrency guard: prevents double-spawning when two concurrent sendOrResume calls race. */
  private resumesInFlight = new Map<string, Promise<string>>();

  /** Last known DisplayStatus per taskId — used to skip no-op broadcasts. */
  private _lastDisplayStatus = new Map<string, DisplayStatus>();
  /** Timestamp of last lastMessage-only task_updated per taskId. */
  private _lastMessageThrottle = new Map<string, number>();
  /** Guards against re-entrant task_updated emission inside the emit override. */
  private _inTaskUpdate = false;
  /** Session IDs whose local branch should be deleted on worktree cleanup (merged PRs). */
  private _mergedSessionIds = new Set<string>();

  constructor(private readonly githubClient?: GitHubClient) {
    super();
  }

  /**
   * Override emit to intercept `message` events and emit `task_updated` whenever a
   * message could change a task's derived display status. Guards against re-entrant
   * calls so the task_updated broadcast itself never triggers another one.
   */
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    let emitArgs = args;
    if (event === 'message') {
      const msg = args[0] as ServerMessage;
      if (msg.type === 'session_event' && typeof msg.content === 'string') {
        const scrubbed = scrubSecrets(msg.content);
        if (scrubbed !== msg.content) {
          emitArgs = [{ ...msg, content: scrubbed }, ...args.slice(1)];
        }
      }
    }
    const result = super.emit(event, ...emitArgs);
    if (event === 'message' && !this._inTaskUpdate) {
      this._inTaskUpdate = true;
      try {
        this._handleTaskUpdated(emitArgs[0] as ServerMessage);
      } catch (err) {
        console.error('[SessionManager] task_updated handler error:', err);
      } finally {
        this._inTaskUpdate = false;
      }
    }
    return result;
  }

  /**
   * Inspect an outgoing ServerMessage and, if it could change a task's derived
   * display status, re-derive and broadcast task_updated (de-duped by last known status).
   */
  private _handleTaskUpdated(msg: ServerMessage): void {
    const taskId = this._taskIdForMessage(msg);
    if (!taskId) return;

    const isLastMessageOnly = msg.type === 'session_event';

    if (isLastMessageOnly) {
      const last = this._lastMessageThrottle.get(taskId) ?? 0;
      const now = Date.now();
      if (now - last < LAST_MESSAGE_THROTTLE_MS) return;
      this._lastMessageThrottle.set(taskId, now);
    }

    const displayStatus = deriveDisplayStatusFromDb(taskId);
    const prev = this._lastDisplayStatus.get(taskId);

    if (!isLastMessageOnly && displayStatus === prev) return;
    if (isLastMessageOnly && displayStatus === prev) {
      // lastMessage-only and status unchanged — skip entirely (throttle already passed,
      // but there's nothing interesting to send)
      return;
    }

    this._lastDisplayStatus.set(taskId, displayStatus);
    emitTaskUpdated(taskId);
  }

  /**
   * Determine the task ID affected by a ServerMessage, if any.
   * Returns null for messages that cannot change task display status.
   */
  private _taskIdForMessage(msg: ServerMessage): string | null {
    switch (msg.type) {
      case 'session_starting':
      case 'session_started':
      case 'session_ended':
      case 'session_status':
      case 'session_event':
      case 'pr_created': {
        const sessionId = (msg as { sessionId: string }).sessionId;
        const row = getSession(sessionId);
        return row?.task_id ?? null;
      }
      case 'pr_review_complete':
      case 'review_verdict': {
        const { prNumber, repo } = msg as { prNumber: number; repo: string };
        const prRow = getPRByNumber(prNumber, repo);
        return prRow?.task_id ?? null;
      }
      case 'pr_merged':
      case 'pr_closed': {
        const { prNumber, repo } = msg as { prNumber: number; repo: string };
        const prRow = getPRByNumber(prNumber, repo);
        return prRow?.task_id ?? null;
      }
      default:
        return null;
    }
  }

  /**
   * Single owner of the (DB session status + Notion task status + WS broadcast) trio
   * for non-zero / killed exit paths. All call sites that previously called
   * updateSessionStatus(..., 'error'|'killed', ...) must go through this method.
   *
   * - Updates sessions.status and ended_at in the DB.
   * - Sets hasEnded on the in-memory AgentSession if still live.
   * - Emits session_ended WS broadcast.
   * - Records an audit_log event capturing the cause.
   * - For standard sessions with a task_id, updates the Notion task status:
   *   BLOCKED_REASONS causes use a crash budget: crash #1 → 🗂️ Ready (retryable),
   *   crash #2+ consecutive → 🚫 Blocked (circuit breaker). All other causes → 🗂️ Ready.
   * - Notion failures are logged but never re-thrown (matches handleCleanExit pattern).
   */
  markSessionErrored(
    sessionId: string,
    status: 'error' | 'killed',
    reason: string,
  ): void {
    const endedAt = Date.now();

    // 1. Update DB status and ended_at
    updateSessionStatus(sessionId, status, endedAt);

    // 2. Set hasEnded on live in-memory session to prevent double-broadcasts
    const liveSession = this.sessions.get(sessionId);
    if (liveSession) {
      liveSession.hasEnded = true;
    } else {
      // Session not live (already idle) — explicitly finalize the worktree now
      // that a terminal event has fired (e.g. PR closed).
      this._teardownIdleSessionWorktree(sessionId);
    }

    // 3. Look up session row for taskId (already written by step 1)
    const row = getSession(sessionId);
    const taskId = row?.task_id ?? undefined;

    // 4. Emit session_ended WS broadcast
    this.emit('message', {
      type: 'session_ended',
      sessionId,
      status,
      ...(taskId && { taskId }),
    } satisfies ServerMessage);

    // 5. Record audit_log event capturing the cause
    recordEvent({
      event_type: 'session_errored',
      actor_type: 'system',
      actor_id: sessionId,
      project_id: null,
      task_id: null,
      payload: { sessionId, status, reason },
    });

    // 7. Update Notion task status for standard sessions
    if (!row || row.session_type !== 'standard' || !row.task_id) return;

    const notionTaskId = row.task_id;
    const projectId = row.project_id ?? '';

    let notionStatus: string;
    if (!UNCOUNTED_REASONS.has(reason)) {
      const crashCount = incrementTaskCrashCount(notionTaskId);
      if (crashCount >= 2) {
        notionStatus = '🚫 Blocked';
        // Persist the block so AutoLauncher skips this task across restarts.
        setTaskPauseReason(notionTaskId, 'launch_failed', reason);
        // Emit audit + broadcast so the dashboard reflects the block immediately.
        recordEvent({
          event_type: 'auto_launch_paused',
          actor_type: 'system',
          actor_id: sessionId,
          project_id: projectId || null,
          task_id: notionTaskId,
          payload: { reason, sessionId, crashCount },
        });
        this.emit('message', {
          type: 'auto_launch_paused',
          taskId: notionTaskId,
          reason: 'launch_failed',
          detail: reason,
        } satisfies ServerMessage);
      } else {
        notionStatus = '🗂️ Ready';
      }
    } else {
      notionStatus = '🗂️ Ready';
    }

    // Update Notion task status (fire-and-forget; failures logged, not thrown)
    getTaskBackend(projectId)
      .updateStatus(notionTaskId, notionStatus, {
        source: 'orchestrator',
        sessionId,
      })
      .then(() => {
        this.emit('message', {
          type: 'task_status_changed',
          notionTaskId,
          newStatus: notionStatus,
        } satisfies ServerMessage);
        emitTaskUpdated(notionTaskId);
      })
      .catch((e) =>
        console.error(
          `[SessionManager] markSessionErrored updateStatus failed: ${e}`,
        ),
      );
  }

  async start(
    taskUrl: string,
    projectContextUrl: string,
    options?: StartOptions,
  ): Promise<string> {
    const {
      taskType,
      sessionType = 'standard',
      projectId = '',
      taskName,
      sessionId: providedSessionId,
      taskKind,
      taskId: precomputedTaskId,
    } = options ?? {};

    if (sessionType !== 'review' && taskKind === undefined) {
      throw new Error(
        `sessionManager.start() requires taskKind for standard sessions`,
      );
    }

    if (sessionType !== 'review') {
      const codeSessionCount = [...this.sessions.values()].filter(
        (s) => s.sessionType !== 'review',
      ).length;
      if (codeSessionCount >= config.maxConcurrentCodeSessions) {
        throw new Error(
          `Max concurrent code sessions (${config.maxConcurrentCodeSessions}) reached`,
        );
      }
    }

    const project = getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const corporateMode = getCorporateMode();
    if (corporateMode.gates.requireZDR && !project.dataResidencyConfirmed) {
      recordEvent({
        event_type: 'session_launch_refused_zdr',
        actor_type: 'system',
        project_id: projectId,
        payload: {
          projectId,
          reason:
            'data_residency_confirmed is false; corporate mode requireZDR gate blocked session launch',
        },
      });
      throw new Error(
        `Session launch refused: project "${project.name}" has not confirmed Zero Data Retention (ZDR). ` +
          `Enable the Data Residency attestation in project Settings before launching sessions in corporate mode.`,
      );
    }

    // Dedup: if a live or DB-active session already exists for this task, return early.
    // This lifts the AutoLauncher guard into SessionManager so every caller benefits.
    if (sessionType !== 'review') {
      const earlyTaskId =
        precomputedTaskId ??
        deriveTaskId(project.taskSource ?? 'notion', taskUrl);
      if (
        this.hasLiveSessionForTask(earlyTaskId) ||
        hasActiveSessionForTask(earlyTaskId)
      ) {
        const existing = [...this.sessions.values()].find((s) => {
          const tid = s.taskId?.replace(/-/g, '');
          return tid && tid === earlyTaskId.replace(/-/g, '');
        });
        throw Object.assign(
          new Error(`Session already running for task ${earlyTaskId}`),
          { alreadyRunning: true, sessionId: existing?.sessionId ?? '' },
        );
      }
    }

    const sessionId = providedSessionId ?? crypto.randomUUID();
    const projectDir = normalizePath(project.projectDir);
    const worktreePath = path.join(
      projectDir,
      '.claude',
      'worktrees',
      sessionId,
    );
    const sessionTaskId =
      precomputedTaskId ??
      deriveTaskId(project.taskSource ?? 'notion', taskUrl);

    console.log(
      `[SessionManager] start ${sessionId} project=${projectId} sessionType=${sessionType}`,
    );

    // Insert session into SQLite before firing background chain so FK constraints
    // on session_events are never violated.
    const startedAt = Date.now();
    insertSession({
      session_id: sessionId,
      task_id: sessionTaskId,
      task_url: taskUrl,
      project_context_url: projectContextUrl,
      project_id: projectId,
      status: 'starting',
      started_at: startedAt,
      ended_at: null,
      pr_url: null,
      worktree_path: worktreePath,
      session_type: sessionType,
      task_name: taskName ?? null,
    });

    recordEvent({
      event_type: 'session_launched',
      actor_type: 'ai',
      actor_id: sessionId,
      project_id: projectId || null,
      task_id: sessionTaskId || null,
      payload: {
        session_type: sessionType,
        task_url: taskUrl,
        task_kind: taskKind,
      },
    });

    this.pendingStarts.set(sessionId, { sessionType });

    // Look up the PR for review sessions so the card can display "Review of #N".
    const reviewPr =
      sessionType === 'review' && sessionTaskId
        ? (getPRByNotionTaskId(sessionTaskId) ?? undefined)
        : undefined;
    const reviewPrNumber = reviewPr?.pr_number;
    const reviewCodeSessionId = reviewPr?.session_id ?? undefined;

    // Broadcast session_starting immediately — caller-observed completion is ~50ms.
    this.emit('message', {
      type: 'session_starting',
      sessionId,
      taskName: taskName ?? taskUrl,
      notionTaskUrl: taskUrl,
      ...(taskType != null && { taskType }),
      ...(sessionType !== 'standard' && { sessionType }),
      ...(reviewPrNumber != null && { prNumber: reviewPrNumber }),
      ...(reviewCodeSessionId != null && {
        codeSessionId: reviewCodeSessionId,
      }),
      started_at: startedAt,
      project_id: projectId,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      ...(sessionTaskId && { taskId: sessionTaskId }),
    } satisfies ServerMessage);

    // Fire-and-forget the heavy chain (git fetch → worktree add → bootstrap → spawn).
    // Caller-observed start() completion time is <100ms for the common case.
    void this.completeStart(
      sessionId,
      taskUrl,
      projectContextUrl,
      options ?? {},
      startedAt,
    ).catch(async (err) => {
      this.pendingStarts.delete(sessionId);
      console.error(
        `[SessionManager] completeStart failed for ${sessionId}:`,
        err,
      );
      const errorDetail = err instanceof Error ? err.message : String(err);
      // Persist the error context so review-verdict construction can surface the
      // real cause instead of the generic "no output to parse" fallback.
      try {
        setSessionPauseReason(sessionId, 'launch_failed');
        setSessionLastErrorDetail(sessionId, errorDetail);
      } catch {
        // Best-effort — DB may be unavailable or mocked without these functions.
      }
      await this.cleanupPartialWorktree(sessionId);
      this.markSessionErrored(sessionId, 'error', 'launch_failed');
      this.emit('message', {
        type: 'error',
        message: `Session launch failed: ${errorDetail}`,
      } satisfies ServerMessage);
    });

    return sessionId;
  }

  /**
   * Background chain: git fetch → worktree add → bootstrap → spawn runner.
   * Dispatched fire-and-forget from start(). Broadcasts session_started on success.
   * On failure, the catch handler in start() calls cleanupPartialWorktree + markSessionErrored.
   */
  private async completeStart(
    sessionId: string,
    taskUrl: string,
    projectContextUrl: string,
    options: StartOptions,
    startedAt: number,
  ): Promise<void> {
    const {
      taskType,
      sessionType = 'standard',
      customPrompt,
      projectId = '',
      taskName,
      milestoneId = null,
      taskId: precomputedTaskId,
    } = options;

    const project = getProjectById(projectId)!;
    const projectDir = normalizePath(project.projectDir);
    const worktreePath = path.join(
      projectDir,
      '.claude',
      'worktrees',
      sessionId,
    );
    const isLocalOnly = project.gitMode === 'local-only';
    const { startingPoint, milestoneSlug } = resolveStartingPoint(
      project,
      milestoneId,
    );
    const sessionTaskId =
      precomputedTaskId ??
      deriveTaskId(project.taskSource ?? 'notion', taskUrl);

    if (!isLocalOnly) {
      if (milestoneSlug) {
        try {
          ensureMilestoneBranch(milestoneSlug, projectDir, project.baseBranch);
        } catch (err) {
          console.warn(
            `[SessionManager] ensureMilestoneBranch failed (continuing): ${err}`,
          );
        }
      } else {
        try {
          await exec(`git fetch origin ${project.baseBranch}`, {
            cwd: projectDir,
            timeout: 30_000,
          });
        } catch (err) {
          console.warn(
            `[SessionManager] git fetch origin ${project.baseBranch} failed (continuing with local ref): ${err}`,
          );
        }
      }
    }

    const worktreeBase =
      isLocalOnly || startingPoint !== project.baseBranch
        ? startingPoint
        : `origin/${project.baseBranch}`;

    const featureBranch = taskName ? deriveBranchSlug(taskName) : null;
    if (featureBranch) {
      try {
        await exec(
          `git worktree add -b "${featureBranch}" "${worktreePath}" ${worktreeBase}`,
          { cwd: projectDir },
        );
      } catch (err) {
        const e = err as { stderr?: string | Buffer; message: string };
        const stderr = e.stderr ? e.stderr.toString() : '';
        const isBranchAlreadyExists = /A branch named .* already exists/.test(
          stderr,
        );

        if (isBranchAlreadyExists && getPRByNotionTaskId(sessionTaskId)) {
          // Branch carries PR commits; prune stale worktree registration and reattach.
          try {
            execSync(`git worktree prune`, { cwd: projectDir });
          } catch (pruneErr) {
            console.warn(
              `[SessionManager] completeStart: git worktree prune failed (continuing): ${pruneErr}`,
            );
          }
          try {
            await exec(
              `git worktree add "${worktreePath}" "${featureBranch}"`,
              { cwd: projectDir },
            );
          } catch (reattachErr) {
            const re = reattachErr as {
              stderr?: string | Buffer;
              message: string;
            };
            const reattachStderr = re.stderr ? re.stderr.toString() : '';
            const fullMsg =
              `${re.message}${reattachStderr ? `\nstderr: ${reattachStderr}` : ''}`.trim();
            console.error(
              `[SessionManager] failed to reattach worktree for ${sessionId}: ${fullMsg}`,
            );
            throw new WorktreeSetupError(fullMsg, {
              isBranchAlreadyExists: true,
            });
          }
        } else {
          const fullMsg =
            `${e.message}${stderr ? `\nstderr: ${stderr}` : ''}`.trim();
          console.error(
            `[SessionManager] failed to create worktree for ${sessionId}: ${fullMsg}`,
          );
          throw new WorktreeSetupError(fullMsg, { isBranchAlreadyExists });
        }
      }
    } else {
      try {
        await exec(
          `git worktree add --detach "${worktreePath}" ${worktreeBase}`,
          { cwd: projectDir },
        );
      } catch (err) {
        const e = err as { stderr?: string | Buffer; message: string };
        const stderr = e.stderr ? e.stderr.toString() : '';
        const fullMsg =
          `${e.message}${stderr ? `\nstderr: ${stderr}` : ''}`.trim();
        console.error(
          `[SessionManager] failed to create worktree for ${sessionId}: ${fullMsg}`,
        );
        throw new WorktreeSetupError(fullMsg, { isBranchAlreadyExists: false });
      }
    }

    const isUnixStylePath =
      worktreePath.startsWith('/c/') || worktreePath.startsWith('/C/');
    console.log(
      `[SessionManager] worktree created: path=${worktreePath} startingPoint=${startingPoint}` +
        (isUnixStylePath
          ? ' [WARNING: Unix-style path detected — may not resolve correctly on Windows]'
          : ''),
    );

    const orchConfig = loadOrchestratorConfig(projectDir);

    if (orchConfig.bootstrap_script) {
      try {
        await exec(`bash ${orchConfig.bootstrap_script} "${worktreePath}"`, {
          cwd: projectDir,
          timeout: 120_000,
        });
        console.log(
          `[SessionManager] bootstrap script completed for ${sessionId.slice(0, 8)}`,
        );
      } catch (err) {
        console.warn(
          `[SessionManager] bootstrap script failed for ${sessionId.slice(0, 8)} (continuing): ${err}`,
        );
      }
    }

    const sessionMode = runtimeSettings.session_mode;
    const runner =
      sessionMode === 'api'
        ? new ApiSessionRunner(sessionId)
        : getCorporateMode().gates.dockerMandatory
          ? new DockerSessionRunner(sessionId)
          : new CliSessionRunner(sessionId);

    let taskContent: string | undefined;
    if (sessionType !== 'review' && sessionTaskId) {
      try {
        taskContent =
          await getTaskBackend(projectId).fetchTaskPage(sessionTaskId);
        console.log(
          `[SessionManager] pre-fetched task content for ${sessionId.slice(0, 8)} (${taskContent.length} chars)`,
        );
      } catch (err) {
        console.warn(
          `[SessionManager] failed to pre-fetch task content for ${sessionId.slice(0, 8)} — session will fetch from task backend: ${err}`,
        );
      }
    }

    if (taskContent) {
      try {
        const fileSnippets = readTaskFiles(taskContent, projectDir);
        if (fileSnippets) {
          taskContent += '\n\n' + fileSnippets;
          console.log(
            `[SessionManager] appended file snippets for ${sessionId.slice(0, 8)}`,
          );
        }
      } catch (err) {
        console.warn(
          `[SessionManager] failed to read task files for ${sessionId.slice(0, 8)}: ${err}`,
        );
      }
    }

    let sessionContextContent: string | undefined;
    if (sessionType === 'review') {
      sessionContextContent = buildReviewClaudeMd(taskName ?? taskUrl);
    } else {
      try {
        sessionContextContent = buildSessionContext({
          taskName: taskName ?? taskUrl,
          taskUrl,
          projectContextUrl,
          targetBranch: startingPoint,
          projectDir,
          worktreePath,
          verify: orchConfig.verify.length > 0 ? orchConfig.verify : undefined,
          bashRules:
            orchConfig.bash_rules.length > 0
              ? orchConfig.bash_rules
              : undefined,
          taskBackend:
            project.taskSource === 'yaml'
              ? 'local'
              : project.taskSource === 'github'
                ? 'github'
                : 'notion',
          taskContent,
          gitMode: project.gitMode,
        });
      } catch (err) {
        console.error(
          `[SessionManager] failed to build session context for ${sessionId}: ${err}`,
        );
      }
    }

    const mcpConfigPath = writeMcpConfig(worktreePath, orchConfig.mcp_servers);
    if (mcpConfigPath) {
      console.log(
        `[SessionManager] wrote MCP config to ${mcpConfigPath} for ${sessionId.slice(0, 8)}`,
      );
    }

    const session = new AgentSession(
      sessionId,
      taskUrl,
      projectContextUrl,
      undefined,
      worktreePath,
      sessionTaskId,
      undefined,
      customPrompt,
      sessionType,
      this,
      this.githubClient,
      orchConfig.allowed_tools,
      sessionMode === 'api' ? sessionContextContent : undefined,
      runner,
      projectId,
      mcpConfigPath,
    );

    if (sessionMode === 'cli' && sessionContextContent) {
      session.injectContextFile('CLAUDE.md', sessionContextContent);
      console.log(
        `[SessionManager] orchestrator CLAUDE.md written to worktree for ${sessionId.slice(0, 8)}`,
      );
    }

    this.pendingStarts.delete(sessionId);
    this.sessions.set(sessionId, session);
    this.wireSession(sessionId, session, projectDir, worktreePath);

    // Update task status to In Progress (fire-and-forget; failures logged, not thrown).
    if (sessionType === 'standard') {
      getTaskBackend(projectId)
        .updateStatus(sessionTaskId, '🔄 In Progress', {
          source: 'orchestrator',
          sessionId,
        })
        .then(() => {
          this.emit('message', {
            type: 'task_status_changed',
            notionTaskId: sessionTaskId,
            newStatus: '🔄 In Progress',
          } satisfies ServerMessage);
          emitTaskUpdated(sessionTaskId);
        })
        .catch((e) => {
          console.error(`[SessionManager] failed to set In Progress: ${e}`);
          this.emit('message', {
            type: 'error',
            message: `Failed to update task status to In Progress: ${e}`,
          } satisfies ServerMessage);
        });
    }

    // Look up the PR for review sessions so session_started carries prNumber.
    const reviewPr =
      sessionType === 'review' && sessionTaskId
        ? (getPRByNotionTaskId(sessionTaskId) ?? undefined)
        : undefined;
    const reviewPrNumber = reviewPr?.pr_number;
    const reviewCodeSessionId = reviewPr?.session_id ?? undefined;

    // Broadcast session_started — git + bootstrap complete, runner spawned.
    this.emit('message', {
      type: 'session_started',
      sessionId,
      taskName: taskName ?? taskUrl,
      notionTaskUrl: taskUrl,
      ...(taskType != null && { taskType }),
      ...(sessionType !== 'standard' && { sessionType }),
      ...(reviewPrNumber != null && { prNumber: reviewPrNumber }),
      ...(reviewCodeSessionId != null && {
        codeSessionId: reviewCodeSessionId,
      }),
      started_at: startedAt,
      project_id: projectId,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      ...(sessionTaskId && { taskId: sessionTaskId }),
    } satisfies ServerMessage);
  }

  /**
   * Remove a partially-created worktree and its feature branch after a failed
   * completeStart(). Safe to call even if nothing was created (idempotent).
   */
  private async cleanupPartialWorktree(sessionId: string): Promise<void> {
    const row = getSession(sessionId);
    if (!row) return;

    const project = getProjectById(row.project_id ?? '');
    if (!project) return;

    const projectDir = normalizePath(project.projectDir);
    const worktreePath = row.worktree_path;
    if (!worktreePath) return;

    if (fs.existsSync(worktreePath)) {
      try {
        await exec(`git worktree remove --force "${worktreePath}"`, {
          cwd: projectDir,
        });
        console.log(
          `[SessionManager] cleanupPartialWorktree: removed worktree for ${sessionId.slice(0, 8)}`,
        );
      } catch (err) {
        console.warn(
          `[SessionManager] cleanupPartialWorktree: worktree remove failed for ${sessionId.slice(0, 8)}: ${err}`,
        );
      }
    }

    const featureBranch = row.task_name
      ? deriveBranchSlug(row.task_name)
      : null;
    if (featureBranch) {
      try {
        await exec(`git branch -D "${featureBranch}"`, { cwd: projectDir });
        console.log(
          `[SessionManager] cleanupPartialWorktree: deleted branch ${featureBranch} for ${sessionId.slice(0, 8)}`,
        );
      } catch {
        // Branch does not exist — idempotent no-op
      }
    }
  }

  /**
   * Wire up event forwarding and fire-and-forget run() for a session.
   * Used by both start() and resumeSession() to avoid duplicating this logic.
   */
  private wireSession(
    sessionId: string,
    session: AgentSession,
    projectDir: string,
    worktreePath: string,
  ): void {
    // Forward all session events to the WS layer via EventEmitter
    session.on('message', (msg: ServerMessage) => this.emit('message', msg));
    // PR-attribution guard: warn when a session opens a PR for a different task
    // than the one it was dispatched for, then still forward so the PR is tracked.
    session.on('pr_opened', (job: unknown) => {
      const prJob = job as {
        taskId?: string;
        prNumber?: number;
        repo?: string;
      };
      console.log(
        `[SessionManager] forwarding pr_opened for PR #${prJob.prNumber ?? '?'} (${prJob.repo ?? '?'}) from session ${sessionId.slice(0, 8)}`,
      );
      const dispatched = session.taskId;
      if (
        dispatched &&
        prJob.taskId &&
        prJob.taskId.replace(/-/g, '') !== dispatched.replace(/-/g, '')
      ) {
        console.error(
          `[SessionManager] PR attribution mismatch: session ${sessionId.slice(0, 8)} dispatched for ${dispatched} but PR is attributed to ${prJob.taskId}`,
        );
        recordEvent({
          event_type: 'pr_attribution_mismatch',
          actor_type: 'system',
          actor_id: sessionId,
          project_id: null,
          task_id: dispatched,
          payload: { dispatchedTaskId: dispatched, prTaskId: prJob.taskId },
        });
      }
      console.log(
        `[SessionManager] emitting pr_opened to ReviewOrchestrator for PR #${prJob.prNumber ?? '?'}`,
      );
      this.emit('pr_opened', job);
    });
    // Forward push_detected so ReviewOrchestrator can trigger re-reviews
    session.on('push_detected', (payload: unknown) =>
      this.emit('push_detected', payload),
    );

    // Fire-and-forget — run() blocks until the subprocess exits, then clean up
    session
      .run()
      .then(() =>
        this.cleanupWorktree(
          sessionId,
          worktreePath,
          session.prUrl,
          projectDir,
        ),
      )
      .catch((err) => {
        console.error(`[SessionManager] session ${sessionId} error: ${err}`);
        // If run() threw before broadcasting session_ended, update SQLite and
        // notify the frontend so the session doesn't stay stuck at 'running'.
        if (!session.hasEnded) {
          this.markSessionErrored(sessionId, 'error', 'run_error');
        }
        return this.cleanupWorktree(
          sessionId,
          worktreePath,
          undefined,
          projectDir,
        );
      });
  }

  /**
   * Shared respawn helper used by both resumeSession (boot recovery) and
   * sendOrResume (verdict/feedback routing to a dead session).
   *
   * Creates an AgentSession reusing the original session ID, registers it in
   * the sessions map, updates the DB row to 'running', and emits session_status.
   * Does NOT call wireSession — callers must register any once-listeners on the
   * returned session BEFORE calling wireSession so there is no race with run().
   */
  private respawnSession(
    row: Session,
    worktreePath: string,
    orchConfig: ReturnType<typeof loadOrchestratorConfig>,
    runner: ISessionRunner,
    mcpConfigPath: string | undefined,
  ): AgentSession {
    const session = new AgentSession(
      row.session_id,
      row.task_url ?? '',
      row.project_context_url ?? '',
      undefined,
      worktreePath,
      row.task_id ?? '',
      row.session_id, // resumeSessionId — passes --resume to CLI / SDK
      undefined,
      row.session_type ?? 'standard',
      this,
      this.githubClient,
      orchConfig.allowed_tools,
      undefined,
      runner,
      row.project_id ?? '',
      mcpConfigPath,
    );
    if (row.pr_url) session.prUrl = row.pr_url;
    this.sessions.set(row.session_id, session);
    // Update (not insert) the existing DB row — the session is resuming in-place.
    updateSessionStatus(row.session_id, 'running');
    updateSessionWorktreePath(row.session_id, worktreePath);
    this.emit('message', {
      type: 'session_status',
      sessionId: row.session_id,
      status: 'running',
    } satisfies ServerMessage);
    return session;
  }

  /**
   * Re-attach to a session that was running when the server last shut down.
   * Unlike sendOrResume(), this keeps the original session_id so the UI shows
   * continuity — same card, same transcript.
   */
  private async resumeSession(row: Session): Promise<void> {
    const project = getProjectById(row.project_id ?? '');
    if (!project) {
      console.warn(
        `[SessionManager] orphan ${row.session_id}: project not found, marking error`,
      );
      this.markSessionErrored(
        row.session_id,
        'error',
        'orphan_project_not_found',
      );
      return;
    }

    const projectDir = normalizePath(project.projectDir);
    const worktreePath = row.worktree_path ?? '';

    // Resumability pre-check: claude --resume requires the original worktree as
    // cwd. If the worktree was deleted (e.g. PR merged and the orchestrator
    // cleaned it up), the spawn would exit immediately and the 30s timeout
    // fallback would fire. Detect this upfront and mark the session as error
    // without spawning anything.
    if (!worktreePath || !fs.existsSync(worktreePath)) {
      console.warn(
        `[SessionManager] resumability pre-check failed for ${row.session_id}: worktree missing (${worktreePath}) — marking error`,
      );
      this.markSessionErrored(row.session_id, 'error', 'worktree_missing');
      return;
    }

    console.log(
      `[SessionManager] resumeSession ${row.session_id}: re-using worktree ${worktreePath}`,
    );

    // Load per-project orchestrator config so resumed sessions get the same
    // extra allowed tools (e.g. Bash(dotnet:*)) as freshly spawned ones.
    const orchConfig = loadOrchestratorConfig(projectDir);

    const resumeSessionMode = runtimeSettings.session_mode;
    const resumeRunner =
      resumeSessionMode === 'api'
        ? new ApiSessionRunner(row.session_id)
        : getCorporateMode().gates.dockerMandatory
          ? new DockerSessionRunner(row.session_id)
          : new CliSessionRunner(row.session_id);

    const resumeMcpConfigPath = writeMcpConfig(
      worktreePath,
      orchConfig.mcp_servers,
    );

    // Shared helper: creates session with original ID, registers, updates DB, emits status.
    const session = this.respawnSession(
      row,
      worktreePath,
      orchConfig,
      resumeRunner,
      resumeMcpConfigPath,
    );

    // Re-pin: re-inject CLAUDE.md with the dispatched task so the resumed session
    // is bound to its original task and cannot self-select another task from the board.
    if (runtimeSettings.session_mode === 'cli' && row.task_url) {
      try {
        let taskContent: string | undefined;
        if (row.task_id && row.project_id) {
          try {
            taskContent = await getTaskBackend(row.project_id).fetchTaskPage(
              row.task_id,
            );
          } catch (fetchErr) {
            console.warn(
              `[SessionManager] resumeSession: task fetch failed for ${row.session_id.slice(0, 8)} (injecting without pre-loaded content): ${fetchErr}`,
            );
          }
        }
        const repinnedContext = buildSessionContext({
          taskName: row.task_name ?? row.task_url,
          taskUrl: row.task_url,
          projectContextUrl: row.project_context_url ?? '',
          targetBranch: project.baseBranch ?? 'dev',
          projectDir,
          worktreePath,
          verify: orchConfig.verify.length > 0 ? orchConfig.verify : undefined,
          bashRules:
            orchConfig.bash_rules.length > 0
              ? orchConfig.bash_rules
              : undefined,
          taskBackend:
            project.taskSource === 'yaml'
              ? 'local'
              : project.taskSource === 'github'
                ? 'github'
                : 'notion',
          taskContent,
          gitMode: project.gitMode,
        });
        session.injectContextFile('CLAUDE.md', repinnedContext);
        console.log(
          `[SessionManager] resumeSession: re-pinned CLAUDE.md for ${row.session_id.slice(0, 8)}`,
        );
      } catch (err) {
        console.warn(
          `[SessionManager] resumeSession: CLAUDE.md re-pin failed for ${row.session_id.slice(0, 8)}: ${err}`,
        );
      }
    }

    // Detect mid-turn state: last event was a tool_result or tool_use with no
    // subsequent assistant/result response. Log a warning to aid diagnosis.
    const sessionEvents = getEventsBySession(row.session_id);
    const lastEvent = sessionEvents[sessionEvents.length - 1];
    if (
      lastEvent &&
      (eventKind(lastEvent) === 'tool_result' ||
        eventKind(lastEvent) === 'tool_use')
    ) {
      console.warn(
        `[SessionManager] resumeSession ${row.session_id}: Resuming mid-turn session — sending continuation nudge`,
      );
    }

    // The CLI in --print --input-format stream-json mode needs stdin input to
    // produce output. Without an upfront message, a resumed session deadlocks:
    // CLI waits for input → SessionManager waits for output → nothing happens.
    // Fix: send the nudge on a short delay after wireSession() (which spawns
    // the CLI process), rather than waiting for a first event that may never
    // arrive. Use this.send() so the nudge is recorded in the DB as a
    // user_message event and broadcast via WebSocket.
    const RESUME_NUDGE_DELAY_MS = 2_000;
    const RESUME_TIMEOUT_MS = 30_000;

    // Error timer: if the CLI doesn't emit any events within 30s, mark as error.
    const errorTimer = setTimeout(() => {
      if (!session.hasEnded) {
        console.warn(
          `[SessionManager] resumeSession ${row.session_id}: no events within 30s after resume — marking as error`,
        );
        this.markSessionErrored(row.session_id, 'error', 'resume_timeout');
        session.kill().catch(() => {});
      }
    }, RESUME_TIMEOUT_MS);
    errorTimer.unref();

    // Cancel the error timer once the CLI emits its first event.
    session.once('message', () => {
      clearTimeout(errorTimer);
    });

    this.wireSession(row.session_id, session, projectDir, worktreePath);

    // Send the nudge after a short delay so the CLI process is ready to receive
    // stdin before we write to it. Review sessions should not receive the
    // code-session nudge — they wait for a re-review prompt with a diff instead.
    const nudgeMessage = this.buildResumeMessage(row);
    const nudgeDelay = setTimeout(() => {
      if (!session.hasEnded && row.session_type !== 'review') {
        this.send(row.session_id, nudgeMessage);
      }
    }, RESUME_NUDGE_DELAY_MS);
    nudgeDelay.unref();
  }

  /**
   * Build the resume nudge message for a session row. When the session's PR
   * has a stored review verdict, inject that verdict so the coder doesn't need
   * to query GitHub (where verdicts are never posted). Falls back to the plain
   * RESUME_NUDGE_MESSAGE when there is no verdict or the stored JSON is malformed.
   */
  private buildResumeMessage(row: Session): string {
    const pr = getPRBySessionId(row.session_id);
    if (!pr?.review_result) return RESUME_NUDGE_MESSAGE;
    try {
      const result = JSON.parse(pr.review_result) as PRReviewResult;
      if (
        result.verdict === 'needs_changes' ||
        result.verdict === 'incomplete'
      ) {
        return formatReviewFeedback(result, pr.review_iteration ?? 0);
      }
      if (result.verdict === 'approved') {
        return formatApprovedVerdictMessage(result);
      }
    } catch {
      // Malformed review_result — fall through to plain nudge.
    }
    return RESUME_NUDGE_MESSAGE;
  }

  /**
   * Detect sessions still marked 'running' in the DB after a server restart
   * and resume them via --resume so they come back to life instead of lingering
   * as unkillable ghosts. Called from server.ts after migrations and imports.
   */
  async resumeOrphanSessions(): Promise<void> {
    // Recover sessions that completed (last event = result) but got stuck at
    // 'running' because the review pipeline threw mid-handleCleanExit.
    const stuckRows = getStuckResultSessionRows();
    if (stuckRows.length > 0) {
      console.log(
        `[SessionManager] recovering ${stuckRows.length} stuck session(s) from running→done`,
      );
      for (const row of stuckRows) {
        markSessionDone(
          row.session_id,
          row.last_ts,
          row.pr_url ?? null,
          'boot_orphan_result_event',
        );
        let taskBackend;
        try {
          taskBackend = row.project_id ? getTaskBackend(row.project_id) : null;
        } catch {
          taskBackend = null;
        }
        if (taskBackend) {
          await recoverSession(row.session_id, {
            scope: 'boot',
            prUrl: row.pr_url ?? undefined,
            prDetectedLive: false,
            sessionType: row.session_type || 'standard',
            taskId: row.task_id || '',
            projectId: row.project_id || '',
            worktreePath: row.worktree_path || '',
            taskUrl: row.task_url || '',
            projectContextUrl: row.project_context_url || '',
            taskBackend,
            sessionManager: this,
            broadcast: (msg) => this.emit('message', msg),
            emitPrOpened: (data) => this.emit('pr_opened', data),
          }).catch((e) =>
            console.error(
              `[SessionManager] recoverSession failed for ${row.session_id}: ${e}`,
            ),
          );
        }
      }
    }

    // Reap running sessions whose PR is already merged or closed — terminate
    // rather than resume so they don't re-dispatch already-merged work.
    const mergedPrRows = getRunningSessionsWithMergedOrClosedPR();
    if (mergedPrRows.length > 0) {
      console.log(
        `[SessionManager] reaping ${mergedPrRows.length} session(s) with merged/closed PR`,
      );
      for (const row of mergedPrRows) {
        markSessionDone(
          row.session_id,
          row.last_ts,
          row.pr_url ?? null,
          'boot_merged_or_closed_pr',
        );
        let taskBackend;
        try {
          taskBackend = row.project_id ? getTaskBackend(row.project_id) : null;
        } catch {
          taskBackend = null;
        }
        if (taskBackend) {
          await recoverSession(row.session_id, {
            scope: 'boot',
            prUrl: row.pr_url ?? undefined,
            prDetectedLive: false,
            sessionType: row.session_type || 'standard',
            taskId: row.task_id || '',
            projectId: row.project_id || '',
            worktreePath: row.worktree_path || '',
            taskUrl: row.task_url || '',
            projectContextUrl: row.project_context_url || '',
            taskBackend,
            sessionManager: this,
            broadcast: (msg) => this.emit('message', msg),
            emitPrOpened: (data) => this.emit('pr_opened', data),
          }).catch((e) =>
            console.error(
              `[SessionManager] recoverSession failed for ${row.session_id}: ${e}`,
            ),
          );
        }
      }
    }

    // Reap orphaned Docker containers/networks from sessions no longer active.
    if (getCorporateMode().gates.dockerMandatory) {
      const liveIds = new Set(this.sessions.keys());
      reapOrphanContainers(liveIds);
    }

    const orphans = getSessionsByStatus(['running']);
    if (orphans.length === 0) return;
    console.log(
      `[SessionManager] found ${orphans.length} orphan session(s) — resuming`,
    );

    const codeSessionCount = [...this.sessions.values()].filter(
      (s) => s.sessionType !== 'review',
    ).length;
    const available = config.maxConcurrentCodeSessions - codeSessionCount;
    const reviewOrphans = orphans.filter(
      (row) => row.session_type === 'review',
    );
    const codeOrphans = orphans.filter((row) => row.session_type !== 'review');
    const toResume = [...reviewOrphans, ...codeOrphans.slice(0, available)];
    const toError = codeOrphans.slice(available);

    for (const row of toResume) {
      try {
        await this.resumeSession(row);
      } catch (err) {
        console.error(
          `[SessionManager] failed to resume ${row.session_id}: ${err}`,
        );
        // Mark as error so it doesn't retry forever on subsequent restarts.
        this.markSessionErrored(row.session_id, 'error', 'resume_failed');
      }
    }

    for (const row of toError) {
      console.warn(
        `[SessionManager] max concurrent code sessions reached — marking orphan ${row.session_id} as error`,
      );
      this.markSessionErrored(row.session_id, 'error', 'max_concurrent');
    }
  }

  private cleanupWorktree(
    sessionId: string,
    worktreePath: string,
    prUrl: string | undefined,
    projectDir: string,
  ): void {
    this.sessions.delete(sessionId);

    // Chokepoint guard: never tear down an idle session's worktree.
    // The worktree IS the session state for idle sessions — uncommitted WIP must
    // survive across idle→resume cycles. Teardown is deferred to terminal events
    // (PR merged/closed, session done/error/killed, explicit delete).
    const sessionRow = getSession(sessionId);
    if (sessionRow?.status === 'idle' && sessionRow?.pr_url) {
      return;
    }

    // Derive the task branch the session created from the worktree's HEAD.
    let branchName: string | undefined;
    try {
      const head = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: worktreePath,
        encoding: 'utf8',
      }).trim();
      // Only treat it as a task branch if it's not a detached HEAD.
      if (head !== 'HEAD') branchName = head;
    } catch {
      // worktree may already be gone — skip branch deletion
    }

    // Check if the main repo has unexpected modifications after session ends.
    // This catches worktree-escape bugs where a session edited the main repo
    // instead of its assigned worktree.
    try {
      const dirty = execSync('git status --porcelain', {
        cwd: projectDir,
        encoding: 'utf8',
      }).trim();
      if (dirty) {
        console.warn(
          `[SessionManager] [WARNING] Main repo has uncommitted changes after session ${sessionId.slice(0, 8)} ended — possible worktree escape:\n${dirty}`,
        );
      }
    } catch (err) {
      console.error(
        `[SessionManager] failed to check main repo status after session ${sessionId.slice(0, 8)}: ${err}`,
      );
    }

    // Remove the per-session MCP config before removing the worktree.
    const mcpConfigFile = path.join(
      worktreePath,
      '.claude',
      'orchestrator-mcp.json',
    );
    try {
      if (fs.existsSync(mcpConfigFile)) {
        fs.unlinkSync(mcpConfigFile);
      }
    } catch (err) {
      console.warn(
        `[SessionManager] failed to remove orchestrator-mcp.json for ${sessionId.slice(0, 8)}: ${err}`,
      );
    }

    try {
      execSync(`git worktree remove --force "${worktreePath}"`, {
        cwd: projectDir,
      });
    } catch (err) {
      const stderr =
        (err as { stderr?: string | Buffer })?.stderr?.toString() ??
        String(err);
      console.error(
        `[SessionManager] failed to remove worktree for ${sessionId}: ${err}`,
      );
      recordEvent({
        event_type: 'worktree_remove_failed',
        actor_type: 'system',
        actor_id: sessionId,
        project_id: null,
        task_id: null,
        payload: { worktreePath, stderr },
      });
    }

    const deleteBranch = !prUrl || this._mergedSessionIds.has(sessionId);
    this._mergedSessionIds.delete(sessionId);

    if (deleteBranch && branchName) {
      try {
        execSync(`git branch -D "${branchName}"`, {
          cwd: projectDir,
        });
      } catch (err) {
        console.error(
          `[SessionManager] failed to delete branch ${branchName}: ${err}`,
        );
      }
    }

    // Prune the legacy session/<sessionId> branch created by the pre-refactor dist code.
    pruneSessionBranch(sessionId, projectDir);
  }

  /**
   * Tear down the worktree for a session whose subprocess already exited (idle)
   * and that has now transitioned to a terminal state (done/error via PR merge or
   * PR close). Skips if the worktree path is absent on disk — the chokepoint guard
   * already protected it during the original run().then() cleanup.
   */
  private _teardownIdleSessionWorktree(sessionId: string): void {
    const row = getSession(sessionId);
    if (!row?.worktree_path) return;
    if (!fs.existsSync(row.worktree_path)) return;
    const project = getProjectById(row.project_id ?? '');
    if (!project) return;
    const projectDir = normalizePath(project.projectDir);
    this.cleanupWorktree(
      sessionId,
      row.worktree_path,
      row.pr_url ?? undefined,
      projectDir,
    );
  }

  /** Returns true if the session is currently live in the in-memory sessions map. */
  isAlive(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Count live standard (non-review) sessions. Used by AutoLauncher for concurrency. */
  getLiveCodeSessionCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.sessionType !== 'review') n++;
    }
    for (const [id, p] of this.pendingStarts) {
      if (p.sessionType !== 'review' && !this.sessions.has(id)) n++;
    }
    return n;
  }

  /** Returns true if a live session exists for the given task id. */
  hasLiveSessionForTask(taskId: string): boolean {
    const norm = taskId.replace(/-/g, '');
    for (const s of this.sessions.values()) {
      if (s.sessionType === 'review') continue;
      const tid = s.taskId?.replace(/-/g, '');
      if (tid && tid === norm) return true;
    }
    return false;
  }

  async kill(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.kill();
      // cleanup (sessions.delete + worktree removal) is driven by run().then()
    }
  }

  /**
   * Abort a session: kill the process, pre-mark the DB as killed (so orphan-resume
   * cannot re-attach on server restart), and reset the task to Ready.
   *
   * Distinct from kill(): abort always resets the task to Ready and pre-marks the
   * session killed in the DB before sending the kill signal, ensuring the session
   * can never be resumed even if the server crashes mid-abort.
   */
  async abortSession(sessionId: string): Promise<void> {
    const endedAt = Date.now();
    const row = getSession(sessionId);
    if (!row) return;

    // Pre-mark as killed immediately — prevents orphan-resume on server restart.
    updateSessionStatus(sessionId, 'killed', endedAt);

    // Set hasEnded on the in-memory session to prevent markSessionErrored from
    // double-updating DB and task status when kill() fires.
    const liveSession = this.sessions.get(sessionId);
    if (liveSession) liveSession.hasEnded = true;

    // Broadcast session_ended so the frontend updates the session card immediately.
    this.emit('message', {
      type: 'session_ended',
      sessionId,
      status: 'killed',
      ...(row.task_id && { taskId: row.task_id }),
    } satisfies ServerMessage);

    // Record audit event.
    recordEvent({
      event_type: 'session_aborted',
      actor_type: 'system',
      actor_id: sessionId,
      project_id: row.project_id ?? null,
      task_id: row.task_id ?? null,
      payload: { sessionId, reason: 'user_abort' },
    });

    // Kill the process (fire-and-forget — cleanup via run().then() still fires).
    if (liveSession) {
      liveSession.kill().catch((err) => {
        console.error(
          `[SessionManager] abortSession kill error for ${sessionId.slice(0, 8)}: ${err}`,
        );
      });
    }

    // Reset the task to Ready so the next launch is a fresh session.
    if (row.session_type !== 'standard' || !row.task_id) return;
    const notionTaskId = row.task_id;
    const projectId = row.project_id ?? '';

    getTaskBackend(projectId)
      .updateStatus(notionTaskId, '🗂️ Ready', {
        source: 'orchestrator',
        sessionId,
      })
      .then(() => {
        this.emit('message', {
          type: 'task_status_changed',
          notionTaskId,
          newStatus: '🗂️ Ready',
        } satisfies ServerMessage);
        emitTaskUpdated(notionTaskId);
      })
      .catch((e) =>
        console.error(
          `[SessionManager] abortSession updateStatus failed: ${e}`,
        ),
      );
  }

  /** Close stdin on the session process so the CLI can exit cleanly. */
  endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.endSession();
      return;
    }
    // Session not live (already idle) — explicitly finalize the worktree now
    // that a terminal event has fired (PR merged/closed, session done/killed).
    this._teardownIdleSessionWorktree(sessionId);
  }

  /** Mark a session so cleanupWorktree deletes its local branch (used on PR merge). */
  markForBranchDeletion(sessionId: string): void {
    this._mergedSessionIds.add(sessionId);
  }

  approve(sessionId: string): void {
    this.sessions.get(sessionId)?.approve();
  }

  deny(sessionId: string, reason?: string): void {
    this.sessions.get(sessionId)?.deny(reason);
  }

  /**
   * Register a Promise that resolves when the post-revert worktree sync completes.
   * Emits a 'revert_sync_registered' event so ReviewOrchestrator can await it
   * before fetching the PR diff for a re-review.
   */
  registerRevertSync(
    prNumber: number,
    repo: string,
    syncPromise: Promise<void>,
  ): void {
    this.emit('revert_sync_registered', { prNumber, repo, syncPromise });
  }

  /**
   * Add files to the per-session one-cycle injection skip lock.
   * Called by the autofix path so that files committed by autofix are not
   * immediately re-injected by the orchestrator context writer.
   */
  addToRevertLock(sessionId: string, files: string[]): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      for (const f of files) {
        session.lockFileForNextInjection(f);
      }
    }
  }

  /** Send a follow-up user message to a running session via stdin. */
  send(sessionId: string, message: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.sendMessage(message);
    const ts = Date.now();
    insertEvent({
      session_id: sessionId,
      event_type: 'user_message',
      payload: message,
      timestamp: ts,
    });
    this.emit('message', {
      type: 'session_event',
      sessionId,
      eventType: 'user_message',
      content: message,
    } satisfies ServerMessage);
  }

  /**
   * Send a message to a session, resuming it first if it is no longer live.
   * Reuses the original session ID so pull_requests.session_id linkage stays
   * valid and the UI card is updated in place (not a new card).
   *
   * If the session is still running, the message is delivered via send() directly.
   * Otherwise, a new AgentSession is spawned with --resume <sessionId> so the CLI
   * restores conversation history, full event forwarding (pr_opened, push_detected)
   * is wired via wireSession, and the message is sent after the first event.
   * A concurrency guard ensures only one respawn runs per session ID at a time.
   */
  async sendOrResume(sessionId: string, text: string): Promise<string> {
    // Live session — deliver directly
    if (this.sessions.has(sessionId)) {
      this.send(sessionId, text);
      return sessionId;
    }

    // Concurrency guard: if a respawn for this session is already in flight,
    // wait for it rather than double-spawning.
    const inflight = this.resumesInFlight.get(sessionId);
    if (inflight) return inflight;

    const promise = this._doSendOrResume(sessionId, text);
    this.resumesInFlight.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      this.resumesInFlight.delete(sessionId);
    }
  }

  private async _doSendOrResume(
    sessionId: string,
    text: string,
  ): Promise<string> {
    // Session not live — look up details from DB and re-launch with --resume
    const row = getSession(sessionId);
    if (!row) {
      console.error(
        `[SessionManager] sendOrResume: session ${sessionId} not found in DB`,
      );
      return sessionId;
    }

    // Refuse to respawn sessions that reached a terminal state — done/error/killed
    // sessions are intentionally finished and must not be revived by stale feedback.
    if (
      row.status === 'done' ||
      row.status === 'error' ||
      row.status === 'killed'
    ) {
      console.warn(
        `[SessionManager] sendOrResume: refusing to respawn terminal session ${sessionId} (status=${row.status})`,
      );
      this.emit('message', {
        type: 'session_action_failed',
        sessionId,
        action: 'send_message',
        reason: 'terminal_session',
        detail: `Session is in terminal state: ${row.status}`,
      } satisfies ServerMessage);
      return sessionId;
    }

    const project = getProjectById(row.project_id ?? '');
    if (!project) {
      console.error(
        `[SessionManager] sendOrResume: project not found for session ${sessionId}`,
      );
      return sessionId;
    }

    const projectDir = normalizePath(project.projectDir);
    // Reuse the original session ID for the worktree path — preserves
    // pull_requests.session_id linkage and UI card continuity.
    const worktreePath = path.join(
      projectDir,
      '.claude',
      'worktrees',
      sessionId,
    );

    // Fast path: if the session's recorded worktree already exists as a live git
    // worktree (has a .git pointer file), reuse it directly. This is the normal
    // resume path for idle sessions whose worktrees were preserved by the
    // chokepoint guard. No git worktree add needed — the session's own uncommitted
    // WIP is still there.
    const recordedPath = row.worktree_path ?? worktreePath;
    if (
      recordedPath &&
      fs.existsSync(recordedPath) &&
      fs.existsSync(path.join(recordedPath, '.git'))
    ) {
      console.log(
        `[SessionManager] sendOrResume reusing surviving worktree: path=${recordedPath}`,
      );
      const orchConfig = loadOrchestratorConfig(projectDir);
      const mode = runtimeSettings.session_mode;
      const runner =
        mode === 'api'
          ? new ApiSessionRunner(sessionId)
          : getCorporateMode().gates.dockerMandatory
            ? new DockerSessionRunner(sessionId)
            : new CliSessionRunner(sessionId);
      const mcpConfigPath = writeMcpConfig(
        recordedPath,
        orchConfig.mcp_servers,
      );
      if (row.task_id) {
        const stale = getOtherRunningSessionsForTask(
          row.task_id,
          row.session_id,
        );
        for (const s of stale) {
          console.log(
            `[SessionManager] sendOrResume: superseding stale session ${s.session_id.slice(0, 8)} for task ${row.task_id}`,
          );
          markSessionSuperseded(s.session_id, Date.now());
        }
      }
      const session = this.respawnSession(
        row,
        recordedPath,
        orchConfig,
        runner,
        mcpConfigPath,
      );
      const firstEvent = new Promise<void>((resolve) => {
        session.once('message', () => {
          this.send(sessionId, text);
          resolve();
        });
      });
      this.wireSession(sessionId, session, projectDir, recordedPath);
      await firstEvent;
      return sessionId;
    }

    // Resolve the starting point using dev as the base (no milestoneId available for resumed sessions).
    const { startingPoint, milestoneSlug } = resolveStartingPoint(
      project,
      null,
    );

    const isLocalOnly = project.gitMode === 'local-only';
    if (!isLocalOnly) {
      if (milestoneSlug) {
        try {
          ensureMilestoneBranch(milestoneSlug, projectDir, project.baseBranch);
        } catch (err) {
          console.warn(
            `[SessionManager] sendOrResume: ensureMilestoneBranch failed (continuing): ${err}`,
          );
        }
      } else {
        try {
          execSync(`git fetch origin ${project.baseBranch}`, {
            cwd: projectDir,
            timeout: 30_000,
          });
        } catch (err) {
          console.warn(
            `[SessionManager] sendOrResume: git fetch origin ${project.baseBranch} failed (continuing with local ref): ${err}`,
          );
        }
      }
    }

    const worktreeBase =
      isLocalOnly || startingPoint !== project.baseBranch
        ? startingPoint
        : `origin/${project.baseBranch}`;

    const resumeFeatureBranch = row.task_name
      ? deriveBranchSlug(row.task_name)
      : null;

    // Prune stale worktree registrations before attempting re-attach.
    // This handles the common case where the worktree dir was deleted but the
    // branch is still marked as "checked out" in git's internal tracking.
    try {
      execSync(`git worktree prune`, { cwd: projectDir });
    } catch (pruneErr) {
      console.warn(
        `[SessionManager] sendOrResume: git worktree prune failed (continuing): ${pruneErr}`,
      );
    }

    try {
      if (resumeFeatureBranch) {
        try {
          // Attach to existing branch — preserves all PR commits.
          execSync(
            `git worktree add "${worktreePath}" "${resumeFeatureBranch}"`,
            { cwd: projectDir },
          );
        } catch (attachErr) {
          const attachStderr =
            (attachErr as { stderr?: string | Buffer })?.stderr?.toString() ??
            '';
          // "already checked out" → branch is registered to a deleted worktree dir.
          // Prune the stale registration and retry the attach.
          const isAlreadyCheckedOut = attachStderr.includes(
            'already checked out',
          );
          if (isAlreadyCheckedOut) {
            try {
              execSync(`git worktree prune`, { cwd: projectDir });
            } catch {
              // best-effort
            }
            execSync(
              `git worktree add "${worktreePath}" "${resumeFeatureBranch}"`,
              { cwd: projectDir },
            );
          } else {
            // Branch doesn't exist locally (cleaned up) — try to recreate with -b.
            try {
              execSync(
                `git worktree add -b "${resumeFeatureBranch}" "${worktreePath}" ${worktreeBase}`,
                { cwd: projectDir },
              );
            } catch (createErr) {
              const createStderr =
                (
                  createErr as { stderr?: string | Buffer }
                )?.stderr?.toString() ?? '';
              if (/A branch named .* already exists/.test(createStderr)) {
                // -b failed: branch exists but attach failed with unrelated error.
                // Prune and reattach — the branch carries PR commits; never recreate.
                try {
                  execSync(`git worktree prune`, { cwd: projectDir });
                } catch {
                  // best-effort
                }
                execSync(
                  `git worktree add "${worktreePath}" "${resumeFeatureBranch}"`,
                  { cwd: projectDir },
                );
              } else {
                throw createErr;
              }
            }
          }
        }
      } else {
        execSync(
          `git worktree add --detach "${worktreePath}" ${worktreeBase}`,
          { cwd: projectDir },
        );
      }
    } catch (err) {
      const stderr =
        (err as { stderr?: string | Buffer })?.stderr?.toString() ?? '';
      const msg = `sendOrResume: worktree recreation failed for session ${sessionId.slice(0, 8)}: ${(err as Error).message}\nstderr: ${stderr}`;
      console.error(`[SessionManager] ${msg}`);

      this.markSessionErrored(sessionId, 'error', 'worktree_recreate_failed');

      this.emit('message', {
        type: 'session_action_failed',
        sessionId,
        action: 'sendOrResume',
        reason: 'worktree_recreate_failed',
        detail: stderr || (err as Error).message,
      } satisfies ServerMessage);

      return sessionId;
    }

    const isUnixStylePath =
      worktreePath.startsWith('/c/') || worktreePath.startsWith('/C/');
    console.log(
      `[SessionManager] sendOrResume worktree created: path=${worktreePath} startingPoint=${startingPoint}` +
        (isUnixStylePath
          ? ' [WARNING: Unix-style path detected — may not resolve correctly on Windows]'
          : ''),
    );

    // Load per-project orchestrator config so resumed sessions get the same
    // extra allowed tools (e.g. Bash(dotnet:*)) as freshly spawned ones.
    const orchConfig = loadOrchestratorConfig(projectDir);

    const mode = runtimeSettings.session_mode;
    const runner =
      mode === 'api'
        ? new ApiSessionRunner(sessionId)
        : getCorporateMode().gates.dockerMandatory
          ? new DockerSessionRunner(sessionId)
          : new CliSessionRunner(sessionId);

    const mcpConfigPath = writeMcpConfig(worktreePath, orchConfig.mcp_servers);

    // Reconcile zombie rows: mark any other running sessions for this task as
    // superseded before respawning, so no two live rows exist for the same task.
    if (row.task_id) {
      const stale = getOtherRunningSessionsForTask(row.task_id, row.session_id);
      for (const s of stale) {
        console.log(
          `[SessionManager] sendOrResume: superseding stale session ${s.session_id.slice(0, 8)} for task ${row.task_id}`,
        );
        markSessionSuperseded(s.session_id, Date.now());
      }
    }

    // Shared helper: creates session with original ID, registers in map,
    // updates DB row to 'running', emits session_status.
    const session = this.respawnSession(
      row,
      worktreePath,
      orchConfig,
      runner,
      mcpConfigPath,
    );

    // Register the pending text on the session so that if the resumed context
    // overflows, the escalated spawn re-delivers the original message rather
    // than dropping it. The session consumes this field in tryEscalateForOverflow().
    session.setPendingOverflowText(text);

    // Register the first-event listener BEFORE wireSession starts run() to
    // avoid a race where the first message arrives before the listener is set.
    const firstEvent = new Promise<void>((resolve) => {
      session.once('message', () => {
        this.send(sessionId, text);
        resolve();
      });
    });

    // wireSession wires message + pr_opened + push_detected forwarding and starts
    // run() fire-and-forget with cleanup. This is the single wiring point for all
    // resume paths, preventing the divergence that was silently dropping pr_opened.
    this.wireSession(sessionId, session, projectDir, worktreePath);

    await firstEvent;
    return sessionId;
  }

  async shutdownAll(): Promise<void> {
    const pauses = [...this.sessions.values()].map((s) => s.gracefulPause());
    await Promise.allSettled(pauses);
  }
}
