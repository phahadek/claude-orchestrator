import { spawn, ChildProcess, execSync } from 'child_process';
import { createInterface } from 'readline';
import { EventEmitter } from 'events';
import { config, ALLOWED_TOOLS, runtimeSettings } from '../config';
import {
  upsertSessionEvent,
  updateSessionStatus,
  getEventsBySession,
  insertPermissionDenial,
  upsertPullRequest,
  incrementTokens,
  insertSessionAudit,
  setSessionModel,
} from '../db/queries';
import type { ServerMessage, PermissionDenial } from '../ws/types';
import type { NotionClient } from '../notion/NotionClient';
import type { GitHubClient } from '../github/GitHubClient';
import { isSystemOnlyUserEvent } from '../utils/eventFilters';
import { SessionAuditor } from './SessionAuditor';
import type { ISessionManager } from './SessionAuditor';

const PR_URL_REGEX = /https:\/\/github\.com\/[^"\\]+\/pull\/\d+/;

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
  private proc: ChildProcess | null = null;
  private isKilling = false;
  public prUrl: string | undefined;
  /** True once a session_ended message has been broadcast. */
  public hasEnded = false;
  /** Maps message_id → DB row id for deduplicating streaming assistant events. */
  private messageIdMap = new Map<string, number>();
  /** Maps tool_use_id → tool_name for PR creation tools, for real-time detection. */
  private pendingGHToolUseIds = new Map<string, string>();
  /** Maps tool_use_id → Bash command string, for push detection. */
  private pendingBashCommands = new Map<string, string>();
  /** True once a PR was detected and inserted during the live session. */
  private prDetectedLive = false;
  /** Accumulated token counts for this session (in-memory, synced to SQLite). */
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  /** Model name extracted from the first assistant event (e.g. 'claude-sonnet-4-6'). */
  public model: string | null = null;

  constructor(
    public readonly sessionId: string,
    public readonly taskUrl: string,
    public readonly projectContextUrl: string,
    private readonly notionClient: NotionClient,
    private readonly worktreePath: string,
    public readonly taskId: string,
    private readonly resumeSessionId?: string,
    private readonly customPrompt?: string,
    public readonly sessionType: string = 'standard',
    private readonly sessionManager?: ISessionManager,
    private readonly githubClient?: GitHubClient,
  ) {
    super();
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
3. Create a feature branch from the project's base branch (usually dev):
   git checkout <base-branch> && git pull && git checkout -b feature/<task-name>
4. Implement the task per the acceptance criteria on the task page.
5. Pre-PR gate (all must pass before opening PR):
   a. Rebase onto the base branch
   b. Type-check: tsc --noEmit (or the project's equivalent)
   c. Build: npm run build / vite build (or the project's equivalent)
6. Open a draft PR using --body-file to avoid shell escaping:
   - Write the PR body to a temp file first, then run:
     gh pr create --draft --base <base-branch> --title "feat: <exact task name>" --body-file /tmp/pr-body.md
   - Title: "feat: <exact task name>" — no scope prefix like (backend), no milestone tags.
   - Body format:
     ## Summary
     <bulleted list of what changed and why>

     ## Test plan
     <checkboxes from the task's acceptance criteria>

     Notion task: <task URL>
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

    // Use --input-format stream-json for bidirectional JSON communication.
    // Use --permission-mode acceptEdits to auto-approve in-project Edit/Write.
    // acceptEdits also auto-approves read-only Bash (git status, ls, cat, etc.)
    // but blocks write Bash commands unless explicitly allowed via --allowed-tools.
    // Use Bash(<prefix>:*) patterns for granular Bash access — only commands
    // starting with the given prefix are allowed. Unmatched Bash commands are
    // silently denied in --print mode.
    const modelSetting = this.sessionType === 'review'
      ? runtimeSettings.review_session_model
      : runtimeSettings.code_session_model;
    const spawnArgs = [
      ...(this.resumeSessionId ? ['--resume', this.resumeSessionId] : []),
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      ...(modelSetting ? ['--model', modelSetting] : []),
      '--allowed-tools',
      ...ALLOWED_TOOLS,
    ];
    const envKeys = ['PROJECT_DIR', 'SESSIONS_DIR', 'DB_PATH'] as const;
    const envStr = envKeys
      .filter((k) => process.env[k] !== undefined)
      .map((k) => `${k}=${process.env[k]}`)
      .join(', ');
    sessionLog(
      this.sessionId,
      `spawning: cwd=${this.worktreePath} cmd=${config.claudePath} ${spawnArgs.join(' ')} env={${envStr}}`,
    );
    this.proc = spawn(
      config.claudePath,
      spawnArgs,
      {
        cwd: this.worktreePath,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(process.platform !== 'win32' && { detached: true }),
      },
    );

    // Send the initial prompt via stdin (required by --input-format stream-json).
    // Do NOT call stdin.end() here — keeping stdin open allows sendMessage() to
    // deliver follow-up prompts and lets the CLI remain alive after completing
    // its initial task. Call endSession() to close stdin and exit cleanly.
    // Resumed sessions skip the initial prompt — --resume restores conversation
    // history and the caller delivers its message via sendOrResume() instead.
    if (!this.resumeSessionId) {
      this.proc.stdin!.write(
        JSON.stringify({ type: 'user', message: { role: 'user', content: initialPrompt } }) + '\n',
      );
    }

    let spawnErrored = false;

    this.proc.on('error', (err) => {
      spawnErrored = true;
      console.error(`[AgentSession] spawn error: ${err.message}`);
      updateSessionStatus(this.sessionId, 'error', Date.now());
      this.broadcast({ type: 'session_ended', sessionId: this.sessionId, status: 'error' });
    });

    // Pipe stderr to console for diagnostics
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      sessionLog(this.sessionId, `stderr: ${chunk.toString().trimEnd()}`);
    });

    const rl = createInterface({ input: this.proc.stdout! });

    // Capture readline completion early so we can drain after exit,
    // even if 'close' fires before or during the exit await below.
    const rlDone = new Promise<void>((resolve) => rl.once('close', resolve));

    rl.on('line', (line) => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }

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
        if (toolUseId && this.pendingBashCommands.has(toolUseId)) {
          const cmd = this.pendingBashCommands.get(toolUseId)!;
          this.pendingBashCommands.delete(toolUseId);
          if (/^git\s+push/.test(cmd)) {
            this.emit('push_detected', { sessionId: this.sessionId });
            this.broadcast({ type: 'push_detected', sessionId: this.sessionId });
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
      const payload = JSON.stringify(event);

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

      const existingRowId = messageId != null ? this.messageIdMap.get(messageId) : undefined;
      const rowId = upsertSessionEvent(
        { session_id: this.sessionId, event_type: eventType, payload, timestamp: Date.now(), message_id: messageId ?? null },
        existingRowId,
      );
      if (messageId != null) {
        this.messageIdMap.set(messageId, rowId);
      }

      // Accumulate token usage from result events (emitted once per turn in --verbose mode)
      const usageData = event.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      if (usageData?.input_tokens != null || usageData?.output_tokens != null) {
        const inputTokens = usageData.input_tokens ?? 0;
        const outputTokens = usageData.output_tokens ?? 0;
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
    });

    // Use 'exit' rather than 'close': the 'close' event can be indefinitely
    // delayed if readline holds stdout open after the subprocess has exited,
    // which would leave the session stuck at 'running' forever.
    const exitCode = await new Promise<number | null>((resolve) => {
      this.proc!.once('exit', (code) => resolve(code));
    });

    // Drain any remaining buffered lines from stdout before proceeding.
    // Guard with a 5 s timeout in case the stream is stuck.
    await Promise.race([
      rlDone,
      new Promise<void>((resolve) => setTimeout(() => { rl.close(); resolve(); }, 5_000)),
    ]);

    if (spawnErrored || this.isKilling) return;

    if (exitCode === 0) {
      await this.handleCleanExit();
    } else {
      const status = exitCode === null ? 'killed' : 'error';
      updateSessionStatus(this.sessionId, status, Date.now());
      this.broadcast({ type: 'session_ended', sessionId: this.sessionId, status });
    }
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
      head?: { ref?: string };
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
      });
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
        this.notionClient.updateStatus(this.taskId, '👀 In Review').catch((e) =>
          console.error(`[AgentSession] updateStatus failed: ${e}`),
        );
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
   * Send a follow-up user message to the subprocess via stdin.
   * Requires --input-format stream-json.
   */
  sendMessage(message: string): void {
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(
      JSON.stringify({ type: 'user', message: { role: 'user', content: message } }) + '\n',
    );
  }

  /**
   * Close stdin to signal EOF, allowing the CLI to exit cleanly once it
   * finishes any in-progress work. The existing `exit` handler takes over
   * from there and transitions the session to `done` or `error`.
   */
  endSession(): void {
    if (this.proc?.stdin?.writable) {
      this.proc.stdin.end();
    }
  }

  async kill(): Promise<void> {
    if (!this.proc || this.proc.exitCode !== null) return;
    this.isKilling = true;
    try {
      this.killProcessTree(this.proc.pid!);
    } catch {
      // Process may have exited between guard check and here — ignore
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          this.killProcessTree(this.proc!.pid!);
        } catch {
          // Already gone
        }
        resolve();
      }, 15_000);
      this.proc!.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    updateSessionStatus(this.sessionId, 'killed', Date.now());
    this.broadcast({ type: 'session_ended', sessionId: this.sessionId, status: 'killed' });
  }

  private killProcessTree(pid: number): void {
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
      } catch {
        // Process may have already exited — ignore
      }
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        // ESRCH = process already gone
      }
    }
  }

  /** Persist to SQLite first, then emit. Caller (SessionManager) listens and broadcasts. */
  private broadcast(msg: ServerMessage): void {
    if (msg.type === 'session_ended') this.hasEnded = true;
    this.emit('message', msg);
  }
}
