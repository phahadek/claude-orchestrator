import { AgentSession } from './AgentSession';

const PROJECT_DIR = process.env.PROJECT_DIR ?? process.cwd();

export class SessionManager {
  private sessions = new Map<string, AgentSession>();

  async start(taskUrl: string, projectContextUrl: string): Promise<string> {
    const sessionId = crypto.randomUUID();
    const session = new AgentSession(sessionId, taskUrl, projectContextUrl, PROJECT_DIR);
    this.sessions.set(sessionId, session);
    console.log(`[SessionManager] start ${sessionId}`);
    return sessionId;
  }

  async kill(sessionId: string): Promise<void> {
    console.log(`[SessionManager] kill ${sessionId}`);
    this.sessions.delete(sessionId);
  }

  async send(sessionId: string, message: string): Promise<void> {
    console.log(`[SessionManager] send to ${sessionId}: ${message}`);
  }

  async approve(sessionId: string): Promise<void> {
    console.log(`[SessionManager] approve ${sessionId}`);
  }

  async deny(sessionId: string, reason?: string): Promise<void> {
    console.log(`[SessionManager] deny ${sessionId}: ${reason}`);
  }

  async shutdownAll(): Promise<void> {
    const kills = [...this.sessions.keys()].map((id) => this.kill(id));
    await Promise.allSettled(kills);
  }
}
