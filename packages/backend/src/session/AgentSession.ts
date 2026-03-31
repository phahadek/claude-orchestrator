import { spawn, ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { EventEmitter } from 'events';
import {
  insertEvent,
  insertPermissionEvent,
  updateSessionStatus,
  getEventsBySession,
} from '../db/queries';
import { PermissionEngine } from '../permissions/PermissionEngine';
import type { Decision } from '../permissions/types';
import type { ServerMessage } from '../ws/types';
import type { NotionClient } from '../notion/NotionClient';

const PR_URL_REGEX = /https:\/\/github\.com\/.+\/pull\/\d+/;

/** Parse the Notion page ID out of a notion.so URL or return the raw value. */
function parseNotionPageId(url: string): string {
  // URLs like https://www.notion.so/<title>-<32-hex-chars>
  const match = url.match(/([a-f0-9]{32})$/i);
  if (match) return match[1];
  // Fallback: strip dashes from a UUID-style ID
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
      return 'system';
    case 'error':
      return 'error';
    default:
      return 'system';
  }
}

export class AgentSession extends EventEmitter {
  private proc: ChildProcess | null = null;
  private pendingPermission: ((approved: boolean, reason?: string) => void) | null = null;

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
    // Announce start
    this.broadcast({ type: 'session_status', sessionId: this.sessionId, status: 'running' });
    updateSessionStatus(this.sessionId, 'running');

    const initialPrompt =
      `Task page: ${this.taskUrl}\nProject context: ${this.projectContextUrl}\n\nFetch both Notion pages, then begin the task.`;

    this.proc = spawn(
      'claude',
      ['--print', '--output-format', 'stream-json', '--verbose', initialPrompt],
      { cwd: this.projectDir, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let spawnErrored = false;

    this.proc.on('error', (err) => {
      spawnErrored = true;
      console.error(`[AgentSession] spawn error: ${err.message}`);
      updateSessionStatus(this.sessionId, 'error', Date.now());
      this.broadcast({ type: 'session_ended', sessionId: this.sessionId, status: 'error' });
    });

    // Pipe stderr to console for diagnostics — not forwarded to UI
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      console.error(`[claude:${this.sessionId}] ${chunk.toString().trimEnd()}`);
    });

    const rl = createInterface({ input: this.proc.stdout! });

    rl.on('line', async (line) => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // skip unparseable lines
      }

      const rawType = (event.type as string) ?? 'unknown';

      // ── Permission request ──────────────────────────────────────────────
      if (rawType === 'permission' || rawType === 'tool_use_permission') {
        await this.handlePermission(event);
        return;
      }

      // ── All other events: persist first, then broadcast ─────────────────
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

    // ── Post-exit handling ────────────────────────────────────────────────
    if (spawnErrored) return; // already handled by 'error' event

    if (exitCode === 0) {
      await this.handleCleanExit();
    } else {
      const status = exitCode === null ? 'killed' : 'error';
      updateSessionStatus(this.sessionId, status, Date.now());
      this.broadcast({ type: 'session_ended', sessionId: this.sessionId, status });
    }
  }

  private async handleCleanExit(): Promise<void> {
    // Scan last 20 events for a GitHub PR URL
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

    // Persist final status
    updateSessionStatus(this.sessionId, 'done', Date.now());

    // Fire-and-forget Notion updates — errors are logged, never thrown
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

  private async handlePermission(event: Record<string, unknown>): Promise<void> {
    const toolName = String(event.tool_name ?? event.toolName ?? '');
    const toolArgs = JSON.stringify(event.tool_input ?? event.toolArgs ?? {});

    const engine = new PermissionEngine();
    const decision: Decision = engine.evaluate(toolName, toolArgs);

    if (decision === 'allow') {
      insertPermissionEvent({
        session_id: this.sessionId,
        tool_name: toolName,
        proposed_action: toolArgs,
        decision: 'auto_allow',
        rule_matched: null,
        decided_at: Date.now(),
      });
      this.proc!.stdin!.write(JSON.stringify({ type: 'approve' }) + '\n');
      return;
    }

    if (decision === 'deny') {
      insertPermissionEvent({
        session_id: this.sessionId,
        tool_name: toolName,
        proposed_action: toolArgs,
        decision: 'auto_deny',
        rule_matched: null,
        decided_at: Date.now(),
      });
      this.proc!.stdin!.write(JSON.stringify({ type: 'deny', reason: 'Auto-denied by rule' }) + '\n');
      return;
    }

    // Escalate — pause session and wait for UI response
    updateSessionStatus(this.sessionId, 'needs_permission');
    this.broadcast({
      type: 'session_status',
      sessionId: this.sessionId,
      status: 'needs_permission',
    });
    this.broadcast({
      type: 'permission_request',
      sessionId: this.sessionId,
      toolName,
      proposedAction: toolArgs,
    });

    await new Promise<void>((resolve) => {
      this.pendingPermission = (approved: boolean, reason?: string) => {
        const approved_ = approved;
        const response = approved_
          ? { type: 'approve' }
          : { type: 'deny', reason: reason ?? 'User denied' };

        insertPermissionEvent({
          session_id: this.sessionId,
          tool_name: toolName,
          proposed_action: toolArgs,
          decision: approved_ ? 'approved' : 'denied',
          rule_matched: null,
          decided_at: Date.now(),
        });

        this.proc!.stdin!.write(JSON.stringify(response) + '\n');
        updateSessionStatus(this.sessionId, 'running');
        this.broadcast({
          type: 'session_status',
          sessionId: this.sessionId,
          status: 'running',
        });
        resolve();
      };
    });
  }

  approve(): void {
    this.pendingPermission?.(true);
    this.pendingPermission = null;
  }

  deny(reason?: string): void {
    this.pendingPermission?.(false, reason);
    this.pendingPermission = null;
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
