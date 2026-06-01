import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { ALLOWED_TOOLS, runtimeSettings } from '../config';
import {
  upsertSessionEvent,
  updateSessionStatus,
  markSessionDone,
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
  insertPauseInterval,
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
import { recordEvent } from '../audit/AuditLog';
import { isSystemOnlyUserEvent } from '../utils/eventFilters';
import type { ISessionManager } from './SessionAuditor';
import type { ISessionRunner } from './SessionRunner';
import { CliSessionRunner } from './CliSessionRunner';
import { recoverSession } from './sessionRecovery';
import {
  VALID_EVENT_TYPES,
  SILENT_SKIP_TYPES,
  toEventType,
} from './eventTypes';

const PR_URL_REGEX = /https:\/\/github\.com\/[^"\\]+\/pull\/\d+/;

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

function sessionLog(sessionId: string, ...args: unknown[]) {
  console.log(`[Session ${sessionId.slice(0, 8)}]`, ...args);
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
  private static readonly CONTEXT_WINDOW_LIMIT = 200_000;
  /** Model name extracted from the first assistant event (e.g. 'claude-sonnet-4-6'). */
  public model: string | null = null;
  /** Count of consecutive transient-error retries for this session instance. Resets on clean exit. */
  private retryCount = 0;
  /** Guard: fires at most once per session to avoid duplicate pause broadcasts. */
  private inSessionApiErrorFired = false;
  /** One-cycle injection skip lock set by PRFileReverter.
   *  Each entry is consumed (deleted) the first time injectContextFile checks it,
   *  blocking exactly one injection attempt per reverted file before resetting. */
  private readonly _revertLock = new Set<string>();
  /** SHA of the last orchestrator-revert commit pushed by runFilePollutionCheck.
   *  Used as a loop guard: if the PR's HEAD equals this SHA, the check is skipped
   *  so we don't re-revert our own revert commit. */
  private lastFilePollutionRevertSha: string | null = null;

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
          model: modelSetting || undefined,
          allowedTools: [...ALLOWED_TOOLS, ...this.extraAllowedTools],
          systemPrompt: this.systemPromptContent,
        },
        (event) => this.handleRawEvent(event),
      );

      if (
        this.runner.hasSpawnError ||
        this.isKilling ||
        this.isPausingForShutdown
      )
        return;

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
    if (lastEvent.event_type !== 'error') return false;
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
        console.warn(
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

    // After each result event (one per turn), update token counters and broadcast
    // session_updated so the frontend receives live totals during execution.
    if (rawType === 'result') {
      const usageData = event.usage as
        | {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          }
        | undefined;
      const inputTokens = usageData?.input_tokens ?? 0;
      const outputTokens = usageData?.output_tokens ?? 0;
      const cacheRead = usageData?.cache_read_input_tokens ?? 0;
      const cacheCreate = usageData?.cache_creation_input_tokens ?? 0;
      if (inputTokens > 0 || outputTokens > 0) {
        this.totalInputTokens += inputTokens;
        this.totalOutputTokens += outputTokens;
        incrementTokens(this.sessionId, inputTokens, outputTokens);
      }
      // Occupancy = this turn's full prompt token count (not cumulative).
      const occupancy = inputTokens + cacheRead + cacheCreate;
      setContextOccupancy(this.sessionId, occupancy);
      this.broadcast({
        type: 'session_updated',
        sessionId: this.sessionId,
        totalInputTokens: this.totalInputTokens,
        totalOutputTokens: this.totalOutputTokens,
        contextOccupancyTokens: occupancy,
        contextOccupancyFraction: occupancy / AgentSession.CONTEXT_WINDOW_LIMIT,
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
      eventType: eventType as 'text' | 'tool_use' | 'tool_result' | 'system',
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

    // Extract text from content blocks
    let text = '';
    for (const block of contentBlocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        text += block.text;
      }
    }

    // Try to parse as GitHub PR API JSON response
    interface GitHubPRShape {
      number?: number;
      html_url?: string;
      title?: string;
      body?: string | null;
      head?: { ref?: string; sha?: string };
      base?: { ref?: string };
      state?: string;
      created_at?: string;
      updated_at?: string;
      draft?: boolean;
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

    // Determine the PR URL (from parsed JSON or regex match)
    const prUrl = prShape.html_url ?? text.match(PR_URL_REGEX)?.[0];
    if (!prUrl) return;

    const repoMatch = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (!repoMatch) return;

    const repo = repoMatch[1];
    const prNumber = prShape.number ?? parseInt(repoMatch[2], 10);
    const now = new Date().toISOString();

    this.prUrl = prUrl;
    this.prDetectedLive = true;

    if (this.sessionType === 'standard') {
      this.taskBackend()
        .attachPR(this.taskId, prUrl)
        .catch((e) => console.error(`[AgentSession] attachPR failed: ${e}`));

      upsertPullRequest({
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
      });

      // If head_sha was missing from the tool response, fetch it from GitHub
      // so shouldAutoReview() can compare SHAs on the first re-review attempt.
      if (!prShape.head?.sha && this.githubClient) {
        const ghClient = this.githubClient;
        void (async () => {
          try {
            const freshPR = await ghClient.fetchPR(repo, prNumber);
            if (freshPR.headSha) {
              setHeadSha(prNumber, repo, freshPR.headSha);
            }
          } catch (e) {
            console.warn(
              `[AgentSession] handlePRCreatedFromContent: failed to fetch head_sha for PR #${prNumber}:`,
              e,
            );
          }
        })();
      }

      // Validate PR body against required template.
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
                console.warn(`[AgentSession] createIssueComment failed: ${e}`),
              );
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
            console.warn(`[AgentSession] ai-authored label failed: ${e}`);
          }
        })();
      }
    }

    this.broadcast({ type: 'pr_created', sessionId: this.sessionId, prUrl, ...(this.taskId && { taskId: this.taskId }) });
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
          console.warn(`[AgentSession] checkCommitAttribution failed: ${e}`),
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

    try {
      const events = getEventsBySession(this.sessionId);
      const last20 = events.slice(-20);

      for (const ev of last20) {
        const match = ev.payload.match(PR_URL_REGEX);
        if (match) {
          prUrl = match[0];
          break;
        }
      }
    } catch (e) {
      console.error(
        `[AgentSession] handleCleanExit pre-done failed for ${this.sessionId}:`,
        e,
      );
      // Fall through with prUrl=undefined — periodic recovery will retry PR extraction.
    }

    this.prUrl = prUrl;

    // Atomically persist done + pr_url before any network or review-pipeline
    // calls. This ensures the session is terminal in the DB even if the
    // downstream review pipeline throws or the process dies mid-handleCleanExit.
    markSessionDone(this.sessionId, endedAt, prUrl ?? null);
    recordEvent({
      event_type: 'handle_clean_exit_session_marked_done',
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
      console.error(
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
