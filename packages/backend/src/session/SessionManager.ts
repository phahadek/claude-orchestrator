import { EventEmitter } from 'events';
import { AgentSession } from './AgentSession';
import { config } from '../config';
import { insertSession } from '../db/queries';
import type { NotionClient } from '../notion/NotionClient';
import type { ServerMessage } from '../ws/types';

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, AgentSession>();

  constructor(private readonly notionClient: NotionClient) {
    super();
  }

  start(taskUrl: string, projectContextUrl: string): string {
    const sessionId = crypto.randomUUID();
    console.log(`[SessionManager] start ${sessionId}`);
    const session = new AgentSession(
      sessionId,
      taskUrl,
      projectContextUrl,
      this.notionClient,
      config.projectDir,
    );

    // Insert session into SQLite before anything writes events
    const startedAt = Date.now();
    insertSession({
      session_id: sessionId,
      notion_task_id: null,
      notion_task_url: taskUrl,
      project_context_url: projectContextUrl,
      status: 'starting',
      started_at: startedAt,
      ended_at: null,
      pr_url: null,
    });

    // Broadcast session_started so connected frontends see the card immediately
    this.emit('message', {
      type: 'session_started',
      sessionId,
      taskName: taskUrl,
      notionTaskUrl: taskUrl,
      started_at: startedAt,
    } satisfies ServerMessage);

    this.sessions.set(sessionId, session);

    // Forward all session events to the WS layer via EventEmitter
    session.on('message', (msg: ServerMessage) => this.emit('message', msg));

    // Fire-and-forget — run() blocks until the subprocess exits
    session.run().catch((err) =>
      console.error(`[SessionManager] session ${sessionId} error: ${err}`),
    );

    return sessionId;
  }

  async kill(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.kill();
      this.sessions.delete(sessionId);
    }
  }

  approve(sessionId: string): void {
    this.sessions.get(sessionId)?.approve();
  }

  deny(sessionId: string, reason?: string): void {
    this.sessions.get(sessionId)?.deny(reason);
  }

  /** Send a follow-up user message to a running session via stdin. */
  send(sessionId: string, message: string): void {
    this.sessions.get(sessionId)?.sendMessage(message);
  }

  async shutdownAll(): Promise<void> {
    const kills = [...this.sessions.keys()].map((id) => this.kill(id));
    await Promise.allSettled(kills);
  }
}
