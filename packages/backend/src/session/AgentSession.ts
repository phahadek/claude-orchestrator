import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  ALLOWED_TOOLS,
  GITHUB_REPO,
  runtimeSettings,
  getProjectById,
} from '../config';
import {
  upsertSessionEvent,
  updateSessionStatus,
  markSessionIdle,
  getEventsBySession,
  insertPermissionDenial,
  upsertPullRequest,
  incrementTokens,
  incrementCompactionCount,
  setContextOccupancy,
  setSessionModel,
  setSessionMetadata,
  getPRBySessionId,
  setHeadSha,
  setPauseReason,
  setSessionPauseReason,
  insertPauseInterval,
  getSessionTags,
  setSessionTags,
  resetTaskCrashCount,
} from '../db/queries';
import type { ServerMessage, PermissionDenial } from '../ws/types';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { TaskBackend } from '../tasks/TaskBackend';
import type { GitHubClient } from '../github/GitHubClient';
import {
  validatePRBody,
  buildValidationComment,
} from '../github/PRBodyValidator';
import { runFilePollutionCheck as filePollutionCheckFn } from './filePollutionCheck';
import { checkCommitAttribution } from '../github/CommitAttributionWatcher';
import { recordEvent, countPushFailureEvents } from '../audit/AuditLog';
import { isSystemOnlyUserEvent } from '../utils/eventFilters';
import type { ISessionManager } from './SessionAuditor';
import { detectInFlightEscape } from './SessionAuditor';
import type { ISessionRunner } from './SessionRunner';
import { CliSessionRunner } from './CliSessionRunner';
import { recoverSession } from './sessionRecovery';
import {
  VALID_EVENT_TYPES,
  SILENT_SKIP_TYPES,
  toEventType,
} from './eventTypes';
import { eventKind } from './eventKind';
import { isContextOverflow } from './contextOverflow';
import { logger } from '../logger';

const PR_URL_REGEX = /https:\/\/github\.com\/[^"\\]+\/pull\/\d+/;
const PR_BODY_MARKER_REGEX = /<pr-body>([\s\S]*?)<\/pr-body>/;

/**
 * Returns true if the tool call represents a git push operation.
 * Exported for unit testing.
 */
export function isPushCommand(toolName: string, toolInput: string): boolean {
  if (toolName === 'mcp__github__push_files') return true;
  if (
    toolName === 'Bash' &&
    /git\s+push/.test(toolInput) &&
    !toolInput.includes('--dry-run')
  )
    return true;
  return false;
}

/**
 * Returns true if the tool call represents a `gh pr create` invocation.
 * Exported for unit testing.
 */
export function isPRCreateCommand(
  toolName: string,
  toolInput: string,
): boolean {
  if (toolName !== 'Bash') return false;
  return /\bgh\s+pr\s+create\b/.test(toolInput);
}

export interface GitHubPRShape {
  number?: number;
  html_url?: string;
  url?: string;
  title?: string;
  body?: string | null;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string };
  state?: string;
  created_at?: string;
  updated_at?: string;
  draft?: boolean;
}

/** Extract plain text from a tool_result event's content (string or content blocks). */
export function extractTextFromToolResultEvent(
  event: Record<string, unknown>,
): string {
  const content = event.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
  }
  return '';
}

function sessionLog(sessionId: string, ...args: unknown[]) {
  logger.info(`[Session ${sessionId.slice(0, 8)}]`, ...args);
}

/** Parse the Notion page ID out of a notion.so URL or return the raw value. */
export function parseNotionPageId(url: string): string {
  const match = url.match(/([a-f0-9]{32})$/i);
  if (match) return match[1];
  const uuidMatch = url.match(/([0-9a-f-]{36})$/i);
  if (uuidMatch) return uuidMatch[1].replace(/-/g, '');
  return url;
}

/**
 * Like parseNotionPageId, but always returns the dashed UUID form (Notion's native).
 * Converts a 32-hex dashless ID to dashed; passes through already-dashed or non-UUID inputs unchanged.
 */
export function parseNotionPageIdDashed(url: string): string {
  const raw = parseNotionPageId(url);
  if (/^[0-9a-f]{32}$/i.test(raw)) {
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
  }
  return raw;
}

/**
 * Attempt to extract an existing PR number from a GitHub 422 "already exists" error
 * body or message. Returns null when the number cannot be parsed.
 */
function extractPRNumberFromError(msg: string): number | null {
  const m = msg.match(/pull\/(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Merge assistant message content blocks so that text blocks emitted in earlier
 * streaming events are not lost when later streaming events contain only tool_use
 * blocks. The Claude CLI can stream multiple `assistant` events for the same message
 * turn (sharing the same `message.id`) — first text, then tool_use — so we must
 * accumulate rather than replace.
 */
function mergeAssistantContent(
  existing: Array<Record<string, unknown>>,
  incoming: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const existingText = existing.filter((b) => b.type === 'text');
  const incomingText = incoming.filter((b) => b.type === 'text');

  // Prefer incoming text blocks (they contain the most up-to-date streamed content).
  // If the incoming event has no text blocks, preserve the existing ones.
  const textBlocks = incomingText.length > 0 ? incomingText : existingText;

  // Merge tool_use blocks by id so we don't duplicate them across streaming events.
  const toolUseById = new Map<string, Record<string, unknown>>();
  for (const b of existing) {
    if (b.type === 'tool_use' && typeof b.id === 'string')
      toolUseById.set(b.id, b);
  }
  for (const b of incoming) {
    if (b.type === 'tool_use' && typeof b.id === 'string')
      toolUseById.set(b.id, b);
  }

  return [...textBlocks, ...toolUseById.values()];
}

export class AgentSession extends EventEmitter {
  private isKilling = false;
  /** Set by gracefulPause() so the run loop exits without updating DB status. */
  private isPausingForShutdown = false;
  public prUrl: string | undefined;
  /** True once a session_ended message has been broadcast. */
  public hasEnded = false;
  /** Maps message_id → DB row id for deduplicating streaming assistant events. */
  private messageIdMap = new Map<string, number>();
  /** Maps message_id → accumulated content blocks, so text is not lost when
   *  tool_use arrives in a later streaming event for the same message. */
  private messageContentMap = new Map<string, Array<Record<string, unknown>>>();
  /** Maps tool_use_id → tool_name for PR creation tools, for real-time detection. */
  private pendingGHToolUseIds = new Map<string, string>();
  /** Maps tool_use_id → Bash command string, for push detection. */
  private pendingBashCommands = new Map<string, string>();
  /** Tracks mcp__github__push_files tool_use IDs awaiting a successful tool_result. */
  private pendingPushFileToolUseIds = new Set<string>();
  /** True once a PR was detected and inserted during the live session. */
  private prDetectedLive = false;
  /** Accumulated token counts for this session (in-memory, synced to SQLite). */
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  /** Count of compact_boundary events seen this session (in-memory, synced to SQLite). */
  private compactionCount = 0;
  static contextWindowForModel(model: string | null): number {
    return model?.includes('[1m]') ? 1_000_000 : 200_000;
  }
  /** Model name extracted from the first assistant event (e.g. 'claude-sonnet-4-6'). */
  public model: string | null = null;
  /** Count of consecutive transient-error retries for this session instance. Resets on clean exit. */
  private retryCount = 0;
  /** Guard: fires at most once per session to avoid duplicate pause broadcasts. */
  private inSessionApiErrorFired = false;
  /** Set when a context-overflow result event is detected; suppresses generic retry. */
  private contextOverflowDetected = false;
  /** Set by tryEscalateForOverflow() — target model for the escalated spawn. */
  private _escalationModel: string | undefined = undefined;
  /** Set by tryEscalateForOverflow() — disableAutoCompact override for the escalated spawn. */
  private _escalationDisableAutoCompact: boolean | null = null;
  /** One-cycle injection skip lock set by PRFileReverter.
   *  Each entry is consumed (deleted) the first time injectContextFile checks it,
   *  blocking exactly one injection attempt per reverted file before resetting. */
  private readonly _revertLock = new Set<string>();
  /** SHA of the last orchestrator-revert commit pushed by runFilePollutionCheck.
   *  Used as a loop guard: if the PR's HEAD equals this SHA, the check is skipped
   *  so we don't re-revert our own revert commit. */
  private lastFilePollutionRevertSha: string | null = null;
  /** Tracks message IDs whose <pr-body> marker has already been processed (deduplicate streaming chunks). */
  private readonly processedPRBodyMessageIds = new Set<string>();
  /** tool_use_ids already warned for worktree escape (deduplicate across streaming chunks). */
  private readonly warnedEscapeToolUseIds = new Set<string>();
  /** In-flight promise from handlePRBodyMarker; awaited by handleCleanExit before markSessionIdle. */
  private prBodyMarkerPromise: Promise<void> | null = null;
  /** Continuation nudge to deliver via stdin on the first event of the escalated session. */
  private _pendingEscalationNudge: string | null = null;
  /** Text that triggered an overflow on this resume; re-delivered to the escalated session. */
  private _pendingOverflowText: string | null = null;

  /** The underlying I/O adapter (CLI subprocess or Agent SDK). */
  private runner: ISessionRunner;

  constructor(
    public readonly sessionId: string,
    public readonly taskUrl: string,
    public readonly projectContextUrl: string,
    /**
     * Optional fixed task backend used by tests. In production this is undefined
     * and the backend is resolved per-call via `getTaskBackend(projectId)`.
     */
    private readonly taskBackendOverride: TaskBackend | undefined,
    public readonly worktreePath: string,
    public readonly taskId: string,
    private readonly resumeSessionId?: string,
    private readonly customPrompt?: string,
    public readonly sessionType: string = 'standard',
    private readonly sessionManager?: ISessionManager,
    private readonly githubClient?: GitHubClient,
    private readonly extraAllowedTools: string[] = [],
    /**
     * System prompt content for API mode.
     * In CLI mode this is written to CLAUDE.md in the worktree before spawn.
     * In API mode this is passed directly to the Agent SDK as systemPrompt.
     */
    private readonly systemPromptContent?: string,
    /**
     * The session runner to use. Defaults to CliSessionRunner.
     * Pass an ApiSessionRunner instance when SESSION_MODE=api.
     */
    runner?: ISessionRunner,
    /**
     * Project id used to resolve the task backend at call time when
     * `taskBackendOverride` is undefined. Appended at the end so legacy
     * positional callers (tests) need not be touched.
     */
    public readonly projectId: string = '',
    /**
     * Absolute path to the per-session MCP config JSON file written by
     * SessionManager when `mcp_servers` is set in the orchestrator config.
     * Forwarded to the runner as `mcpConfigPath`.
     */
    private readonly mcpConfigPath?: string,
  ) {
    super();
    this.runner = runner ?? new CliSessionRunner(sessionId);
  }

  /** Resolve the per-project task backend, preferring the test override when present. */
  private taskBackend(): TaskBackend {
    return this.taskBackendOverride ?? getTaskBackend(this.projectId);
  }

  async run(): Promise<void> {
    this.broadcast({
      type: 'session_status',
      sessionId: this.sessionId,
      status: 'running',
    });
    updateSessionStatus(this.sessionId, 'running');

    const initialPrompt =
      this.customPrompt ??
      `
You are a Claude Code session managed by Claude Code Orchestrator.

## Task
Task page: ${this.taskUrl}

Read CLAUDE.md in the repo root — it contains the full task spec and all rules.
Begin implementing the task immediately. Do NOT fetch Notion pages.

## Lifecycle
1. Read CLAUDE.md for the task spec, orchestrator rules, and project conventions.
2. Create a feature branch from the project's base branch.
3. Implement the task per the acceptance criteria in the Task Spec section of CLAUDE.md.
4. Pass the pre-PR gate as specified in CLAUDE.md.
5. Open a draft PR as specified in CLAUDE.md.
6. After the PR is open, WAIT. Do not merge.
   The dashboard will send review feedback as follow-up messages.
   Address findings by pushing additional commits, then wait again.

## What the dashboard handles (do NOT do these yourself)
- Task status updates — the backend manages these.
- PR review — automated after you publish the PR.

## Rules
- One task per session. No scope creep.
- Never commit to the base branch directly.
- Never merge your own PR.
- Never fetch Notion pages — the task spec is already in CLAUDE.md.
`.trim();

    // Backoff schedule for transient API errors: 5s, 10s, 20s, 40s, 80s (5 attempts).
    const BACKOFF_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 80_000];
    // resumeIdForSpawn: undefined on first run, set to this.sessionId on each retry.
    let resumeIdForSpawn: string | undefined = this.resumeSessionId;

    const modelSetting =
      this.sessionType === 'review'
        ? runtimeSettings.review_session_model
        : runtimeSettings.code_session_model;

    // Per-iteration overrides set by tryEscalateForOverflow() (T3b).
    // Instance fields _escalationModel and _escalationDisableAutoCompact hold these
    // so they're accessible from the helper without parameter threading.

    // Loop is exited by an explicit return on every terminal path: clean exit,
    // kill/spawn error, or non-transient failure. Only a transient API error
    // continues to the next iteration to retry with backoff.

    while (true) {
      // Clear per-run pending tool-call maps so stale IDs from a previous run
      // do not interfere with the retried transport's tool events.
      if (resumeIdForSpawn === this.sessionId) {
        this.pendingGHToolUseIds.clear();
        this.pendingBashCommands.clear();
        this.pendingPushFileToolUseIds.clear();
      }

      sessionLog(
        this.sessionId,
        `starting session: runner=${this.runner.constructor.name} worktree=${this.worktreePath}`,
      );

      const exitCode = await this.runner.run(
        resumeIdForSpawn ? undefined : initialPrompt,
        resumeIdForSpawn,
        {
          worktreePath: this.worktreePath,
          model: this._escalationModel ?? (modelSetting || undefined),
          allowedTools: [...ALLOWED_TOOLS, ...this.extraAllowedTools],
          systemPrompt: this.systemPromptContent,
          mcpConfigPath: this.mcpConfigPath,
          disableAutoCompact:
            this._escalationDisableAutoCompact !== null
              ? this._escalationDisableAutoCompact
              : !!runtimeSettings.large_task_model,
        },
        (event) => this.handleRawEvent(event),
      );

      if (
        this.runner.hasSpawnError ||
        this.isKilling ||
        this.isPausingForShutdown
      )
        return;

      // Check overflow FIRST — clean exit must not bypass escalation.
      if (await this.tryEscalateForOverflow()) {
        resumeIdForSpawn = this.sessionId;
        continue;
      }

      // Overflow detected but escalation not possible (no model or already on it)
      // — error the session regardless of exit code.
      if (this.contextOverflowDetected) {
        if (!this.hasEnded) {
          this.sessionManager?.markSessionErrored?.(
            this.sessionId,
            'error',
            'context_overflow',
          );
          if (!this.hasEnded) {
            updateSessionStatus(this.sessionId, 'error', Date.now());
            this.broadcast({
              type: 'session_ended',
              sessionId: this.sessionId,
              status: 'error',
              ...(this.taskId && { taskId: this.taskId }),
            });
          }
        }
        return;
      }

      if (exitCode === 0) {
        this.retryCount = 0;
        await this.handleCleanExit();
        return;
      }

      // Non-zero exit — check whether this is a transient Anthropic API error
      // (500 api_error or 529 overloaded_error). If so, retry with exponential backoff
      // using --resume to restore conversation history. Non-transient errors (bad config,
      // permission issues, etc.) fall through to permanent error immediately.
      if (
        this.retryCount < BACKOFF_DELAYS_MS.length &&
        this.isTransientApiError()
      ) {
        const delay = BACKOFF_DELAYS_MS[this.retryCount];
        this.retryCount++;
        sessionLog(
          this.sessionId,
          `transient API error — retry ${this.retryCount}/${BACKOFF_DELAYS_MS.length} after ${delay}ms`,
        );
        this.broadcast({
          type: 'session_status',
          sessionId: this.sessionId,
          status: 'retrying',
        });
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        if (this.isKilling || this.isPausingForShutdown) return;
        resumeIdForSpawn = this.sessionId;
        this.broadcast({
          type: 'session_status',
          sessionId: this.sessionId,
          status: 'running',
        });
      } else {
        const status = exitCode === null ? 'killed' : 'error';
        const reason =
          exitCode === null ? 'runner_killed_unexpected' : 'runner_non_zero';
        if (!this.hasEnded) {
          this.sessionManager?.markSessionErrored?.(
            this.sessionId,
            status,
            reason,
          );
          if (!this.hasEnded) {
            // Fallback when sessionManager is absent (e.g. unit tests without a manager)
            updateSessionStatus(this.sessionId, status, Date.now());
            this.broadcast({
              type: 'session_ended',
              sessionId: this.sessionId,
              status,
              ...(this.taskId && { taskId: this.taskId }),
            });
          }
        }
        return;
      }
    }
  }

  /**
   * Return true if the session's last DB event is an error event whose payload
   * contains a transient Anthropic API error type (api_error = 500,
   * overloaded_error = 529). These are the only error types we should retry.
   * Non-transient types (authentication_error, invalid_request_error,
   * permission_error) return false so they fail permanently.
   */
  private isTransientApiError(): boolean {
    const events = getEventsBySession(this.sessionId);
    if (events.length === 0) return false;
    const lastEvent = events[events.length - 1];
    if (eventKind(lastEvent) !== 'error') return false;
    const payload = lastEvent.payload.toLowerCase();
    return (
      payload.includes('api_error') || payload.includes('overloaded_error')
    );
  }

  /**
   * Called when a transient API error (529/500) is detected in a live session
   * that has not exited. Pauses the session immediately without auto-retry since
   * there is no --resume target while the CLI process is still running.
   */
  private handleInSessionApiError(): void {
    if (this.inSessionApiErrorFired) return;
    this.inSessionApiErrorFired = true;

    const pr = getPRBySessionId(this.sessionId);
    if (pr) {
      setPauseReason(pr.pr_number, pr.repo, 'api_overloaded');
    }
    insertPauseInterval(this.sessionId, 'api_overloaded');

    const pauseMessage =
      'The Anthropic API returned a 529 Overloaded or 500 error mid-session. ' +
      'This session has been paused. Please wait for the API to recover and then ' +
      'manually resume the session.';

    if (this.sessionManager) {
      try {
        this.sessionManager.send(this.sessionId, pauseMessage);
      } catch (err) {
        logger.warn(
          `[AgentSession] send failed for ${this.sessionId}: ${(err as Error).message}`,
        );
      }
    }

    this.broadcast({
      type: 'api_overloaded_paused',
      sessionId: this.sessionId,
      ...(pr ? { prNumber: pr.pr_number, repo: pr.repo } : {}),
    });
  }

  /**
   * Process a single raw JSON event from the session transport.
   * This is called for each event by both CliSessionRunner and ApiSessionRunner.
   */
  private handleRawEvent(event: Record<string, unknown>): void {
    // Deliver escalation nudge on the first event from the restarted session
    if (this._pendingEscalationNudge !== null) {
      const nudge = this._pendingEscalationNudge;
      this._pendingEscalationNudge = null;
      this.runner.sendMessage(nudge);
    }

    const rawType = (event.type as string) ?? 'unknown';

    // Debug logging
    sessionLog(
      this.sessionId,
      `event type=${rawType} subtype=${event.subtype ?? '-'}`,
    );

    if (rawType === 'system' && (event.subtype as string) === 'init') {
      sessionLog(this.sessionId, `INIT permissionMode=${event.permissionMode}`);
    }

    if (
      rawType === 'system' &&
      (event.subtype as string) === 'compact_boundary'
    ) {
      this.compactionCount++;
      incrementCompactionCount(this.sessionId);
      this.broadcast({
        type: 'session_updated',
        sessionId: this.sessionId,
        compactionCount: this.compactionCount,
      });
    }

    // ai-title: persist as session metadata only, no session event
    if (rawType === 'ai-title') {
      if (typeof event.aiTitle === 'string') {
        setSessionMetadata(this.sessionId, { aiTitle: event.aiTitle });
      }
      return;
    }

    // Silent-skip types: known but produce no session event
    if (SILENT_SKIP_TYPES.has(rawType)) {
      return;
    }

    // Log truly unknown types so they're diagnosable; still store as 'system'
    if (!VALID_EVENT_TYPES.has(rawType)) {
      sessionLog(
        this.sessionId,
        `unknown event type "${rawType}" — storing as system`,
      );
    }

    // Extract model name from first assistant event
    if (rawType === 'assistant' && this.model === null && event.message) {
      const msgForModel = event.message as Record<string, unknown>;
      if (typeof msgForModel.model === 'string' && msgForModel.model) {
        this.model = msgForModel.model;
        setSessionModel(this.sessionId, this.model);
        this.broadcast({
          type: 'session_updated',
          sessionId: this.sessionId,
          model: this.model,
        });
      }
    }

    // Log tool_use blocks from assistant messages and track PR creation tool calls
    if (rawType === 'assistant' && event.message) {
      const msg = event.message as Record<string, unknown>;
      const content = msg.content as Array<Record<string, unknown>> | undefined;
      if (content) {
        for (const block of content) {
          if (block.type === 'tool_use') {
            sessionLog(
              this.sessionId,
              `TOOL_USE name=${block.name} id=${block.id}`,
            );
            if (
              block.name === 'mcp__github__create_pull_request' &&
              typeof block.id === 'string'
            ) {
              this.pendingGHToolUseIds.set(block.id, block.name as string);
            }
            if (block.name === 'Bash' && typeof block.id === 'string') {
              const cmd =
                ((block.input as Record<string, unknown>)?.command as string) ??
                '';
              this.pendingBashCommands.set(block.id, cmd);
            }
            if (
              block.name === 'mcp__github__push_files' &&
              typeof block.id === 'string'
            ) {
              this.pendingPushFileToolUseIds.add(block.id);
            }

            // In-flight worktree-escape detection: warn and continue.
            if (this.worktreePath && typeof block.name === 'string') {
              const toolUseId =
                typeof block.id === 'string' ? block.id : undefined;
              const alreadyWarned =
                toolUseId != null && this.warnedEscapeToolUseIds.has(toolUseId);
              if (!alreadyWarned) {
                const input = (block.input ?? {}) as Record<string, unknown>;
                const escape = detectInFlightEscape(
                  block.name,
                  input,
                  this.worktreePath,
                );
                if (escape) {
                  if (toolUseId != null)
                    this.warnedEscapeToolUseIds.add(toolUseId);
                  sessionLog(
                    this.sessionId,
                    `worktree_escape detected in-flight: ${escape.tool} → ${escape.path}`,
                  );
                  this.sendMessage(
                    `⚠️ Worktree escape detected: \`${escape.tool}\` is writing to \`${escape.path}\` which is outside your assigned worktree (\`${this.worktreePath}\`). Please only write files inside the worktree.`,
                  );
                }
              }
            }
          }
        }
      }
    }

    // Real-time PR detection: handle tool_result events for mcp__github__create_pull_request
    // Also detect git push for push_detected event.
    if (rawType === 'tool_result') {
      const toolUseId = event.tool_use_id as string | undefined;
      if (toolUseId && this.pendingGHToolUseIds.has(toolUseId)) {
        this.pendingGHToolUseIds.delete(toolUseId);
        const content = event.content as
          | Array<Record<string, unknown>>
          | undefined;
        void this.handlePRCreatedFromContent(content ?? []);
      }
      if (toolUseId && this.pendingPushFileToolUseIds.has(toolUseId)) {
        this.pendingPushFileToolUseIds.delete(toolUseId);
        void this.handlePushDetected();
      }
      if (toolUseId && this.pendingBashCommands.has(toolUseId)) {
        const cmd = this.pendingBashCommands.get(toolUseId)!;
        this.pendingBashCommands.delete(toolUseId);
        if (isPushCommand('Bash', cmd)) {
          void this.handlePushDetected();
        }
        if (isPRCreateCommand('Bash', cmd) && !this.prDetectedLive) {
          const text = extractTextFromToolResultEvent(event);
          void this.handlePRCreatedFromBashOutput(text);
        }
      }
    }

    // Also handle tool_result blocks embedded in user events
    if (rawType === 'user' && !this.prDetectedLive) {
      const msg = event.message as Record<string, unknown> | undefined;
      const content = (msg?.content ?? event.content) as
        | Array<Record<string, unknown>>
        | undefined;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            const toolUseId = block.tool_use_id as string | undefined;
            if (toolUseId && this.pendingGHToolUseIds.has(toolUseId)) {
              this.pendingGHToolUseIds.delete(toolUseId);
              const innerContent = block.content as
                | Array<Record<string, unknown>>
                | undefined;
              void this.handlePRCreatedFromContent(innerContent ?? []);
            }
            if (toolUseId && this.pendingBashCommands.has(toolUseId)) {
              const cmd = this.pendingBashCommands.get(toolUseId)!;
              this.pendingBashCommands.delete(toolUseId);
              if (isPRCreateCommand('Bash', cmd) && !this.prDetectedLive) {
                const innerText = extractTextFromToolResultEvent(block);
                void this.handlePRCreatedFromBashOutput(innerText);
              }
            }
          }
        }
      }
    }

    // Extract permission_denials from result event and broadcast to UI.
    // Also signal turn completion so the server can check for new commits.
    if (rawType === 'result') {
      const pr = getPRBySessionId(this.sessionId);
      if (pr?.review_session_id) {
        sessionLog(
          this.sessionId,
          `turn complete — PR #${pr.pr_number} has review session, signalling push_detected`,
        );
        void this.handlePushDetected();
      }

      const denials = event.permission_denials as
        | PermissionDenial[]
        | undefined;
      sessionLog(
        this.sessionId,
        `RESULT stop_reason=${event.stop_reason} denials=${JSON.stringify(denials)}`,
      );
      if (denials && denials.length > 0) {
        const ts = Date.now();
        for (const d of denials) {
          insertPermissionDenial({
            session_id: this.sessionId,
            tool_name: d.tool_name,
            tool_use_id: d.tool_use_id,
            tool_input: JSON.stringify(d.tool_input),
            timestamp: ts,
          });
        }
        this.broadcast({
          type: 'permission_denials',
          sessionId: this.sessionId,
          denials,
        });
      }

      // Detect context overflow before the session exits (or mid-session).
      if (!this.contextOverflowDetected && isContextOverflow(event)) {
        this.contextOverflowDetected = true;
        sessionLog(this.sessionId, 'context overflow detected');
        this.broadcast({
          type: 'context_overflow_detected',
          sessionId: this.sessionId,
        });
        // The 'prompt is too long' variant (is_error=true) causes the CLI to emit
        // the error result then hang waiting for more stdin input.  Close stdin now
        // so the subprocess exits and runner.run() returns, allowing the escalation
        // path to fire.
        if (event.is_error === true) {
          this.runner.endSession();
        }
      }
    }

    // Persist event to SQLite then broadcast
    const eventType = toEventType(rawType);
    let payload = JSON.stringify(event);

    // Extract message ID from assistant/message events for deduplication.
    // The Claude CLI emits multiple incremental streaming events per message,
    // all sharing the same message.id. We keep only the latest payload.
    let messageId: string | undefined;
    if (rawType === 'assistant' || rawType === 'message') {
      const msg = event.message as Record<string, unknown> | undefined;
      if (msg?.id && typeof msg.id === 'string') {
        messageId = msg.id;
      }
    }

    // Merge content blocks for assistant events: accumulate text and tool_use
    // across all streaming events for this message so neither is dropped.
    if (
      messageId != null &&
      (rawType === 'assistant' || rawType === 'message')
    ) {
      const msg = event.message as Record<string, unknown> | undefined;
      if (msg && Array.isArray(msg.content)) {
        const incomingContent = msg.content as Array<Record<string, unknown>>;
        const existingContent = this.messageContentMap.get(messageId) ?? [];
        const mergedContent = mergeAssistantContent(
          existingContent,
          incomingContent,
        );
        this.messageContentMap.set(messageId, mergedContent);
        payload = JSON.stringify({
          ...event,
          message: { ...msg, content: mergedContent },
        });

        // Detect <pr-body>…</pr-body> marker emitted by the session.
        // Guard by message ID so streaming chunks don't trigger multiple times.
        if (!this.processedPRBodyMessageIds.has(messageId)) {
          const accumulatedText = mergedContent
            .filter((b) => b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text as string)
            .join('');
          const markerMatch = accumulatedText.match(PR_BODY_MARKER_REGEX);
          if (markerMatch) {
            this.processedPRBodyMessageIds.add(messageId);
            this.prBodyMarkerPromise = this.handlePRBodyMarker(
              markerMatch[1].trim(),
            );
          }
        }
      }
    }

    const existingRowId =
      messageId != null ? this.messageIdMap.get(messageId) : undefined;
    const rowId = upsertSessionEvent(
      {
        session_id: this.sessionId,
        event_type: eventType,
        payload,
        timestamp: Date.now(),
        message_id: messageId ?? null,
      },
      existingRowId,
    );
    if (messageId != null) {
      this.messageIdMap.set(messageId, rowId);
    }

    // On each assistant text event, update live context occupancy so the
    // frontend can display it during long single-turn sessions that emit no
    // result events until the very end.
    if (rawType === 'assistant' || rawType === 'message') {
      const msg = event.message as
        | {
            usage?: {
              input_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
          }
        | undefined;
      const usage = msg?.usage;
      if (usage) {
        const occupancy =
          (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0);
        if (occupancy > 0) {
          setContextOccupancy(this.sessionId, occupancy);
          this.broadcast({
            type: 'session_updated',
            sessionId: this.sessionId,
            totalInputTokens: this.totalInputTokens,
            totalOutputTokens: this.totalOutputTokens,
            contextOccupancyTokens: occupancy,
            contextOccupancyFraction:
              occupancy / AgentSession.contextWindowForModel(this.model),
          });
        }
      }
    }

    // After each result event (one per turn), update token counters and broadcast
    // session_updated so the frontend receives live totals during execution.
    // NOTE: do NOT call setContextOccupancy here — result.usage.cache_read_input_tokens
    // is the SUM across every API call in the turn (cumulative), not a single-call
    // prompt size, so it would produce wildly inflated occupancy values. The
    // assistant-event handler above keeps context_occupancy_tokens correct.
    if (rawType === 'result') {
      const usageData = event.usage as
        | { input_tokens?: number; output_tokens?: number }
        | undefined;
      const inputTokens = usageData?.input_tokens ?? 0;
      const outputTokens = usageData?.output_tokens ?? 0;
      if (inputTokens > 0 || outputTokens > 0) {
        this.totalInputTokens += inputTokens;
        this.totalOutputTokens += outputTokens;
        incrementTokens(this.sessionId, inputTokens, outputTokens);
      }
      this.broadcast({
        type: 'session_updated',
        sessionId: this.sessionId,
        totalInputTokens: this.totalInputTokens,
        totalOutputTokens: this.totalOutputTokens,
      });
    }

    // Skip broadcasting user events that contain only system-injected content
    // (CLAUDE.md bootstrap, system reminders). They are stored in DB for debugging
    // but are noise in the transcript UI.
    if (rawType === 'user' && isSystemOnlyUserEvent(payload)) {
      return;
    }

    this.broadcast({
      type: 'session_event',
      sessionId: this.sessionId,
      eventType: eventKind({ event_type: eventType, payload }),
      content: payload,
      ...(messageId != null && { messageId }),
    });

    // Detect in-session transient API error (529/500) in a live session.
    // The CLI may surface these without exiting, so the normal exit-based retry
    // path never fires. Pause immediately instead.
    if (rawType === 'error' && this.isTransientApiError()) {
      this.handleInSessionApiError();
    }
  }

  /**
   * Parse PR data from the content blocks of a mcp__github__create_pull_request tool_result,
   * upsert the PR to SQLite with full metadata, and broadcast pr_created.
   */
  private async handlePRCreatedFromContent(
    contentBlocks: Array<Record<string, unknown>>,
  ): Promise<void> {
    if (this.prDetectedLive) return;

    let text = '';
    for (const block of contentBlocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        text += block.text;
      }
    }

    let prShape: GitHubPRShape = {};
    try {
      const parsed = JSON.parse(text) as GitHubPRShape;
      if (parsed && typeof parsed === 'object' && parsed.html_url) {
        prShape = parsed;
      }
    } catch {
      // Not JSON — fall back to regex extraction of URL only
    }

    const prUrl = prShape.html_url ?? text.match(PR_URL_REGEX)?.[0];
    if (!prUrl) return;
    await this.handlePRDetected(prUrl, prShape);
  }

  /**
   * Extract the PR URL from the stdout of a `gh pr create` Bash invocation
   * and upsert the PR row (without full GitHub API metadata).
   */
  private async handlePRCreatedFromBashOutput(text: string): Promise<void> {
    if (this.prDetectedLive) return;

    let prShape: GitHubPRShape = {};
    try {
      const parsed = JSON.parse(text) as GitHubPRShape;
      if (parsed && typeof parsed === 'object') {
        // gh pr create --json url emits {"url":"..."}, MCP shape uses html_url
        const resolvedUrl = parsed.html_url ?? parsed.url;
        if (resolvedUrl) {
          prShape = { ...parsed, html_url: resolvedUrl };
        }
      }
    } catch {
      // Not JSON — fall back to regex
    }

    const prUrl = prShape.html_url ?? text.match(PR_URL_REGEX)?.[0];
    if (!prUrl) return;
    await this.handlePRDetected(prUrl, prShape);
  }

  /**
   * Handle a <pr-body>…</pr-body> marker emitted by the session.
   * Validates the body, then either creates a new PR or updates an existing one.
   * Invalid body → re-prompts the session over stdin; no PR opened.
   */
  private async handlePRBodyMarker(body: string): Promise<void> {
    if (!this.githubClient) {
      sessionLog(
        this.sessionId,
        '<pr-body> marker found but githubClient not configured — skipping',
      );
      return;
    }

    // Validate before creating — invalid body re-prompts; no PR opened.
    const validation = validatePRBody(body);
    if (!validation.valid) {
      sessionLog(
        this.sessionId,
        `PR creation failed: validation — missing required sections: ${validation.missingSections.join(', ')}`,
      );
      const missing = validation.missingSections
        .map((s) => `\`${s}\``)
        .join(', ');
      this.sendMessage(
        `The PR body is missing required sections: ${missing}.\n\n` +
          `Please fix the body and re-emit it inside a <pr-body>…</pr-body> marker ` +
          `in your next message. All four sections must be present: ` +
          `\`## Summary\`, task-source section, \`## Automated Tests\`, \`## Files Changed\`.`,
      );
      return;
    }

    // Check for an existing PR for this session (idempotent update path).
    const existingPR = getPRBySessionId(this.sessionId);
    if (existingPR) {
      sessionLog(
        this.sessionId,
        `<pr-body> marker — updating body of existing PR #${existingPR.pr_number}`,
      );
      try {
        await this.githubClient.updatePR(
          existingPR.repo,
          existingPR.pr_number,
          {
            body,
          },
        );
        recordEvent({
          event_type: 'pr_body_updated_via_marker',
          actor_type: 'ai',
          actor_id: this.sessionId,
          project_id: this.projectId || null,
          task_id: this.taskId || null,
          payload: { pr_number: existingPR.pr_number, repo: existingPR.repo },
        });
      } catch (e) {
        logger.warn(
          `[AgentSession] updatePR #${existingPR.pr_number} failed: ${(e as Error).message}`,
        );
      }
      return;
    }

    // No existing PR — create one.
    sessionLog(this.sessionId, '<pr-body> marker — creating PR via REST');

    let baseBranch = 'dev';
    try {
      baseBranch = getProjectById(this.projectId)?.baseBranch ?? 'dev';
    } catch {
      // project lookup failed — keep 'dev' default
    }

    let branch: string;
    let repo: string;
    try {
      branch = execSync('git branch --show-current', {
        cwd: this.worktreePath,
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();

      const remoteUrl = execSync('git remote get-url origin', {
        cwd: this.worktreePath,
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();
      const repoMatch = remoteUrl.match(
        /github\.com[:/]([^/]+\/[^.]+?)(?:\.git)?$/,
      );
      repo = repoMatch ? repoMatch[1] : GITHUB_REPO;
    } catch (e) {
      sessionLog(
        this.sessionId,
        `PR creation failed: could not read git info — ${(e as Error).message}`,
      );
      return;
    }

    if (!branch) {
      sessionLog(
        this.sessionId,
        `PR creation failed: detached HEAD — no current branch. Run git checkout -b feature/<task-name> first.`,
      );
      recordEvent({
        event_type: 'pr_creation_failed',
        actor_type: 'system',
        actor_id: this.sessionId,
        project_id: this.projectId || null,
        task_id: this.taskId || null,
        payload: {
          stage: 'branch',
          error: 'detached HEAD — no current branch',
        },
      });
      this.sendMessage(
        `The worktree is in detached HEAD state — there is no current branch, so I cannot open a PR.\n\n` +
          `Please run \`git checkout -b feature/<task-name>\` to create a branch, then re-emit the ` +
          `\`<pr-body>\` marker so I can push and open the PR.`,
      );
      return;
    }

    // Push the branch to origin so GitHub can find it when createPR is called.
    // Re-pushing an already-current branch is a harmless fast-forward no-op.
    try {
      execSync(`git push -u origin ${branch}`, {
        cwd: this.worktreePath,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch (e) {
      const msg = (e as Error).message;
      sessionLog(
        this.sessionId,
        `PR creation failed: git push of branch "${branch}" to origin rejected — ${msg.slice(0, 200)}`,
      );
      logger.error(
        `[AgentSession] git push for <pr-body> marker failed: ${msg}`,
      );
      recordEvent({
        event_type: 'pr_creation_failed',
        actor_type: 'system',
        actor_id: this.sessionId,
        project_id: this.projectId || null,
        task_id: this.taskId || null,
        payload: { stage: 'push', error: msg },
      });
      // Bounded retry: derive count from persisted events so it survives re-prompts.
      // The event recorded above is already included, so priorCount >= 1 here.
      const priorCount = countPushFailureEvents(this.sessionId);
      const PUSH_RETRY_LIMIT = 2;
      if (priorCount <= PUSH_RETRY_LIMIT) {
        this.sendMessage(
          `I couldn't push your branch \`${branch}\` to origin (${msg}). ` +
            `Please run \`git push -u origin ${branch}\` yourself, then re-emit the ` +
            `\`<pr-body>\` marker so I can open the PR.`,
        );
      } else {
        setSessionPauseReason(this.sessionId, 'pr_creation_failed');
      }
      return;
    }

    const taskName = branch.replace(/^feature\//, '');
    const title = `feat: ${taskName}`;

    await this.createPRWithRetry(
      repo,
      { title, body, head: branch, base: baseBranch },
      branch,
    );
  }

  private async createPRWithRetry(
    repo: string,
    params: { title: string; body: string; head: string; base: string },
    branch: string,
  ): Promise<void> {
    const MAX_ATTEMPTS = 3;
    const BACKOFF_MS = [2000, 4000, 8000];

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const created = await this.githubClient!.createPR(repo, {
          ...params,
          draft: true,
        });

        const prShape: GitHubPRShape = {
          number: created.number,
          html_url: created.html_url,
          title: created.title,
          body: created.body,
          head: { ref: created.head.ref, sha: created.head.sha },
          base: { ref: created.base.ref },
          state: created.state,
          created_at: created.created_at,
          updated_at: created.updated_at,
          draft: created.draft,
        };

        await this.handlePRDetected(created.html_url, prShape);
        sessionLog(
          this.sessionId,
          `PR creation succeeded: PR #${created.number} at ${created.html_url}`,
        );
        return;
      } catch (e) {
        const msg = (e as Error).message;

        // 422 "A pull request already exists" → divert to update path.
        if (/422/.test(msg) && /pull request already exists/i.test(msg)) {
          const existingPR = getPRBySessionId(this.sessionId);
          const parsedNum = extractPRNumberFromError(msg);
          const existingNum = existingPR?.pr_number ?? parsedNum;
          sessionLog(
            this.sessionId,
            `PR creation failed: duplicate PR on branch "${branch}" (existing PR #${existingNum ?? '?'}). ` +
              `If the existing PR is stale, the operator must close it before this session can create a new one.`,
          );
          if (existingPR) {
            try {
              await this.githubClient!.updatePR(
                existingPR.repo,
                existingPR.pr_number,
                {
                  body: params.body,
                },
              );
            } catch (ue) {
              logger.warn(
                `[AgentSession] updatePR fallback #${existingPR.pr_number} failed: ${(ue as Error).message}`,
              );
            }
          }
          return;
        }

        // 422 "head branch not found" → divert to push-failure path.
        if (/422/.test(msg) && /head.*not found|head branch/i.test(msg)) {
          sessionLog(
            this.sessionId,
            `PR creation failed: branch "${branch}" not found on origin — GitHub rejected the head ref. Did the prior push step succeed?`,
          );
          logger.error(
            `[AgentSession] createPR 422 head-not-found — diverting to push-failure path: ${msg}`,
          );
          recordEvent({
            event_type: 'pr_creation_failed',
            actor_type: 'system',
            actor_id: this.sessionId,
            project_id: this.projectId || null,
            task_id: this.taskId || null,
            payload: { stage: 'push', error: msg },
          });
          const priorCount = countPushFailureEvents(this.sessionId);
          const PUSH_RETRY_LIMIT = 2;
          if (priorCount <= PUSH_RETRY_LIMIT) {
            this.sendMessage(
              `I couldn't push your branch \`${branch}\` to origin (${msg}). ` +
                `Please run \`git push -u origin ${branch}\` yourself, then re-emit the ` +
                `\`<pr-body>\` marker so I can open the PR.`,
            );
          } else {
            setSessionPauseReason(this.sessionId, 'pr_creation_failed');
          }
          return;
        }

        // Any other 422 is a terminal client error — don't retry.
        if (/422/.test(msg)) {
          sessionLog(
            this.sessionId,
            `PR creation failed: GitHub 422 client error — ${msg.slice(0, 300)}`,
          );
          logger.error(`[AgentSession] createPR terminal 422: ${msg}`);
          recordEvent({
            event_type: 'pr_creation_failed',
            actor_type: 'system',
            actor_id: this.sessionId,
            project_id: this.projectId || null,
            task_id: this.taskId || null,
            payload: { stage: 'create', error: msg },
          });
          setSessionPauseReason(this.sessionId, 'pr_creation_failed');
          return;
        }

        // 404 — branch or repo not found on GitHub.
        if (/\b404\b/.test(msg)) {
          sessionLog(
            this.sessionId,
            `PR creation failed: branch "${branch}" not found on origin (GitHub 404). Did the prior push step succeed?`,
          );
          logger.error(`[AgentSession] createPR 404 not-found: ${msg}`);
          recordEvent({
            event_type: 'pr_creation_failed',
            actor_type: 'system',
            actor_id: this.sessionId,
            project_id: this.projectId || null,
            task_id: this.taskId || null,
            payload: { stage: 'create', error: msg },
          });
          setSessionPauseReason(this.sessionId, 'pr_creation_failed');
          return;
        }

        // 401/403 auth errors — terminal, never retry.
        if (/\b40[13]\b/.test(msg)) {
          sessionLog(
            this.sessionId,
            `PR creation failed: GitHub auth/permission denied (${msg.slice(0, 200)}). Check GITHUB_TOKEN scope.`,
          );
          logger.error(`[AgentSession] createPR auth error: ${msg}`);
          recordEvent({
            event_type: 'pr_creation_failed',
            actor_type: 'system',
            actor_id: this.sessionId,
            project_id: this.projectId || null,
            task_id: this.taskId || null,
            payload: { stage: 'create', error: msg },
          });
          setSessionPauseReason(this.sessionId, 'pr_creation_failed');
          return;
        }

        // Transient error (5xx / network / timeout / fetch) — retry with backoff.
        const isTransient =
          /5\d\d/.test(msg) ||
          /ECONNRESET|ETIMEDOUT|ENOTFOUND|network|socket|timeout|fetch failed/i.test(
            msg,
          );

        if (!isTransient || attempt === MAX_ATTEMPTS - 1) {
          sessionLog(
            this.sessionId,
            `PR creation failed with unexpected error: ${msg.slice(0, 300)}`,
          );
          logger.error(
            `[AgentSession] createPR via <pr-body> marker failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${msg}`,
          );
          recordEvent({
            event_type: 'pr_creation_failed',
            actor_type: 'system',
            actor_id: this.sessionId,
            project_id: this.projectId || null,
            task_id: this.taskId || null,
            payload: { stage: 'create', error: msg },
          });
          setSessionPauseReason(this.sessionId, 'pr_creation_failed');
          return;
        }

        sessionLog(
          this.sessionId,
          `PR creation failed: GitHub server error (transient, attempt ${attempt + 1}/${MAX_ATTEMPTS}). Retrying in ${BACKOFF_MS[attempt]}ms.`,
        );
        logger.warn(
          `[AgentSession] createPR transient error (attempt ${attempt + 1}/${MAX_ATTEMPTS}), retrying in ${BACKOFF_MS[attempt]}ms: ${msg}`,
        );
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
      }
    }
  }

  /**
   * Core PR detection: upsert the pull_requests row, broadcast pr_created,
   * and emit the pr_opened event. Shared by MCP and Bash detection paths.
   */
  private async handlePRDetected(
    prUrl: string,
    prShape: GitHubPRShape,
  ): Promise<void> {
    if (this.prDetectedLive) return;

    const repoMatch = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (!repoMatch) return;

    const repo = repoMatch[1];
    const prNumber = prShape.number ?? parseInt(repoMatch[2], 10);
    const now = new Date().toISOString();

    this.prUrl = prUrl;
    this.prDetectedLive = true;

    if (this.taskId) resetTaskCrashCount(this.taskId);

    let upsertSucceeded = true;
    if (this.sessionType === 'standard') {
      this.taskBackend()
        .attachPR(this.taskId, prUrl)
        .catch((e) => logger.error(`[AgentSession] attachPR failed: ${e}`));

      const upsertResult = upsertPullRequest({
        pr_number: prNumber,
        pr_url: prUrl,
        task_id: this.taskId,
        session_id: this.sessionId,
        repo,
        title: prShape.title ?? null,
        body: prShape.body ?? null,
        head_branch: prShape.head?.ref ?? null,
        base_branch: prShape.base?.ref ?? null,
        state: prShape.state ?? 'open',
        draft: prShape.draft ? 1 : 0,
        review_result: null,
        review_at: null,
        created_at: prShape.created_at ?? now,
        updated_at: prShape.updated_at ?? now,
        synced_at: now,
        node_id: null,
        head_sha: prShape.head?.sha ?? null,
        conflict_nudge_sha: null,
      });
      if (upsertResult === null) {
        // Repo not configured — no PR row written. Skip pr_created broadcast
        // and pr_opened emit so StuckSessionMonitor sees no PR row and routes
        // correctly (idle, not done) when the subprocess is still alive.
        logger.warn(
          `[AgentSession] handlePRDetected: upsertPullRequest rejected for repo "${repo}" — skipping pr_created broadcast`,
        );
        upsertSucceeded = false;
      }

      // If head_sha or body was missing from the tool response (live-detection path
      // where gh pr create does not include body in its stream output), fetch the
      // full PR from GitHub for accurate head_sha backfill and/or body validation.
      const needsHeadSha = !prShape.head?.sha;
      const needsBodyValidation = !prShape.body;
      if ((needsHeadSha || needsBodyValidation) && this.githubClient) {
        const ghClient = this.githubClient;
        void (async () => {
          try {
            const freshPR = await ghClient.fetchPR(repo, prNumber);
            if (needsHeadSha && freshPR.headSha) {
              setHeadSha(prNumber, repo, freshPR.headSha);
            }
            if (needsBodyValidation) {
              const bodyValidation = validatePRBody(freshPR.body);
              if (!bodyValidation.valid) {
                const isCorporate = runtimeSettings.corporate_mode_enabled;
                recordEvent({
                  event_type: isCorporate
                    ? 'pr_body_invalid'
                    : 'pr_body_invalid_warning',
                  actor_type: 'ai',
                  actor_id: this.sessionId,
                  project_id: this.projectId || null,
                  task_id: this.taskId || null,
                  payload: {
                    pr_number: prNumber,
                    repo,
                    missing_sections: bodyValidation.missingSections,
                  },
                });
                if (isCorporate) {
                  setPauseReason(prNumber, repo, 'pr_body_invalid');
                  const comment = buildValidationComment(
                    bodyValidation.missingSections,
                  );
                  void ghClient
                    .createIssueComment(repo, prNumber, comment)
                    .catch((e) =>
                      logger.warn(
                        `[AgentSession] createIssueComment failed: ${e}`,
                      ),
                    );
                }
              }
            }
          } catch (e) {
            logger.warn(
              `[AgentSession] handlePRDetected: failed to fetch PR #${prNumber}:`,
              e,
            );
            if (needsBodyValidation) {
              logger.warn(
                `[AgentSession] handlePRDetected: skipping PR body validation for PR #${prNumber} — GitHub fetch failed (fail-open)`,
              );
            }
          }
        })();
      }

      // Validate PR body against required template (marker path: body present at detection time).
      if (prShape.body) {
        const bodyValidation = validatePRBody(prShape.body);
        if (!bodyValidation.valid) {
          const isCorporate = runtimeSettings.corporate_mode_enabled;
          recordEvent({
            event_type: isCorporate
              ? 'pr_body_invalid'
              : 'pr_body_invalid_warning',
            actor_type: 'ai',
            actor_id: this.sessionId,
            project_id: this.projectId || null,
            task_id: this.taskId || null,
            payload: {
              pr_number: prNumber,
              repo,
              missing_sections: bodyValidation.missingSections,
            },
          });
          if (isCorporate) {
            setPauseReason(prNumber, repo, 'pr_body_invalid');
            if (this.githubClient) {
              const ghClient = this.githubClient;
              const comment = buildValidationComment(
                bodyValidation.missingSections,
              );
              void ghClient
                .createIssueComment(repo, prNumber, comment)
                .catch((e) =>
                  logger.warn(
                    `[AgentSession] createIssueComment failed: ${e}`,
                  ),
                );
            }
          }
        }
      }

      // File pollution check + auto-revert runs inline so AutoMerger never
      // sees a contaminated diff (must complete before pr_created WS broadcast).
      if (this.githubClient) {
        await this.runFilePollutionCheck(
          repo,
          prNumber,
          prShape.base?.ref ?? 'dev',
        );
      }

      // Apply ai-authored label server-side after PR creation.
      if (this.githubClient) {
        const ghClient = this.githubClient;
        void (async () => {
          try {
            await ghClient.ensureLabelExists(
              repo,
              'ai-authored',
              '0075ca',
              'Opened by an AI coding session',
            );
            await ghClient.addLabelToPR(repo, prNumber, 'ai-authored');
          } catch (e) {
            logger.warn(`[AgentSession] ai-authored label failed: ${e}`);
          }
        })();
      }
    }

    if (!upsertSucceeded) return;

    this.broadcast({
      type: 'pr_created',
      sessionId: this.sessionId,
      prUrl,
      ...(this.taskId && { taskId: this.taskId }),
    });
    logger.info(
      `[AgentSession] emitting pr_opened for PR #${prNumber} (${repo}) session=${this.sessionId}`,
    );
    this.emit('pr_opened', {
      prNumber,
      repo,
      taskId: this.taskId,
      taskUrl: this.taskUrl,
      contextUrl: this.projectContextUrl,
    });
    recordEvent({
      event_type: 'pr_opened',
      actor_type: 'ai',
      actor_id: this.sessionId,
      project_id: this.projectId || null,
      task_id: this.taskId || null,
      payload: { pr_number: prNumber, repo, pr_url: prUrl },
    });
    sessionLog(this.sessionId, `PR detected live: ${prUrl}`);
  }

  /**
   * Emit the push_detected EventEmitter event (always, for ReviewOrchestrator) and,
   * if a PR row exists for this session, also broadcast the WS push_detected message
   * with prNumber and repo included.
   */
  private async handlePushDetected(): Promise<void> {
    // Auto-push any local commits ahead of origin before signalling.
    if (this.worktreePath) {
      try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: this.worktreePath,
        })
          .toString()
          .trim();
        const localHead = execSync('git rev-parse HEAD', {
          cwd: this.worktreePath,
        })
          .toString()
          .trim();
        const remoteHead =
          execSync(`git ls-remote origin ${branch}`, { cwd: this.worktreePath })
            .toString()
            .split(/\s+/)[0]
            ?.trim() || '';

        if (localHead && localHead !== remoteHead) {
          const aheadBehind = execSync(
            `git rev-list --left-right --count origin/${branch}...HEAD`,
            { cwd: this.worktreePath },
          )
            .toString()
            .trim();
          const [behind, ahead] = aheadBehind.split(/\s+/).map(Number);
          if (ahead > 0 && behind === 0) {
            sessionLog(
              this.sessionId,
              `auto-pushing ${ahead} local commit(s) on ${branch} (origin was at ${remoteHead.slice(0, 7)}, local at ${localHead.slice(0, 7)})`,
            );
            execSync(`git push origin ${branch}`, { cwd: this.worktreePath });
            this.broadcast({
              type: 'session_auto_pushed',
              sessionId: this.sessionId,
              branch,
              commits: ahead,
            });
          } else if (behind > 0) {
            sessionLog(
              this.sessionId,
              `auto-push skipped: branch ${branch} has diverged (ahead=${ahead}, behind=${behind}) — manual reconciliation needed`,
            );
            const pr = getPRBySessionId(this.sessionId);
            if (pr) {
              setPauseReason(pr.pr_number, pr.repo, 'diverged_branch');
            }
            this.broadcast({
              type: 'session_auto_pushed',
              sessionId: this.sessionId,
              branch,
              commits: 0,
            });
          }
        }
      } catch (err) {
        sessionLog(
          this.sessionId,
          `auto-push check failed (non-fatal): ${(err as Error).message}`,
        );
      }
    }

    this.emit('push_detected', { sessionId: this.sessionId });
    const pr = getPRBySessionId(this.sessionId);
    if (pr) {
      this.broadcast({
        type: 'push_detected',
        sessionId: this.sessionId,
        prNumber: pr.pr_number,
        repo: pr.repo,
      });

      // File pollution check + auto-revert runs inline on every push.
      if (this.githubClient) {
        await this.runFilePollutionCheck(
          pr.repo,
          pr.pr_number,
          pr.base_branch ?? 'dev',
        );
      }

      // Fire-and-forget: verify commit attribution trailers.
      if (this.githubClient) {
        const ghClient = this.githubClient;
        void checkCommitAttribution(
          ghClient,
          pr.repo,
          pr.pr_number,
          this.sessionId,
          this.projectId || null,
          this.taskId || null,
          runtimeSettings.corporate_mode_enabled,
        ).catch((e) =>
          logger.warn(`[AgentSession] checkCommitAttribution failed: ${e}`),
        );
      }
    }
  }

  /** Fetch the PR's changed files, validate for banned/gitignored paths, and revert if needed. */
  private async runFilePollutionCheck(
    repo: string,
    prNumber: number,
    baseBranch: string,
  ): Promise<void> {
    if (!this.githubClient) return;
    const { revertCommitSha } = await filePollutionCheckFn({
      github: this.githubClient,
      worktreePath: this.worktreePath,
      repo,
      prNumber,
      baseBranch,
      sessionId: this.sessionId,
      projectId: this.projectId || null,
      taskId: this.taskId || null,
      onReverted: (files) => {
        for (const f of files) this._revertLock.add(f);
      },
      registerRevertSync: (pr, r, p) =>
        this.sessionManager?.registerRevertSync?.(pr, r, p),
      lastRevertSha: this.lastFilePollutionRevertSha,
    });
    if (revertCommitSha) {
      this.lastFilePollutionRevertSha = revertCommitSha;
    }
  }

  /**
   * Register the feedback text that is being delivered via sendOrResume.
   * If the session overflows and escalates, this text is re-delivered to the
   * escalated session so it is never lost.
   */
  setPendingOverflowText(text: string): void {
    this._pendingOverflowText = text;
  }

  /**
   * If a context overflow was detected this run, attempt to escalate to the large model.
   * Returns true (caller should `continue` the run loop) when escalation is initiated.
   * Returns false when no overflow was detected OR when overflow was detected but escalation
   * is not possible (no large_task_model configured, or already on the large model).
   * In the false+overflow case, `this.contextOverflowDetected` remains true so the caller
   * can error the session regardless of exit code.
   */
  private async tryEscalateForOverflow(): Promise<boolean> {
    if (!this.contextOverflowDetected) return false;
    const largeModel = runtimeSettings.large_task_model;
    if (!largeModel || this.model === largeModel) {
      sessionLog(
        this.sessionId,
        largeModel
          ? `context overflow — already on large model ${largeModel}, no re-escalation`
          : 'context overflow — large_task_model not configured, exiting without retry',
      );
      return false;
    }
    sessionLog(
      this.sessionId,
      `context overflow — escalating to large model ${largeModel} (was: ${this.model ?? 'unknown'})`,
    );
    const currentTags = getSessionTags(this.sessionId);
    const updatedTags = currentTags.includes('large-model')
      ? currentTags
      : [...currentTags, 'large-model'];
    setSessionTags(this.sessionId, updatedTags);
    this.broadcast({
      type: 'session_updated',
      sessionId: this.sessionId,
      tags: updatedTags,
    });
    // Signal escalation so listeners (e.g. PRMergeWatcher) can reset timeouts.
    this.broadcast({
      type: 'large_model_escalation_started',
      sessionId: this.sessionId,
    });
    // Reset overflow flag and model; set escalation overrides for the next spawn.
    this.contextOverflowDetected = false;
    this.model = null;
    this._escalationModel = largeModel;
    this._escalationDisableAutoCompact = false;
    const pendingText = this._pendingOverflowText;
    this._pendingOverflowText = null; // consume — prevent double-delivery on re-escalation
    this._pendingEscalationNudge = pendingText
      ? `You exceeded the previous model's context window and have been resumed on a 1M-context model. The following message was pending delivery when the overflow occurred — please process it now:\n\n${pendingText}`
      : "You exceeded the previous model's context window and have been resumed on a 1M-context model. Continue the task from where you left off.";
    this.broadcast({
      type: 'session_status',
      sessionId: this.sessionId,
      status: 'running',
    });
    return true;
  }

  private async handleCleanExit(): Promise<void> {
    recordEvent({
      event_type: 'handle_clean_exit_entered',
      actor_type: 'system',
      actor_id: this.sessionId,
      project_id: this.projectId ?? null,
      task_id: this.taskId || null,
      payload: { session_id: this.sessionId },
    });
    const endedAt = Date.now();
    let prUrl: string | undefined;

    // Await any in-flight PR creation from the <pr-body> marker so that the PR
    // is registered before we scan for the URL and call markSessionIdle.
    if (this.prBodyMarkerPromise) {
      const MARKER_PR_TIMEOUT_MS = 30_000;
      await Promise.race([
        this.prBodyMarkerPromise,
        new Promise<void>((resolve) =>
          setTimeout(resolve, MARKER_PR_TIMEOUT_MS),
        ),
      ]);
    }

    try {
      const events = getEventsBySession(this.sessionId);
      // Exclude tool-call and user-message events — tool_use inputs (Write, Edit,
      // etc.) may contain placeholder URLs producing phantom pull_requests rows.
      const last20 = events
        .filter((ev) => {
          const k = eventKind(ev);
          return (
            k !== 'tool_use' && k !== 'tool_result' && k !== 'user_message'
          );
        })
        .slice(-20);

      for (const ev of last20) {
        const match = ev.payload.match(PR_URL_REGEX);
        if (match) {
          prUrl = match[0];
          break;
        }
      }
    } catch (e) {
      logger.error(
        `[AgentSession] handleCleanExit pre-done failed for ${this.sessionId}:`,
        e,
      );
      // Fall through with prUrl=undefined — periodic recovery will retry PR extraction.
    }

    // Preserve URL detected live (e.g. via marker flow where the URL is never
    // emitted into session events — handlePRDetected sets this.prUrl directly).
    if (!prUrl) prUrl = this.prUrl;
    this.prUrl = prUrl;

    // Atomically persist idle + pr_url before any network or review-pipeline
    // calls. Session becomes done only when the PR merges (PRMergeWatcher).
    // Using idle (not done) prevents the post-hoc auditor from triggering review
    // on a stale SHA before the PR has been properly reviewed/merged.
    markSessionIdle(this.sessionId, endedAt, prUrl ?? null);
    if (this.taskId) resetTaskCrashCount(this.taskId);
    recordEvent({
      event_type: 'handle_clean_exit_session_marked_idle',
      actor_type: 'system',
      actor_id: this.sessionId,
      project_id: this.projectId ?? null,
      task_id: this.taskId || null,
      payload: { session_id: this.sessionId, pr_url: prUrl ?? null },
    });

    await recoverSession(this.sessionId, {
      scope: 'clean_exit',
      prUrl,
      prDetectedLive: this.prDetectedLive,
      sessionType: this.sessionType,
      taskId: this.taskId,
      projectId: this.projectId,
      worktreePath: this.worktreePath,
      taskUrl: this.taskUrl,
      projectContextUrl: this.projectContextUrl,
      githubClient: this.githubClient,
      taskBackend: this.taskBackend(),
      sessionManager: this.sessionManager,
      broadcast: (msg) => this.broadcast(msg),
      emitPrOpened: (data) => this.emit('pr_opened', data),
    });
  }

  /** Files reverted during this session that the injector must not overwrite (one cycle). */
  get revertedFiles(): ReadonlySet<string> {
    return this._revertLock;
  }

  /** Add a file to the one-cycle injection skip lock (called by the autofix path). */
  lockFileForNextInjection(filename: string): void {
    this._revertLock.add(filename);
  }

  /**
   * Write orchestrator context content to a file in the worktree.
   * If the file is in the revert lock, the write is suppressed for one cycle:
   * the lock entry is consumed so subsequent injections are allowed.
   */
  injectContextFile(filename: string, content: string): void {
    if (this._revertLock.has(filename)) {
      this._revertLock.delete(filename); // consume — one cycle only
      recordEvent({
        event_type: 'file_pollution_re_injected_blocked',
        actor_type: 'system',
        actor_id: this.sessionId,
        project_id: this.projectId || null,
        task_id: this.taskId || null,
        payload: { filename, session_id: this.sessionId },
      });
      return;
    }
    try {
      fs.writeFileSync(
        path.join(this.worktreePath, filename),
        content,
        'utf-8',
      );
    } catch (err) {
      logger.error(
        `[AgentSession] injectContextFile: failed to write ${filename}: ${err}`,
      );
    }
  }

  /** No-op — CLI does not support mid-session permission approval. */
  approve(): void {}

  /** No-op — CLI does not support mid-session permission denial. */
  deny(_reason?: string): void {}

  /**
   * Send a follow-up user message to the session.
   * Delegates to the underlying runner (stdin for CLI, message queue for API).
   */
  sendMessage(message: string): void {
    this.runner.sendMessage(message);
  }

  /**
   * Signal a clean session end. Delegates to the underlying runner.
   */
  endSession(): void {
    this.runner.endSession();
  }

  async kill(): Promise<void> {
    if (this.isKilling) return;
    this.isKilling = true;
    await this.runner.kill();
    if (!this.hasEnded) {
      this.sessionManager?.markSessionErrored?.(
        this.sessionId,
        'killed',
        'user_kill',
      );
      if (!this.hasEnded) {
        // Fallback when sessionManager is absent (e.g. unit tests without a manager)
        updateSessionStatus(this.sessionId, 'killed', Date.now());
        this.broadcast({
          type: 'session_ended',
          sessionId: this.sessionId,
          status: 'killed',
          ...(this.taskId && { taskId: this.taskId }),
        });
      }
    }
  }

  /**
   * Pause the session for graceful server shutdown.
   * SIGTERMs the CLI subprocess and awaits exit without touching DB status or
   * Notion — leaving status='running' so resumeOrphanSessions picks it up on
   * next boot.
   */
  async gracefulPause(): Promise<void> {
    if (this.isPausingForShutdown || this.isKilling) return;
    this.isPausingForShutdown = true;
    await this.runner.kill();
  }

  /** Persist to SQLite first, then emit. Caller (SessionManager) listens and broadcasts. */
  private broadcast(msg: ServerMessage): void {
    if (msg.type === 'session_ended') this.hasEnded = true;
    this.emit('message', msg);
  }
}
