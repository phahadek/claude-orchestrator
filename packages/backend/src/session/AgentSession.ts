import { spawn, ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { EventEmitter } from 'events';
import { config } from '../config';
import {
  insertEvent,
  updateSessionStatus,
  getEventsBySession,
} from '../db/queries';
import type { ServerMessage, PermissionDenial } from '../ws/types';
import type { NotionClient } from '../notion/NotionClient';

const PR_URL_REGEX = /https:\/\/github\.com\/.+\/pull\/\d+/;

/** Parse the Notion page ID out of a notion.so URL or return the raw value. */
function parseNotionPageId(url: string): string {
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
  public prUrl: string | undefined;

  constructor(
    public readonly sessionId: string,
    public readonly taskUrl: string,
    public readonly projectContextUrl: string,
    private readonly notionClient: NotionClient,
    private readonly worktreePath: string,
  ) {
    super();
  }

  async run(): Promise<void> {
    this.broadcast({ type: 'session_status', sessionId: this.sessionId, status: 'running' });
    updateSessionStatus(this.sessionId, 'running');

    const initialPrompt =
      `Task page: ${this.taskUrl}\nProject context: ${this.projectContextUrl}\n\nFetch both Notion pages, then begin the task.`;

    // Use --input-format stream-json for bidirectional JSON communication.
    // Use --permission-mode acceptEdits to auto-approve in-project Edit/Write.
    // acceptEdits also auto-approves read-only Bash (git status, ls, cat, etc.)
    // but blocks write Bash commands unless explicitly allowed via --allowed-tools.
    // Use Bash(<prefix>:*) patterns for granular Bash access — only commands
    // starting with the given prefix are allowed. Unmatched Bash commands are
    // silently denied in --print mode.
    this.proc = spawn(
      config.claudePath,
      [
        '--print',
        '--output-format', 'stream-json',
        '--input-format', 'stream-json',
        '--verbose',
        '--permission-mode', 'acceptEdits',
        '--allowed-tools',
        'Bash(git:*)',
        'Bash(npm:*)',
        'Bash(npx:*)',
        'Bash(node:*)',
        'Bash(gh:*)',
        'Bash(cd:*)',        // compound: cd <dir> && git ... / npm ...
        'Bash(which:*)',     // command lookup (Unix)
        'Bash(where:*)',     // command lookup (Windows)
        'Bash(ls:*)',
        'Bash(cat:*)',
        'Bash(echo:*)',
        'Bash(mkdir:*)',
        'Bash(cp:*)',
        'Bash(mv:*)',
        'Bash(head:*)',
        'Bash(tail:*)',
        'Bash(wc:*)',
        'Bash(find:*)',
        'Bash(grep:*)',
        'Bash(sort:*)',
        'Bash(pwd:*)',
        'mcp__claude_ai_Notion__*',
        'mcp__github__*',
        'mcp__claude_ai_Asana__*',
        'mcp__claude_ai_Google_Calendar__*',
      ],
      { cwd: this.worktreePath, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    // Send the initial prompt via stdin (required by --input-format stream-json)
    this.proc.stdin!.write(
      JSON.stringify({ type: 'user', message: { role: 'user', content: initialPrompt } }) + '\n',
    );

    let spawnErrored = false;

    this.proc.on('error', (err) => {
      spawnErrored = true;
      console.error(`[AgentSession] spawn error: ${err.message}`);
      updateSessionStatus(this.sessionId, 'error', Date.now());
      this.broadcast({ type: 'session_ended', sessionId: this.sessionId, status: 'error' });
    });

    // Pipe stderr to console for diagnostics
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      console.error(`[claude:${this.sessionId}] ${chunk.toString().trimEnd()}`);
    });

    const rl = createInterface({ input: this.proc.stdout! });

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
      console.log(`[AgentSession:${this.sessionId}] event type=${rawType} subtype=${event.subtype ?? '-'}`);

      if (rawType === 'system' && (event.subtype as string) === 'init') {
        console.log(`[AgentSession:${this.sessionId}] INIT permissionMode=${event.permissionMode}`);
      }

      // Log tool_use blocks from assistant messages
      if (rawType === 'assistant' && event.message) {
        const msg = event.message as Record<string, unknown>;
        const content = msg.content as Array<Record<string, unknown>> | undefined;
        if (content) {
          for (const block of content) {
            if (block.type === 'tool_use') {
              console.log(`[AgentSession:${this.sessionId}] TOOL_USE name=${block.name} id=${block.id}`);
            }
          }
        }
      }

      // Extract permission_denials from result event and broadcast to UI
      if (rawType === 'result') {
        const denials = event.permission_denials as PermissionDenial[] | undefined;
        console.log(`[AgentSession:${this.sessionId}] RESULT stop_reason=${event.stop_reason} denials=${JSON.stringify(denials)}`);
        if (denials && denials.length > 0) {
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

      insertEvent({
        session_id: this.sessionId,
        event_type: eventType,
        payload,
        timestamp: Date.now(),
      });

      this.broadcast({
        type: 'session_event',
        sessionId: this.sessionId,
        eventType: eventType as 'text' | 'tool_use' | 'tool_result' | 'system',
        content: payload,
      });
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      this.proc!.on('close', (code) => resolve(code));
    });

    if (spawnErrored) return;

    if (exitCode === 0) {
      await this.handleCleanExit();
    } else {
      const status = exitCode === null ? 'killed' : 'error';
      updateSessionStatus(this.sessionId, status, Date.now());
      this.broadcast({ type: 'session_ended', sessionId: this.sessionId, status });
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

    const taskId = parseNotionPageId(this.taskUrl);

    if (prUrl) {
      this.notionClient.attachPR(taskId, prUrl).catch((e) =>
        console.error(`[AgentSession] attachPR failed: ${e}`),
      );
    }

    this.notionClient.updateStatus(taskId, '👀 In Review').catch((e) =>
      console.error(`[AgentSession] updateStatus failed: ${e}`),
    );

    this.broadcast({
      type: 'session_ended',
      sessionId: this.sessionId,
      status: 'done',
      ...(prUrl ? { prUrl } : {}),
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

  async kill(): Promise<void> {
    if (!this.proc) return;
    this.proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.proc?.kill('SIGKILL');
        resolve();
      }, 15_000);
      this.proc!.on('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    updateSessionStatus(this.sessionId, 'killed', Date.now());
    this.broadcast({ type: 'session_ended', sessionId: this.sessionId, status: 'killed' });
  }

  /** Persist to SQLite first, then emit. Caller (SessionManager) listens and broadcasts. */
  private broadcast(msg: ServerMessage): void {
    this.emit('message', msg);
  }
}
