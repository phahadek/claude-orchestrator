import path from 'path';
import { execSync } from 'child_process';
import { EventEmitter } from 'events';
import { AgentSession, parseNotionPageId } from './AgentSession';
import { config, getProjectById } from '../config';
import { insertSession, updateSessionStatus, insertEvent } from '../db/queries';
import type { NotionClient } from '../notion/NotionClient';
import type { ServerMessage } from '../ws/types';

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, AgentSession>();

  constructor(private readonly notionClient: NotionClient) {
    super();
  }

  start(taskUrl: string, projectContextUrl: string, taskType: string | undefined, projectId: string): string {
    if (this.sessions.size >= config.maxConcurrentSessions) {
      throw new Error(`Max concurrent sessions (${config.maxConcurrentSessions}) reached`);
    }

    const project = getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const sessionId = crypto.randomUUID();
    console.log(`[SessionManager] start ${sessionId} project=${projectId}`);

    const worktreePath = path.join(project.projectDir, '.claude', 'worktrees', sessionId);
    const branchName = `session/${sessionId}`;

    try {
      execSync(`git worktree add "${worktreePath}" -b "${branchName}"`, {
        cwd: project.projectDir,
      });
    } catch (err) {
      console.error(`[SessionManager] failed to create worktree for ${sessionId}: ${err}`);
      throw err;
    }

    const notionTaskId = parseNotionPageId(taskUrl);

    const session = new AgentSession(
      sessionId,
      taskUrl,
      projectContextUrl,
      this.notionClient,
      worktreePath,
      notionTaskId,
    );

    // Insert session into SQLite before anything writes events
    const startedAt = Date.now();
    insertSession({
      session_id: sessionId,
      notion_task_id: notionTaskId,
      notion_task_url: taskUrl,
      project_context_url: projectContextUrl,
      project_id: projectId,
      status: 'starting',
      started_at: startedAt,
      ended_at: null,
      pr_url: null,
      worktree_path: worktreePath,
    });

    // Broadcast session_started so connected frontends see the card immediately
    this.emit('message', {
      type: 'session_started',
      sessionId,
      taskName: taskUrl,
      notionTaskUrl: taskUrl,
      ...(taskType != null && { taskType }),
      started_at: startedAt,
    } satisfies ServerMessage);

    this.sessions.set(sessionId, session);

    // Forward all session events to the WS layer via EventEmitter
    session.on('message', (msg: ServerMessage) => this.emit('message', msg));

    // Fire-and-forget — run() blocks until the subprocess exits, then clean up
    session.run()
      .then(() => this.cleanupWorktree(sessionId, worktreePath, branchName, session.prUrl, project.projectDir))
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
        return this.cleanupWorktree(sessionId, worktreePath, branchName, undefined, project.projectDir);
      });

    return sessionId;
  }

  private cleanupWorktree(
    sessionId: string,
    worktreePath: string,
    branchName: string,
    prUrl: string | undefined,
    projectDir: string,
  ): void {
    this.sessions.delete(sessionId);

    try {
      execSync(`git worktree remove --force "${worktreePath}"`, {
        cwd: projectDir,
      });
    } catch (err) {
      console.error(`[SessionManager] failed to remove worktree for ${sessionId}: ${err}`);
    }

    if (!prUrl) {
      try {
        execSync(`git branch -D "${branchName}"`, {
          cwd: projectDir,
        });
      } catch (err) {
        console.error(`[SessionManager] failed to delete branch ${branchName}: ${err}`);
      }
    }
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

  async shutdownAll(): Promise<void> {
    const kills = [...this.sessions.keys()].map((id) => this.kill(id));
    await Promise.allSettled(kills);
  }
}
