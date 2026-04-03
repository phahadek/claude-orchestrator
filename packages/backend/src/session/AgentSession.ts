import { EventEmitter } from 'events';
import { ALLOWED_TOOLS, runtimeSettings } from '../config';
import {
  upsertSessionEvent,
  updateSessionStatus,
  getEventsBySession,
  insertPermissionDenial,
  upsertPullRequest,
  incrementTokens,
  insertSessionAudit,
  setSessionModel,
  getPRBySessionId,
  setHeadSha,
} from '../db/queries';
import type { ServerMessage, PermissionDenial } from '../ws/types';
import { emitTaskUpdated } from '../routes/tasks';
import type { TaskTrackerBackend } from '../tasks/TaskTrackerBackend';
import type { GitHubClient } from '../github/GitHubClient';
import { isSystemOnlyUserEvent } from '../utils/eventFilters';
import { SessionAuditor } from './SessionAuditor';
import type { ISessionManager } from './SessionAuditor';
import type { ISessionRunner } from './SessionRunner';
import { CliSessionRunner } from './CliSessionRunner';

const PR_URL_REGEX = /https:\/\/github\.com\/[^"\\]+\/pull\/\d+/;

/**
 * Returns true if the tool call represents a git push operation.
 * Exported for unit testing.
 */
export function isPushCommand(toolName: string, toolInput: string): boolean {
  if (toolName === 'mcp__github__push_files') return true;
  if (toolName === 'Bash' && /git\s+push/.test(toolInput) && !toolInput.includes('--dry-run')) return true;
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
    if (b.type === 'tool_use' && typeof b.id === 'string') toolUseById.set(b.id, b);
  }
  for (const b of incoming) {
    if (b.type === 'tool_use' && typeof b.id === 'string') toolUseById.set(b.id, b);
  }

  return [...textBlocks, ...toolUseById.values()];
}

/** Map raw claude CLI event type strings to our DB EventType union. */
function toEventType(raw: string): 'text' | 'tool_use' | 'tool_result' | 'system' | 'error' {
  switch (raw) {
    case 'assistant':
    case 'text':
    case 'message':
      return 'text';
    case 'tool_use':
      return 'tool_use';
    case 'tool_result':
      return 'tool_result';
    case 'system':
    case 'user':
    case 'file-history-snapshot':
      return 'system';
    case 'error':
      return 'error';
    default:
      return 'system';
  }
}

export class AgentSession extends EventEmitter {
  private isKilling = false;
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
  /** Model name extracted from the first assistant event (e.g. 'claude-sonnet-4-6'). */
  public model: string | null = null;
  /** Count of consecutive transient-error retries for this session instance. Resets on clean exit. */
  private retryCount = 0;

  /** The underlying I/O adapter (CLI subprocess or Agent SDK). */
  private runner: ISessionRunner;

  constructor(
    public readonly sessionId: string,
    public readonly taskUrl: string,
    public readonly projectContextUrl: string,
    private readonly notionClient: TaskTrackerBackend,
    private readonly worktreePath: string,
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
  ) {
    super();
    this.runner = runner ?? new CliSessionRunner(sessionId);
  }

  async run(): Promise<void> {
    this.broadcast({ type: 'session_status', sessionId: this.sessionId, status: 'running' });
    updateSessionStatus(this.sessionId, 'running');

    const initialPrompt = this.customPrompt ?? `
You are a Claude Code session managed by the Claude Code Dashboard.

## Task
Task page: ${this.taskUrl}
Project context: ${this.projectContextUrl}

Fetch both Notion pages, then begin the task.

## Lifecycle — follow these steps exactly
1. Fetch the project context page and the task page from Notion.
2. Read CLAUDE.md in the repo root for project-specific conventions.
3. Create a feature branch from the project's base branch.
4. Implement the task per the acceptance criteria on the task page.
5. Pass the pre-PR gate as specified in CLAUDE.md.
6. Open a draft PR as specified in CLAUDE.md.
7. After the PR is open, WAIT. Do not merge. Do not close the session.
   The dashboard will send you review feedback as follow-up messages.
   Address any review findings by pushing additional commits, then wait again.

## What the dashboard handles (do NOT do these yourself)
- Task status updates (In Progress, In Review, Done) — the backend manages these.
- Session logging — do not write to any Session Log or update the Master File Index.
- PR review — an automated review will run after you publish the PR.

## Rules
- One task per session. No scope creep.
- Never commit to the base branch directly.
- Never merge your own PR.
- Never move the task status yourself.
- If something is unclear in the task spec, stop and ask via the session transcript.
`.trim();

    // Backoff schedule for transient API errors: 5s, 10s, 20s, 40s, 80s (5 attempts).
    const BACKOFF_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 80_000];
    // resumeIdForSpawn: undefined on first run, set to this.sessionId on each retry.
    let resumeIdForSpawn: string | undefined = this.resumeSessionId;

    const modelSetting = this.sessionType === 'review'
      ? runtimeSettings.review_session_model
      : runtimeSettings.code_session_model;

    // eslint-disable-next-line no-constant-condition
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

      if (this.runner.hasSpawnError || this.isKilling) return;

      if (exitCode === 0) {
        this.retryCount = 0;
        await this.handleCleanExit();
        return;
      }

      // Non-zero exit — check whether this is a transient Anthropic API error
      // (500 api_error or 529 overloaded_error). If so, retry with exponential backoff
      // using --resume to restore conversation history. Non-transient errors (bad config,
      // permission issues, etc.) fall through to permanent error immediately.
      if (this.retryCount < BACKOFF_DELAYS_MS.length && this.isTransientApiError()) {
        const delay = BACKOFF_DELAYS_MS[this.retryCount];
        this.retryCount++;
        sessionLog(this.sessionId, `transient API error — retry ${this.retryCount}/${BACKOFF_DELAYS_MS.length} after ${delay}ms`);
        this.broadcast({ type: 'session_status', sessionId: this.sessionId, status: 'retrying' });
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        if (this.isKilling) return;
        resumeIdForSpawn = this.sessionId;
        this.broadcast({ type: 'session_status', sessionId: this.sessionId, status: 'running' });
      } else {
        const status = exitCode === null ? 'killed' : 'error';
        updateSessionStatus(this.sessionId, status, Date.now());
        this.broadcast({ type: 'session_ended', sessionId: this.sessionId, status });
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
    return payload.includes('api_error') || payload.includes('overloaded_error');
  }

  /**
   * Process a single raw JSON event from the session transport.
   * This is called for each event by both CliSessionRunner and ApiSessionRunner.
   */
  private handleRawEvent(event: Record<string, unknown>): void {
    const rawType = (event.type as string) ?? 'unknown';

    // Debug logging
    sessionLog(this.sessionId, `event type=${rawType} subtype=${event.subtype ?? '-'}`);

    if (rawType === 'system' && (event.subtype as string) === 'init') {
      sessionLog(this.sessionId, `INIT permissionMode=${event.permissionMode}`);
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
            sessionLog(this.sessionId, `TOOL_USE name=${block.name} id=${block.id}`);
            if (block.name === 'mcp__github__create_pull_request' && typeof block.id === 'string') {
              this.pendingGHToolUseIds.set(block.id, block.name as string);
            }
            if (block.name === 'Bash' && typeof block.id === 'string') {
              const cmd = ((block.input as Record<string, unknown>)?.command as string) ?? '';
              this.pendingBashCommands.set(block.id, cmd);
            }
            if (block.name === 'mcp__github__push_files' && typeof block.id === 'string') {
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
        const content = event.content as Array<Record<string, unknown>> | undefined;
        this.handlePRCreatedFromContent(content ?? []);
      }
      if (toolUseId && this.pendingPushFileToolUseIds.has(toolUseId)) {
        this.pendingPushFileToolUseIds.delete(toolUseId);
        this.handlePushDetected();
      }
      if (toolUseId && this.pendingBashCommands.has(toolUseId)) {
        const cmd = this.pendingBashCommands.get(toolUseId)!;
        this.pendingBashCommands.delete(toolUseId);
        if (isPushCommand('Bash', cmd)) {
          this.handlePushDetected();
        }
      }
    }

    // Also handle tool_result blocks embedded in user events
    if (rawType === 'user' && !this.prDetectedLive) {
      const msg = event.message as Record<string, unknown> | undefined;
      const content = (msg?.content ?? event.content) as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            const toolUseId = block.tool_use_id as string | undefined;
            if (toolUseId && this.pendingGHToolUseIds.has(toolUseId)) {
              this.pendingGHToolUseIds.delete(toolUseId);
              const innerContent = block.content as Array<Record<string, unknown>> | undefined;
              this.handlePRCreatedFromContent(innerContent ?? []);
            }
          }
        }
      }
    }

    // Extract permission_denials from result event and broadcast to UI
    if (rawType === 'result') {
      const denials = event.permission_denials as PermissionDenial[] | undefined;
      sessionLog(this.sessionId, `RESULT stop_reason=${event.stop_reason} denials=${JSON.stringify(denials)}`);
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
    if (messageId != null && (rawType === 'assistant' || rawType === 'message')) {
      const msg = event.message as Record<string, unknown> | undefined;
      if (msg && Array.isArray(msg.content)) {
        const incomingContent = msg.content as Array<Record<string, unknown>>;
        const existingContent = this.messageContentMap.get(messageId) ?? [];
        const mergedContent = mergeAssistantContent(existingContent, incomingContent);
        this.messageContentMap.set(messageId, mergedContent);
        payload = JSON.stringify({ ...event, message: { ...msg, content: mergedContent } });
      }
    }

    const existingRowId = messageId != null ? this.messageIdMap.get(messageId) : undefined;
    const rowId = upsertSessionEvent(
      { session_id: this.sessionId, event_type: eventType, payload, timestamp: Date.now(), message_id: messageId ?? null },
      existingRowId,
    );
    if (messageId != null) {
      this.messageIdMap.set(messageId, rowId);
    }

    // After each result event (one per turn), increment token counters and broadcast
    // session_updated so the frontend receives live totals during execution.
    if (rawType === 'result') {
      const usageData = event.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      const inputTokens = usageData?.input_tokens ?? 0;
      const outputTokens = usageData?.output_tokens ?? 0;
      if (inputTokens > 0 || outputTokens > 0) {
        this.totalInputTokens += inputTokens;
        this.totalOutputTokens += outputTokens;
        incrementTokens(this.sessionId, inputTokens, outputTokens);
        this.broadcast({
          type: 'session_updated',
          sessionId: this.sessionId,
          totalInputTokens: this.totalInputTokens,
          totalOutputTokens: this.totalOutputTokens,
        });
      }
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
  }

  /**
   * Parse PR data from the content blocks of a mcp__github__create_pull_request tool_result,
   * upsert the PR to SQLite with full metadata, and broadcast pr_created.
   */
  private handlePRCreatedFromContent(contentBlocks: Array<Record<string, unknown>>): void {
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
      this.notionClient.attachPR(this.taskId, prUrl).catch((e) =>
        console.error(`[AgentSession] attachPR failed: ${e}`),
      );

      upsertPullRequest({
        pr_number: prNumber,
        pr_url: prUrl,
        notion_task_id: this.taskId,
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
            console.warn(`[AgentSession] handlePRCreatedFromContent: failed to fetch head_sha for PR #${prNumber}:`, e);
          }
        })();
      }
    }

    this.broadcast({ type: 'pr_created', sessionId: this.sessionId, prUrl });
    this.emit('pr_opened', {
      prNumber,
      repo,
      taskId: this.taskId,
      taskUrl: this.taskUrl,
      contextUrl: this.projectContextUrl,
    });
    sessionLog(this.sessionId, `PR detected live: ${prUrl}`);
  }

  /**
   * Emit the push_detected EventEmitter event (always, for ReviewOrchestrator) and,
   * if a PR row exists for this session, also broadcast the WS push_detected message
   * with prNumber and repo included.
   */
  private handlePushDetected(): void {
    this.emit('push_detected', { sessionId: this.sessionId });
    const pr = getPRBySessionId(this.sessionId);
    if (pr) {
      this.broadcast({
        type: 'push_detected',
        sessionId: this.sessionId,
        prNumber: pr.pr_number,
        repo: pr.repo,
      });
    }
  }

  private async handleCleanExit(): Promise<void> {
    const events = getEventsBySession(this.sessionId);
    const last20 = events.slice(-20);
    let prUrl: string | undefined;

    for (const ev of last20) {
      const match = ev.payload.match(PR_URL_REGEX);
      if (match) {
        prUrl = match[0];
        break;
      }
    }

    this.prUrl = prUrl;
    updateSessionStatus(this.sessionId, 'done', Date.now());

    if (this.sessionType === 'standard') {
      if (prUrl && !this.prDetectedLive) {
        // Fallback: live detection didn't fire (e.g. gh pr create via Bash).
        // Attach the PR to Notion.
        this.notionClient.attachPR(this.taskId, prUrl).catch((e) =>
          console.error(`[AgentSession] attachPR failed: ${e}`),
        );
      }

      // Always upsert notion_task_id and session_id onto the PR row when a
      // PR URL is known at session end. This ensures the link is set even if
      // PRSyncJob ran before handleCleanExit and created the row with null values.
      if (prUrl) {
        const prMatch = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
        if (prMatch) {
          const repo = prMatch[1];
          const prNumber = parseInt(prMatch[2], 10);
          const now = new Date().toISOString();
          let headSha: string | null = null;
          if (this.githubClient) {
            try {
              const freshPR = await this.githubClient.fetchPR(repo, prNumber);
              headSha = freshPR.headSha ?? null;
            } catch (e) {
              console.warn(`[AgentSession] handleCleanExit: failed to fetch PR #${prNumber} from GitHub for head_sha:`, e);
            }
          }
          upsertPullRequest({
            pr_number: prNumber,
            pr_url: prUrl,
            notion_task_id: this.taskId || null,
            session_id: this.sessionId,
            repo,
            title: null,
            body: null,
            head_branch: null,
            base_branch: null,
            state: 'open',
            draft: 0,
            review_result: null,
            review_at: null,
            created_at: now,
            updated_at: now,
            synced_at: now,
            node_id: null,
            head_sha: headSha,
          });
          if (!this.prDetectedLive) {
            this.emit('pr_opened', {
              prNumber,
              repo,
              taskId: this.taskId,
              taskUrl: this.taskUrl,
              contextUrl: this.projectContextUrl,
            });
          }
        }
      }

      if (prUrl) {
        this.notionClient.updateStatus(this.taskId, '👀 In Review')
          .then(() => {
            this.broadcast({
              type: 'task_status_changed',
              notionTaskId: this.taskId,
              newStatus: '👀 In Review',
            });
            emitTaskUpdated(this.taskId);
          })
          .catch((e) => console.error(`[AgentSession] updateStatus failed: ${e}`));
      }
    }

    this.broadcast({
      type: 'session_ended',
      sessionId: this.sessionId,
      status: 'done',
      ...(prUrl ? { prUrl } : {}),
    });

    if (this.sessionType !== 'review') {
      this.runAudit(0);
    }
  }

  /**
   * Run the post-session audit fire-and-forget.
   * Stores the result in SQLite and broadcasts session_audit.
   * Errors are logged but never thrown — the audit is always non-blocking.
   */
  private runAudit(exitCode: number | null): void {
    const auditor = new SessionAuditor(this.notionClient, this.githubClient, this.sessionManager);
    auditor.audit(this, exitCode)
      .then((audit) => {
        insertSessionAudit({
          session_id: audit.sessionId,
          pr_opened: audit.prOpened ? 1 : 0,
          pr_targets: audit.prTargetsBranch,
          task_status: audit.taskStatusAfter,
          violations: JSON.stringify(audit.violations),
          spec_mismatch: audit.specMismatch,
          audited_at: audit.auditedAt,
        });
        this.broadcast({
          type: 'session_audit',
          sessionId: audit.sessionId,
          prOpened: audit.prOpened,
          prTargetsBranch: audit.prTargetsBranch,
          violations: audit.violations,
          specMismatch: audit.specMismatch,
          auditedAt: audit.auditedAt,
        });
      })
      .catch((err) => {
        console.error(`[AgentSession] audit failed for ${this.sessionId}: ${err}`);
      });
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
    updateSessionStatus(this.sessionId, 'killed', Date.now());
    this.broadcast({ type: 'session_ended', sessionId: this.sessionId, status: 'killed' });
  }

  /** Persist to SQLite first, then emit. Caller (SessionManager) listens and broadcasts. */
  private broadcast(msg: ServerMessage): void {
    if (msg.type === 'session_ended') this.hasEnded = true;
    this.emit('message', msg);
  }
}
