import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { EventEmitter } from 'events';
import { recordEvent } from '../audit/AuditLog';
import { scrubSecrets } from '../security/scrubSecrets';
import { AgentSession, parseNotionPageIdDashed } from './AgentSession';
import { formatTaskId } from '../tasks/taskId';
import { buildSessionContext } from './ContextBuilder';
import { buildReviewClaudeMd } from './orchestrator-claudemd';
import { resolveStartingPoint, ensureMilestoneBranch } from './branchModel';
import { loadOrchestratorConfig } from './orchestrator-config';
import { CliSessionRunner } from './CliSessionRunner';
import { ApiSessionRunner } from './ApiSessionRunner';
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
  insertEvent,
  getSession,
  getSessionsByStatus,
  getPRByNotionTaskId,
  getEventsBySession,
  getPRByNumber,
  getPRBySessionId,
  backfillStuckResultSessions,
  hasActiveSessionForTask,
} from '../db/queries';
import type { Session } from '../db/types';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { GitHubClient } from '../github/GitHubClient';
import type { ServerMessage } from '../ws/types';
import { deriveDisplayStatusFromDb } from '../tasks/TaskStatusEngine';
import type { DisplayStatus } from '../tasks/TaskStatusEngine';
import { emitTaskUpdated } from '../routes/tasks';
import { parseSection } from '../notion/NotionClient';

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
}

/** How long to suppress lastMessage-only task_updated broadcasts per task (ms). */
const LAST_MESSAGE_THROTTLE_MS = 3_000;

const TERMINAL_STATUSES = new Set(['done', 'error', 'killed']);
const ALWAYS_GUARDED_BRANCHES = new Set(['dev', 'main']);

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

  /** Last known DisplayStatus per notionTaskId — used to skip no-op broadcasts. */
  private _lastDisplayStatus = new Map<string, DisplayStatus>();
  /** Timestamp of last lastMessage-only task_updated per notionTaskId. */
  private _lastMessageThrottle = new Map<string, number>();
  /** Guards against re-entrant task_updated emission inside the emit override. */
  private _inTaskUpdate = false;

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
    const notionTaskId = this._notionTaskIdForMessage(msg);
    if (!notionTaskId) return;

    const isLastMessageOnly = msg.type === 'session_event';

    if (isLastMessageOnly) {
      const last = this._lastMessageThrottle.get(notionTaskId) ?? 0;
      const now = Date.now();
      if (now - last < LAST_MESSAGE_THROTTLE_MS) return;
      this._lastMessageThrottle.set(notionTaskId, now);
    }

    const displayStatus = deriveDisplayStatusFromDb(notionTaskId);
    const prev = this._lastDisplayStatus.get(notionTaskId);

    if (!isLastMessageOnly && displayStatus === prev) return;
    if (isLastMessageOnly && displayStatus === prev) {
      // lastMessage-only and status unchanged — skip entirely (throttle already passed,
      // but there's nothing interesting to send)
      return;
    }

    this._lastDisplayStatus.set(notionTaskId, displayStatus);
    emitTaskUpdated(notionTaskId);
  }

  /**
   * Determine the notionTaskId affected by a ServerMessage, if any.
   * Returns null for messages that cannot change task display status.
   */
  private _notionTaskIdForMessage(msg: ServerMessage): string | null {
    switch (msg.type) {
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

  start(
    taskUrl: string,
    projectContextUrl: string,
    options?: StartOptions,
  ): string {
    const {
      taskType,
      sessionType = 'standard',
      customPrompt,
      projectId = '',
      taskName,
      sessionId: providedSessionId,
      milestoneId = null,
      taskKind,
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
      const earlyNotionTaskId = formatTaskId(
        'notion',
        parseNotionPageIdDashed(taskUrl),
      );
      if (
        this.hasLiveSessionForTask(earlyNotionTaskId) ||
        hasActiveSessionForTask(earlyNotionTaskId)
      ) {
        const existing = [...this.sessions.values()].find((s) => {
          const tid = s.taskId?.replace(/-/g, '');
          return tid && tid === earlyNotionTaskId.replace(/-/g, '');
        });
        throw Object.assign(
          new Error(`Session already running for task ${earlyNotionTaskId}`),
          { alreadyRunning: true, sessionId: existing?.sessionId ?? '' },
        );
      }
    }

    const sessionId = providedSessionId ?? crypto.randomUUID();
    this.pendingStarts.set(sessionId, { sessionType });
    console.log(
      `[SessionManager] start ${sessionId} project=${projectId} sessionType=${sessionType}`,
    );

    const projectDir = normalizePath(project.projectDir);
    const worktreePath = path.join(
      projectDir,
      '.claude',
      'worktrees',
      sessionId,
    );

    // Record the main repo's current branch before creating the worktree so we
    // can detect and restore it if the session accidentally changes it.
    let mainBranch: string | undefined;
    try {
      mainBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: projectDir,
        encoding: 'utf8',
      }).trim();
      console.log(`[SessionManager] main branch before session: ${mainBranch}`);
    } catch (err) {
      console.warn(`[SessionManager] could not determine main branch: ${err}`);
    }

    const isLocalOnly = project.gitMode === 'local-only';

    // Resolve the starting point for the detached worktree.
    const { startingPoint, milestoneSlug } = resolveStartingPoint(
      project,
      milestoneId,
    );

    if (!isLocalOnly) {
      if (milestoneSlug) {
        // ensureMilestoneBranch fetches origin/dev internally when needed.
        try {
          ensureMilestoneBranch(milestoneSlug, projectDir);
        } catch (err) {
          console.warn(
            `[SessionManager] ensureMilestoneBranch failed (continuing): ${err}`,
          );
        }
      } else {
        try {
          // Fetch latest dev so sessions don't start from a stale local ref.
          execSync('git fetch origin dev', {
            cwd: projectDir,
            timeout: 30_000,
          });
        } catch (err) {
          console.warn(
            `[SessionManager] git fetch origin dev failed (continuing with local ref): ${err}`,
          );
        }
      }
    }

    // For github projects: use origin/dev when starting from dev, or the local
    // milestone branch ref (guaranteed to exist after ensureMilestoneBranch).
    const worktreeBase =
      isLocalOnly || startingPoint !== 'dev' ? startingPoint : 'origin/dev';

    try {
      execSync(`git worktree add --detach "${worktreePath}" ${worktreeBase}`, {
        cwd: projectDir,
      });
    } catch (err) {
      console.error(
        `[SessionManager] failed to create worktree for ${sessionId}: ${err}`,
      );
      throw err;
    }

    const isUnixStylePath =
      worktreePath.startsWith('/c/') || worktreePath.startsWith('/C/');
    console.log(
      `[SessionManager] worktree created: path=${worktreePath} startingPoint=${startingPoint}` +
        (isUnixStylePath
          ? ' [WARNING: Unix-style path detected — may not resolve correctly on Windows]'
          : ''),
    );

    // Load per-project orchestrator config (fresh read — no restart needed).
    const orchConfig = loadOrchestratorConfig(projectDir);

    // Run bootstrap script if configured (after worktree creation, before session spawn).
    // cwd is the main project root so git rev-parse --show-toplevel resolves correctly.
    // The worktree path is passed as $1 so the script can operate on it.
    if (orchConfig.bootstrap_script) {
      try {
        execSync(`bash ${orchConfig.bootstrap_script} "${worktreePath}"`, {
          cwd: projectDir,
          timeout: 120_000,
          stdio: 'pipe',
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

    // SessionManager.start() must store prefixed task IDs in sessions.task_id so
    // downstream parseTaskId() callers (NotionTaskBackend.updateStatus, attachPR,
    // etc.) succeed. parseNotionPageIdDashed converts URL-embedded dashless IDs to
    // dashed UUID form (Notion's native) so the JOIN with task_cache matches.
    const notionTaskId = formatTaskId(
      'notion',
      parseNotionPageIdDashed(taskUrl),
    );
    const sessionMode = runtimeSettings.session_mode;
    const runner =
      sessionMode === 'api'
        ? new ApiSessionRunner(sessionId)
        : getCorporateMode().gates.dockerMandatory
          ? new DockerSessionRunner(sessionId)
          : new CliSessionRunner(sessionId);

    // Pre-fetch task content from Notion so sessions skip Notion calls entirely.
    // This is async — the session card is shown immediately, context is written
    // before the AgentSession is created and run() is called.
    const launchSession = async () => {
      let taskContent: string | undefined;
      if (sessionType !== 'review' && notionTaskId) {
        try {
          taskContent =
            await getTaskBackend(projectId).fetchTaskPage(notionTaskId);
          console.log(
            `[SessionManager] pre-fetched task content for ${sessionId.slice(0, 8)} (${taskContent.length} chars)`,
          );
        } catch (err) {
          console.warn(
            `[SessionManager] failed to pre-fetch task content for ${sessionId.slice(0, 8)} — session will fetch from task backend: ${err}`,
          );
        }
      }

      // Pre-read files listed in the task spec so the session can skip exploration.
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

      // Build the session context to inject into the worktree's CLAUDE.md.
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
            verify:
              orchConfig.verify.length > 0 ? orchConfig.verify : undefined,
            bashRules:
              orchConfig.bash_rules.length > 0
                ? orchConfig.bash_rules
                : undefined,
            taskBackend: project.taskSource === 'yaml' ? 'local' : 'notion',
            taskContent,
            gitMode: project.gitMode,
          });
        } catch (err) {
          console.error(
            `[SessionManager] failed to build session context for ${sessionId}: ${err}`,
          );
        }
      }

      const session = new AgentSession(
        sessionId,
        taskUrl,
        projectContextUrl,
        undefined, // taskBackendOverride — production resolves via getTaskBackend(projectId)
        worktreePath,
        notionTaskId,
        undefined,
        customPrompt,
        sessionType,
        this,
        this.githubClient,
        orchConfig.allowed_tools,
        sessionMode === 'api' ? sessionContextContent : undefined,
        runner,
        projectId,
      );

      if (sessionMode === 'cli' && sessionContextContent) {
        // Write orchestrator content to root CLAUDE.md in the worktree via injectContextFile
        // so that the per-session revert lock is honoured (new sessions always have an empty
        // lock, so this always proceeds on first launch).
        // No assume-unchanged (blocked rebase/checkout). No .claude/CLAUDE.md
        // (worktrees don't resolve project-level CLAUDE.md correctly).
        session.injectContextFile('CLAUDE.md', sessionContextContent);
        console.log(
          `[SessionManager] orchestrator CLAUDE.md written to worktree for ${sessionId.slice(0, 8)}`,
        );
      }

      this.pendingStarts.delete(sessionId);
      this.sessions.set(sessionId, session);
      this.wireSession(
        sessionId,
        session,
        projectDir,
        worktreePath,
        mainBranch,
      );
    };

    // Insert session into SQLite BEFORE launching the subprocess so FK
    // constraints on session_events are never violated by events that arrive
    // before the row exists (review sessions have no awaits in launchSession,
    // so the CLI can spawn and emit events within the same tick).
    const startedAt = Date.now();
    insertSession({
      session_id: sessionId,
      task_id: notionTaskId,
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
      task_id: notionTaskId || null,
      payload: {
        session_type: sessionType,
        task_url: taskUrl,
        task_kind: taskKind,
      },
    });

    // Launch async — session card is already visible to the frontend via the broadcast below.
    launchSession().catch((err) => {
      this.pendingStarts.delete(sessionId);
      console.error(
        `[SessionManager] launchSession failed for ${sessionId}: ${err}`,
      );
      updateSessionStatus(sessionId, 'error', Date.now());
      this.emit('message', {
        type: 'session_ended',
        sessionId,
        status: 'error',
      } satisfies ServerMessage);
      // Roll back task status to Ready so the card doesn't stay stuck In Progress.
      if (sessionType === 'standard' && notionTaskId) {
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
            console.error(`[SessionManager] rollback to Ready failed: ${e}`),
          );
      }
      this.emit('message', {
        type: 'error',
        message: `Session launch failed: ${err instanceof Error ? err.message : String(err)}`,
      } satisfies ServerMessage);
    });

    if (sessionType === 'standard') {
      getTaskBackend(projectId)
        .updateStatus(notionTaskId, '🔄 In Progress', {
          source: 'orchestrator',
          sessionId,
        })
        .then(() => {
          this.emit('message', {
            type: 'task_status_changed',
            notionTaskId,
            newStatus: '🔄 In Progress',
          } satisfies ServerMessage);
          emitTaskUpdated(notionTaskId);
        })
        .catch((e) => {
          console.error(`[SessionManager] failed to set In Progress: ${e}`);
          this.emit('message', {
            type: 'error',
            message: `Failed to update task status to In Progress: ${e}`,
          } satisfies ServerMessage);
        });
    }

    // Look up the PR for review sessions so the card can display "Review of #N" and link to code session
    const reviewPr =
      sessionType === 'review' && notionTaskId
        ? (getPRByNotionTaskId(notionTaskId) ?? undefined)
        : undefined;
    const reviewPrNumber = reviewPr?.pr_number;
    const reviewCodeSessionId = reviewPr?.session_id ?? undefined;

    // Broadcast session_started so connected frontends see the card immediately
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
    } satisfies ServerMessage);

    return sessionId;
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
    mainBranch?: string,
  ): void {
    // Forward all session events to the WS layer via EventEmitter
    session.on('message', (msg: ServerMessage) => this.emit('message', msg));
    // Forward pr_opened so ReviewOrchestrator can subscribe at the SessionManager level
    session.on('pr_opened', (job: unknown) => this.emit('pr_opened', job));
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
          mainBranch,
        ),
      )
      .catch((err) => {
        console.error(`[SessionManager] session ${sessionId} error: ${err}`);
        // If run() threw before broadcasting session_ended, update SQLite and
        // notify the frontend so the session doesn't stay stuck at 'running'.
        if (!session.hasEnded) {
          updateSessionStatus(sessionId, 'error', Date.now());
          this.emit('message', {
            type: 'session_ended',
            sessionId,
            status: 'error',
          } satisfies ServerMessage);
        }
        return this.cleanupWorktree(
          sessionId,
          worktreePath,
          undefined,
          projectDir,
          mainBranch,
        );
      });
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
      updateSessionStatus(row.session_id, 'error', Date.now());
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
      updateSessionStatus(row.session_id, 'error', Date.now());
      this.emit('message', {
        type: 'session_ended',
        sessionId: row.session_id,
        status: 'error',
      } satisfies ServerMessage);
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

    const session = new AgentSession(
      row.session_id, // keep original ID — same card, same transcript
      row.task_url ?? '',
      row.project_context_url ?? '',
      undefined, // taskBackendOverride — production resolves via getTaskBackend
      worktreePath,
      row.task_id ?? '',
      row.session_id, // resumeSessionId — passes --resume to CLI / SDK
      undefined,
      row.session_type ?? 'standard',
      this,
      this.githubClient,
      orchConfig.allowed_tools,
      undefined, // no systemPromptContent for resume (session already has context)
      resumeRunner,
      row.project_id ?? '',
    );

    // Carry forward the PR url so cleanupWorktree does NOT delete the branch on
    // the next clean exit. Without this, a resumed session loses track of the
    // PR it opened pre-restart and the branch is wiped along with the worktree.
    if (row.pr_url) {
      session.prUrl = row.pr_url;
    }

    this.sessions.set(row.session_id, session);

    // Don't insert a new DB row — one already exists.
    // Update status to running and broadcast so the frontend sees it come back.
    updateSessionStatus(row.session_id, 'running');
    this.emit('message', {
      type: 'session_status',
      sessionId: row.session_id,
      status: 'running',
    } satisfies ServerMessage);

    // Detect mid-turn state: last event was a tool_result or tool_use with no
    // subsequent assistant/result response. Log a warning to aid diagnosis.
    const sessionEvents = getEventsBySession(row.session_id);
    const lastEvent = sessionEvents[sessionEvents.length - 1];
    if (
      lastEvent &&
      (lastEvent.event_type === 'tool_result' ||
        lastEvent.event_type === 'tool_use')
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
        updateSessionStatus(row.session_id, 'error', Date.now());
        this.emit('message', {
          type: 'session_ended',
          sessionId: row.session_id,
          status: 'error',
        } satisfies ServerMessage);
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
    const nudgeDelay = setTimeout(() => {
      if (!session.hasEnded && row.session_type !== 'review') {
        this.send(row.session_id, RESUME_NUDGE_MESSAGE);
      }
    }, RESUME_NUDGE_DELAY_MS);
    nudgeDelay.unref();
  }

  /**
   * Detect sessions still marked 'running' in the DB after a server restart
   * and resume them via --resume so they come back to life instead of lingering
   * as unkillable ghosts. Called from server.ts after migrations and imports.
   */
  async resumeOrphanSessions(): Promise<void> {
    // Backfill sessions that completed (last event = result) but got stuck at
    // 'running' because the review pipeline threw mid-handleCleanExit.
    const backfilled = backfillStuckResultSessions();
    if (backfilled > 0) {
      console.log(
        `[SessionManager] backfilled ${backfilled} stuck session(s) from running→done`,
      );
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
        updateSessionStatus(row.session_id, 'error', Date.now());
      }
    }

    for (const row of toError) {
      console.warn(
        `[SessionManager] max concurrent code sessions reached — marking orphan ${row.session_id} as error`,
      );
      updateSessionStatus(row.session_id, 'error', Date.now());
    }
  }

  private cleanupWorktree(
    sessionId: string,
    worktreePath: string,
    prUrl: string | undefined,
    projectDir: string,
    mainBranch?: string,
  ): void {
    this.sessions.delete(sessionId);

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

    // Restore the main repo's branch if the session inadvertently changed it.
    // This guards against the Claude subprocess (or a git worktree edge case)
    // switching the main directory's checked-out branch during the session.
    if (mainBranch) {
      try {
        const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: projectDir,
          encoding: 'utf8',
        }).trim();
        if (currentBranch !== mainBranch) {
          console.warn(
            `[SessionManager] [WARNING] Main repo branch changed from "${mainBranch}" to "${currentBranch}" during session ${sessionId.slice(0, 8)} — restoring`,
          );
          execSync(`git checkout "${mainBranch}"`, { cwd: projectDir });
          console.log(
            `[SessionManager] main repo branch restored to "${mainBranch}"`,
          );
        }
      } catch (err) {
        console.error(
          `[SessionManager] failed to check/restore main repo branch after session ${sessionId.slice(0, 8)}: ${err}`,
        );
      }
    }

    try {
      execSync(`git worktree remove --force "${worktreePath}"`, {
        cwd: projectDir,
      });
    } catch (err) {
      console.error(
        `[SessionManager] failed to remove worktree for ${sessionId}: ${err}`,
      );
    }

    if (!prUrl && branchName) {
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

  /** Returns true if a live session exists for the given Notion task id. */
  hasLiveSessionForTask(notionTaskId: string): boolean {
    const norm = notionTaskId.replace(/-/g, '');
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

  /** Close stdin on the session process so the CLI can exit cleanly. */
  endSession(sessionId: string): void {
    this.sessions.get(sessionId)?.endSession();
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
   *
   * If the session is still in the sessions map (running), the message is
   * delivered via send() directly. Otherwise, a new AgentSession is spawned
   * with --resume <sessionId> so the CLI restores the conversation history,
   * and the message is sent once the session emits its first event.
   */
  /**
   * Send a message to a session, resuming it first if it is no longer live.
   * Returns the session ID that was used (the original if live, or the new
   * resumed session ID if the session was restarted with --resume).
   */
  async sendOrResume(sessionId: string, text: string): Promise<string> {
    // Live session — deliver directly
    if (this.sessions.has(sessionId)) {
      this.send(sessionId, text);
      return sessionId;
    }

    // Session not live — look up details from DB and re-launch with --resume
    const row = getSession(sessionId);
    if (!row) {
      console.error(
        `[SessionManager] sendOrResume: session ${sessionId} not found in DB`,
      );
      return sessionId;
    }

    const project = getProjectById(row.project_id ?? '');
    if (!project) {
      console.error(
        `[SessionManager] sendOrResume: project not found for session ${sessionId}`,
      );
      return sessionId;
    }

    const newSessionId = crypto.randomUUID();
    const projectDir = normalizePath(project.projectDir);
    const worktreePath = path.join(
      projectDir,
      '.claude',
      'worktrees',
      newSessionId,
    );

    // Record the main repo's current branch before creating the worktree.
    let mainBranchResume: string | undefined;
    try {
      mainBranchResume = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: projectDir,
        encoding: 'utf8',
      }).trim();
      console.log(
        `[SessionManager] sendOrResume main branch before session: ${mainBranchResume}`,
      );
    } catch (err) {
      console.warn(
        `[SessionManager] sendOrResume: could not determine main branch: ${err}`,
      );
    }

    // Resolve the starting point using dev as the base (no milestoneId available for resumed sessions).
    const {
      startingPoint: resumeStartingPoint,
      milestoneSlug: resumeMilestoneSlug,
    } = resolveStartingPoint(project, null);

    const isLocalOnlyResume = project.gitMode === 'local-only';
    if (!isLocalOnlyResume) {
      if (resumeMilestoneSlug) {
        try {
          ensureMilestoneBranch(resumeMilestoneSlug, projectDir);
        } catch (err) {
          console.warn(
            `[SessionManager] sendOrResume: ensureMilestoneBranch failed (continuing): ${err}`,
          );
        }
      } else {
        try {
          execSync('git fetch origin dev', {
            cwd: projectDir,
            timeout: 30_000,
          });
        } catch (err) {
          console.warn(
            `[SessionManager] sendOrResume: git fetch origin dev failed (continuing with local ref): ${err}`,
          );
        }
      }
    }

    const resumeWorktreeBase =
      isLocalOnlyResume || resumeStartingPoint !== 'dev'
        ? resumeStartingPoint
        : 'origin/dev';

    try {
      execSync(
        `git worktree add --detach "${worktreePath}" ${resumeWorktreeBase}`,
        { cwd: projectDir },
      );
    } catch (err) {
      console.error(
        `[SessionManager] sendOrResume: failed to create worktree: ${err}`,
      );
      throw err;
    }

    const isUnixStylePathResume =
      worktreePath.startsWith('/c/') || worktreePath.startsWith('/C/');
    console.log(
      `[SessionManager] sendOrResume worktree created: path=${worktreePath} startingPoint=${resumeStartingPoint}` +
        (isUnixStylePathResume
          ? ' [WARNING: Unix-style path detected — may not resolve correctly on Windows]'
          : ''),
    );

    const taskUrl = row.task_url ?? '';
    const projectContextUrl = row.project_context_url ?? '';
    const taskId = row.task_id ?? '';

    // Load per-project orchestrator config so resumed sessions get the same
    // extra allowed tools (e.g. Bash(dotnet:*)) as freshly spawned ones.
    const orchConfigResume = loadOrchestratorConfig(projectDir);

    const sendOrResumeMode = runtimeSettings.session_mode;
    const sendOrResumeRunner =
      sendOrResumeMode === 'api'
        ? new ApiSessionRunner(newSessionId)
        : new CliSessionRunner(newSessionId);

    const session = new AgentSession(
      newSessionId,
      taskUrl,
      projectContextUrl,
      undefined, // taskBackendOverride — production resolves via getTaskBackend
      worktreePath,
      taskId,
      sessionId, // resumeSessionId — restores conversation history via --resume / SDK resume
      undefined,
      row.session_type ?? 'standard',
      this,
      this.githubClient,
      orchConfigResume.allowed_tools,
      undefined, // no systemPromptContent for resume
      sendOrResumeRunner,
      row.project_id ?? '',
    );

    // Carry forward the PR url so cleanupWorktree does NOT delete the branch on
    // the next clean exit.
    if (row.pr_url) {
      session.prUrl = row.pr_url;
    }

    const startedAt = Date.now();
    insertSession({
      session_id: newSessionId,
      task_id: taskId,
      task_url: taskUrl,
      project_context_url: projectContextUrl,
      project_id: row.project_id,
      status: 'starting',
      started_at: startedAt,
      ended_at: null,
      pr_url: row.pr_url ?? null,
      worktree_path: worktreePath,
    });

    this.emit('message', {
      type: 'session_started',
      sessionId: newSessionId,
      taskName: taskUrl,
      notionTaskUrl: taskUrl,
      started_at: startedAt,
    } satisfies ServerMessage);

    this.sessions.set(newSessionId, session);
    session.on('message', (msg: ServerMessage) => this.emit('message', msg));

    // Wait for the first event from the resumed session, then deliver the message
    const firstEvent = new Promise<void>((resolve) => {
      session.once('message', () => {
        this.send(newSessionId, text);
        resolve();
      });
    });

    session
      .run()
      .then(() =>
        this.cleanupWorktree(
          newSessionId,
          worktreePath,
          session.prUrl,
          projectDir,
          mainBranchResume,
        ),
      )
      .catch((err) => {
        console.error(
          `[SessionManager] resumed session ${newSessionId} error: ${err}`,
        );
        if (!session.hasEnded) {
          updateSessionStatus(newSessionId, 'error', Date.now());
          this.emit('message', {
            type: 'session_ended',
            sessionId: newSessionId,
            status: 'error',
          } satisfies ServerMessage);
        }
        return this.cleanupWorktree(
          newSessionId,
          worktreePath,
          undefined,
          projectDir,
          mainBranchResume,
        );
      });

    await firstEvent;
    return newSessionId;
  }

  async shutdownAll(): Promise<void> {
    const kills = [...this.sessions.keys()].map((id) => this.kill(id));
    await Promise.allSettled(kills);
  }
}
