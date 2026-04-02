import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { EventEmitter } from 'events';
import { AgentSession, parseNotionPageId } from './AgentSession';
import { buildOrchestratorClaudeMd } from './orchestrator-claudemd';
import { config, getProjectById, normalizePath } from '../config';
import { insertSession, updateSessionStatus, insertEvent, getSession, getSessionsByStatus, getPRByNotionTaskId } from '../db/queries';
import type { Session } from '../db/types';
import type { NotionClient } from '../notion/NotionClient';
import type { GitHubClient } from '../github/GitHubClient';
import type { ServerMessage } from '../ws/types';

export interface StartOptions {
  taskType?: string;
  sessionType?: 'standard' | 'review';
  customPrompt?: string;
  projectId?: string;
  taskName?: string;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, AgentSession>();

  constructor(
    private readonly notionClient: NotionClient,
    private readonly githubClient?: GitHubClient,
  ) {
    super();
  }

  start(taskUrl: string, projectContextUrl: string, options?: StartOptions): string {
    const { taskType, sessionType = 'standard', customPrompt, projectId = '', taskName } = options ?? {};

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

    // Inject merged CLAUDE.md into the worktree: orchestrator rules first (authoritative),
    // project CLAUDE.md appended below. The project's original file is never modified.
    try {
      const orchestratorMd = buildOrchestratorClaudeMd({
        taskName: taskName ?? taskUrl,
        taskUrl,
        projectContextUrl,
        targetBranch: 'dev',
      });
      const projectMdPath = path.join(projectDir, 'CLAUDE.md');
      const projectMd = fs.existsSync(projectMdPath) ? fs.readFileSync(projectMdPath, 'utf-8') : '';
      const merged = projectMd
        ? `${orchestratorMd}\n\n---\n\n# Project Instructions\n\n${projectMd}`
        : orchestratorMd;
      fs.writeFileSync(path.join(worktreePath, 'CLAUDE.md'), merged, 'utf-8');
      console.log(`[SessionManager] orchestrator CLAUDE.md written to worktree for ${sessionId.slice(0, 8)}`);
    } catch (err) {
      console.error(`[SessionManager] failed to write orchestrator CLAUDE.md for ${sessionId}: ${err}`);
    }

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
      this,
      this.githubClient,
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

    if (sessionType === 'standard') {
      this.notionClient.updateStatus(notionTaskId, '🔄 In Progress').catch((e) =>
        console.error(`[SessionManager] failed to set In Progress: ${e}`),
      );
    }

    // Look up the PR number for review sessions so the card can display "Review of #N"
    const reviewPrNumber = sessionType === 'review' && notionTaskId
      ? (getPRByNotionTaskId(notionTaskId)?.pr_number ?? undefined)
      : undefined;

    // Broadcast session_started so connected frontends see the card immediately
    this.emit('message', {
      type: 'session_started',
      sessionId,
      taskName: taskName ?? taskUrl,
      notionTaskUrl: taskUrl,
      ...(taskType != null && { taskType }),
      ...(sessionType !== 'standard' && { sessionType }),
      ...(reviewPrNumber != null && { prNumber: reviewPrNumber }),
      started_at: startedAt,
      project_id: projectId,
    } satisfies ServerMessage);

    this.sessions.set(sessionId, session);
    this.wireSession(sessionId, session, projectDir, branchName, worktreePath, mainBranch);

    return sessionId;
  }

  /**
   * Wire up event forwarding and fire-and-forget run() for a session.
   * Used by both start() and resumeSession() to avoid duplicating this logic.
   */
  private wireSession(
    sessionId: string,
    session: AgentSession,
    projectDir: string,
    branchName: string,
    worktreePath: string,
    mainBranch?: string,
  ): void {
    // Forward all session events to the WS layer via EventEmitter
    session.on('message', (msg: ServerMessage) => this.emit('message', msg));
    // Forward pr_opened so ReviewOrchestrator can subscribe at the SessionManager level
    session.on('pr_opened', (job: unknown) => this.emit('pr_opened', job));
    // Forward push_detected so ReviewOrchestrator can trigger re-reviews
    session.on('push_detected', (payload: unknown) => this.emit('push_detected', payload));

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
  }

  /**
   * Re-attach to a session that was running when the server last shut down.
   * Unlike sendOrResume(), this keeps the original session_id so the UI shows
   * continuity — same card, same transcript.
   */
  private async resumeSession(row: Session): Promise<void> {
    const project = getProjectById(row.project_id ?? '');
    if (!project) {
      console.warn(`[SessionManager] orphan ${row.session_id}: project not found, marking error`);
      updateSessionStatus(row.session_id, 'error', Date.now());
      return;
    }

    const projectDir = normalizePath(project.projectDir);
    let worktreePath = row.worktree_path ?? '';
    let branchName: string;

    // Re-use the existing worktree if it is still on disk; otherwise create a fresh one.
    if (worktreePath && fs.existsSync(worktreePath)) {
      // Derive the branch from the worktree's HEAD so cleanupWorktree can delete it.
      try {
        branchName = execSync('git rev-parse --abbrev-ref HEAD', { cwd: worktreePath, encoding: 'utf8' }).trim();
      } catch {
        branchName = `session/${row.session_id}`;
      }
      console.log(`[SessionManager] resumeSession ${row.session_id}: re-using worktree ${worktreePath} (branch=${branchName})`);
    } else {
      branchName = `worktree-resume-${row.session_id.slice(0, 8)}`;
      worktreePath = path.join(projectDir, '.claude', 'worktrees', row.session_id);
      console.log(`[SessionManager] resumeSession ${row.session_id}: creating new worktree ${worktreePath} (branch=${branchName})`);
      execSync(`git worktree add "${worktreePath}" -b "${branchName}" HEAD`, {
        cwd: projectDir,
      });
    }

    const session = new AgentSession(
      row.session_id,           // keep original ID — same card, same transcript
      row.notion_task_url ?? '',
      row.project_context_url ?? '',
      this.notionClient,
      worktreePath,
      row.notion_task_id ?? '',
      row.session_id,           // resumeSessionId — passes --resume to CLI
      undefined,
      'standard',
      this,
      this.githubClient,
    );

    this.sessions.set(row.session_id, session);

    // Don't insert a new DB row — one already exists.
    // Update status to running and broadcast so the frontend sees it come back.
    updateSessionStatus(row.session_id, 'running');
    this.emit('message', { type: 'session_status', sessionId: row.session_id, status: 'running' } satisfies ServerMessage);

    this.wireSession(row.session_id, session, projectDir, branchName, worktreePath);
  }

  /**
   * Detect sessions still marked 'running' in the DB after a server restart
   * and resume them via --resume so they come back to life instead of lingering
   * as unkillable ghosts. Called from server.ts after migrations and imports.
   */
  async resumeOrphanSessions(): Promise<void> {
    const orphans = getSessionsByStatus(['running']);
    if (orphans.length === 0) return;
    console.log(`[SessionManager] found ${orphans.length} orphan session(s) — resuming`);

    const available = config.maxConcurrentSessions - this.sessions.size;
    const toResume = orphans.slice(0, available);
    const toError = orphans.slice(available);

    for (const row of toResume) {
      try {
        await this.resumeSession(row);
      } catch (err) {
        console.error(`[SessionManager] failed to resume ${row.session_id}: ${err}`);
        // Mark as error so it doesn't retry forever on subsequent restarts.
        updateSessionStatus(row.session_id, 'error', Date.now());
      }
    }

    for (const row of toError) {
      console.warn(`[SessionManager] max concurrent sessions reached — marking orphan ${row.session_id} as error`);
      updateSessionStatus(row.session_id, 'error', Date.now());
    }
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
      undefined,
      'standard',
      this,
      this.githubClient,
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
