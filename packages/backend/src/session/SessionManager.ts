import path from 'path';
import { execSync } from 'child_process';
import { EventEmitter } from 'events';
import { AgentSession, parseNotionPageId } from './AgentSession';
import { config, getProjectById, normalizePath } from '../config';
import { insertSession, updateSessionStatus, insertEvent, getSession } from '../db/queries';
import type { NotionClient } from '../notion/NotionClient';
import type { ServerMessage } from '../ws/types';

export interface StartOptions {
  taskType?: string;
  sessionType?: 'standard' | 'review';
  customPrompt?: string;
  projectId?: string;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, AgentSession>();

  constructor(private readonly notionClient: NotionClient) {
    super();
  }

  start(taskUrl: string, projectContextUrl: string, options?: StartOptions): string {
    const { taskType, sessionType = 'standard', customPrompt, projectId = '' } = options ?? {};

    if (this.sessions.size >= config.maxConcurrentSessions) {
      throw new Error(`Max concurrent sessions (${config.maxConcurrentSessions}) reached`);
    }

    const project = getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const sessionId = crypto.randomUUID();
    console.log(`[SessionManager] start ${sessionId} project=${projectId} sessionType=${sessionType}`);

    const projectDir = normalizePath(project.projectDir);
    const worktreePath = path.join(projectDir, '.claude', 'worktrees', sessionId);
    const branchName = `session/${sessionId}`;

    // Record the main repo's current branch before creating the worktree so we
    // can detect and restore it if the session accidentally changes it.
    let mainBranch: string | undefined;
    try {
      mainBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectDir, encoding: 'utf8' }).trim();
      console.log(`[SessionManager] main branch before session: ${mainBranch}`);
    } catch (err) {
      console.warn(`[SessionManager] could not determine main branch: ${err}`);
    }

    try {
      // Pass HEAD explicitly so git never has to guess the start-point, which
      // avoids an obscure git edge case where omitting the commit-ish can
      // trigger unexpected branch resolution in some git versions.
      execSync(`git worktree add "${worktreePath}" -b "${branchName}" HEAD`, {
        cwd: projectDir,
      });
    } catch (err) {
      console.error(`[SessionManager] failed to create worktree for ${sessionId}: ${err}`);
      throw err;
    }

    const isUnixStylePath = worktreePath.startsWith('/c/') || worktreePath.startsWith('/C/');
    console.log(
      `[SessionManager] worktree created: path=${worktreePath} branch=${branchName}` +
      (isUnixStylePath ? ' [WARNING: Unix-style path detected — may not resolve correctly on Windows]' : ''),
    );

    const notionTaskId = parseNotionPageId(taskUrl);

    const session = new AgentSession(
      sessionId,
      taskUrl,
      projectContextUrl,
      this.notionClient,
      worktreePath,
      notionTaskId,
      undefined,
      customPrompt,
      sessionType,
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
      session_type: sessionType,
    });

    // Broadcast session_started so connected frontends see the card immediately
    this.emit('message', {
      type: 'session_started',
      sessionId,
      taskName: taskUrl,
      notionTaskUrl: taskUrl,
      ...(taskType != null && { taskType }),
      ...(sessionType !== 'standard' && { sessionType }),
      started_at: startedAt,
      project_id: projectId,
    } satisfies ServerMessage);

    this.sessions.set(sessionId, session);

    // Forward all session events to the WS layer via EventEmitter
    session.on('message', (msg: ServerMessage) => this.emit('message', msg));

    // Fire-and-forget — run() blocks until the subprocess exits, then clean up
    session.run()
      .then(() => this.cleanupWorktree(sessionId, worktreePath, branchName, session.prUrl, projectDir, mainBranch))
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
        return this.cleanupWorktree(sessionId, worktreePath, branchName, undefined, projectDir, mainBranch);
      });

    return sessionId;
  }

  private cleanupWorktree(
    sessionId: string,
    worktreePath: string,
    branchName: string,
    prUrl: string | undefined,
    projectDir: string,
    mainBranch?: string,
  ): void {
    this.sessions.delete(sessionId);

    // Check if the main repo has unexpected modifications after session ends.
    // This catches worktree-escape bugs where a session edited the main repo
    // instead of its assigned worktree.
    try {
      const dirty = execSync('git status --porcelain', { cwd: projectDir, encoding: 'utf8' }).trim();
      if (dirty) {
        console.warn(
          `[SessionManager] [WARNING] Main repo has uncommitted changes after session ${sessionId.slice(0, 8)} ended — possible worktree escape:\n${dirty}`,
        );
      }
    } catch (err) {
      console.error(`[SessionManager] failed to check main repo status after session ${sessionId.slice(0, 8)}: ${err}`);
    }

    // Restore the main repo's branch if the session inadvertently changed it.
    // This guards against the Claude subprocess (or a git worktree edge case)
    // switching the main directory's checked-out branch during the session.
    if (mainBranch) {
      try {
        const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectDir, encoding: 'utf8' }).trim();
        if (currentBranch !== mainBranch) {
          console.warn(
            `[SessionManager] [WARNING] Main repo branch changed from "${mainBranch}" to "${currentBranch}" during session ${sessionId.slice(0, 8)} — restoring`,
          );
          execSync(`git checkout "${mainBranch}"`, { cwd: projectDir });
          console.log(`[SessionManager] main repo branch restored to "${mainBranch}"`);
        }
      } catch (err) {
        console.error(`[SessionManager] failed to check/restore main repo branch after session ${sessionId.slice(0, 8)}: ${err}`);
      }
    }

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

  /**
   * Send a message to a session, resuming it first if it is no longer live.
   *
   * If the session is still in the sessions map (running), the message is
   * delivered via send() directly. Otherwise, a new AgentSession is spawned
   * with --resume <sessionId> so the CLI restores the conversation history,
   * and the message is sent once the session emits its first event.
   */
  async sendOrResume(sessionId: string, text: string): Promise<void> {
    // Live session — deliver directly
    if (this.sessions.has(sessionId)) {
      this.send(sessionId, text);
      return;
    }

    // Session not live — look up details from DB and re-launch with --resume
    const row = getSession(sessionId);
    if (!row) {
      console.error(`[SessionManager] sendOrResume: session ${sessionId} not found in DB`);
      return;
    }

    const project = getProjectById(row.project_id ?? '');
    if (!project) {
      console.error(`[SessionManager] sendOrResume: project not found for session ${sessionId}`);
      return;
    }

    const newSessionId = crypto.randomUUID();
    const projectDir = normalizePath(project.projectDir);
    const worktreePath = path.join(projectDir, '.claude', 'worktrees', newSessionId);
    const branchName = `session/${newSessionId}`;

    // Record the main repo's current branch before creating the worktree.
    let mainBranchResume: string | undefined;
    try {
      mainBranchResume = execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectDir, encoding: 'utf8' }).trim();
      console.log(`[SessionManager] sendOrResume main branch before session: ${mainBranchResume}`);
    } catch (err) {
      console.warn(`[SessionManager] sendOrResume: could not determine main branch: ${err}`);
    }

    try {
      execSync(`git worktree add "${worktreePath}" -b "${branchName}" HEAD`, {
        cwd: projectDir,
      });
    } catch (err) {
      console.error(`[SessionManager] sendOrResume: failed to create worktree: ${err}`);
      throw err;
    }

    const isUnixStylePathResume = worktreePath.startsWith('/c/') || worktreePath.startsWith('/C/');
    console.log(
      `[SessionManager] sendOrResume worktree created: path=${worktreePath} branch=${branchName}` +
      (isUnixStylePathResume ? ' [WARNING: Unix-style path detected — may not resolve correctly on Windows]' : ''),
    );

    const taskUrl = row.notion_task_url ?? '';
    const projectContextUrl = row.project_context_url ?? '';
    const taskId = row.notion_task_id ?? '';

    const session = new AgentSession(
      newSessionId,
      taskUrl,
      projectContextUrl,
      this.notionClient,
      worktreePath,
      taskId,
      sessionId, // resumeSessionId — restores conversation history via --resume
    );

    const startedAt = Date.now();
    insertSession({
      session_id: newSessionId,
      notion_task_id: taskId,
      notion_task_url: taskUrl,
      project_context_url: projectContextUrl,
      project_id: row.project_id,
      status: 'starting',
      started_at: startedAt,
      ended_at: null,
      pr_url: null,
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

    session.run()
      .then(() => this.cleanupWorktree(newSessionId, worktreePath, branchName, session.prUrl, projectDir, mainBranchResume))
      .catch((err) => {
        console.error(`[SessionManager] resumed session ${newSessionId} error: ${err}`);
        if (!session.hasEnded) {
          updateSessionStatus(newSessionId, 'error', Date.now());
          this.emit('message', {
            type: 'session_ended',
            sessionId: newSessionId,
            status: 'error',
          } satisfies ServerMessage);
        }
        return this.cleanupWorktree(newSessionId, worktreePath, branchName, undefined, projectDir, mainBranchResume);
      });

    await firstEvent;
  }

  async shutdownAll(): Promise<void> {
    const kills = [...this.sessions.keys()].map((id) => this.kill(id));
    await Promise.allSettled(kills);
  }
}
