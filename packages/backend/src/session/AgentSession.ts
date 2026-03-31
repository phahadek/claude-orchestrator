import { spawn, ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { EventEmitter } from 'events';
import { config } from '../config';
import {
  insertEvent,
  updateSessionStatus,
  getEventsBySession,
} from '../db/queries';
import { PermissionEngine } from '../permissions/PermissionEngine';
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

/**
 * Build the --allowedTools list from PermissionEngine rules.
 *
 * The claude CLI --allowedTools flag accepts tool names with optional scope
 * patterns: "Bash(git:*) Edit Read". Tools not in the list are auto-denied.
 *
 * We compute this from the PermissionEngine's allow rules:
 * - HARD_ALLOW patterns like "Bash *git status*" → "Bash"
 * - User allow rules → tool name extracted from pattern
 * - Safe read-only tools always included
 */
function computeAllowedTools(): string[] {
  // Allow tools needed for coding tasks. The PermissionEngine's HARD_DENY
  // list still blocks dangerous commands (rm -rf, force-push, etc.) at the
  // application level after the CLI returns results.
  const tools = new Set([
    // Read-only / safe tools
    'Read', 'Glob', 'Grep', 'ToolSearch', 'TodoWrite',
    'WebFetch', 'WebSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
    'Skill', 'Task', 'TaskOutput', 'AskUserQuestion',
    'EnterPlanMode', 'ExitPlanMode', 'NotebookEdit',
    // Write tools — needed for coding tasks
    'Edit', 'Write', 'Bash',
    // MCP tools are generally safe (server-side only)
    'mcp__claude_ai_Notion__*', 'mcp__github__*',
    'mcp__claude_ai_Asana__*', 'mcp__claude_ai_Google_Calendar__*',
  ]);

  // Add tool names from PermissionEngine allow rules
  const engine = new PermissionEngine();
  const allowedFromRules = engine.getAllowedToolNames();
  for (const t of allowedFromRules) tools.add(t);

  return [...tools];
}

export class AgentSession extends EventEmitter {
  private proc: ChildProcess | null = null;

  constructor(
    public readonly sessionId: string,
    public readonly taskUrl: string,
    public readonly projectContextUrl: string,
    private readonly notionClient: NotionClient,
    private readonly projectDir: string,
  ) {
    super();
  }

  async run(): Promise<void> {
    this.broadcast({ type: 'session_status', sessionId: this.sessionId, status: 'running' });
    updateSessionStatus(this.sessionId, 'running');

    const initialPrompt =
      `Task page: ${this.taskUrl}\nProject context: ${this.projectContextUrl}\n\nFetch both Notion pages, then begin the task.`;

    const allowedTools = computeAllowedTools();
    console.log(`[AgentSession:${this.sessionId}] allowedTools: ${allowedTools.join(', ')}`);

    this.proc = spawn(
      config.claudePath,
      [
        '--print',
        '--output-format', 'stream-json',
        '--input-format', 'stream-json',
        '--verbose',
        '--allowed-tools', ...allowedTools,
      ],
      { cwd: this.projectDir, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let spawnErrored = false;

    this.proc.on('error', (err) => {
      spawnErrored = true;
      console.error(`[AgentSession] spawn error: ${err.message}`);
      updateSessionStatus(this.sessionId, 'error', Date.now());
      this.broadcast({ type: 'session_ended', sessionId: this.sessionId, status: 'error' });
    });

    // Send the initial prompt via stdin (required for --input-format stream-json)
    const userMessage = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: initialPrompt },
    });
    this.proc.stdin!.write(userMessage + '\n');

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

  /**
   * Send a follow-up user message to the subprocess via stdin.
   * Requires --input-format stream-json.
   */
  sendMessage(message: string): void {
    if (!this.proc?.stdin?.writable) return;
    const msg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: message },
    });
    console.log(`[AgentSession:${this.sessionId}] stdin user message: ${message.slice(0, 100)}`);
    this.proc.stdin.write(msg + '\n');
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
