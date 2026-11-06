import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config')>();
  return {
    ...actual,
    ALLOWED_TOOLS: [],
    GITHUB_REPO: 'owner/repo',
    config: {},
    runtimeSettings: {
      sessionMode: 'cli',
      session_mode: 'cli',
      max_concurrent_code_sessions: 10,
    },
    normalizePath: (p: string) => p,
    getProjectById: vi.fn(() => ({
      id: 'proj-1',
      name: 'Test',
      baseBranch: 'dev',
    })),
  };
});
vi.mock('../sessionRecovery', () => ({
  recoverSession: vi.fn(async () => {}),
}));

import { db } from '../../db/db';
import {
  insertSession,
  upsertSessionEvent,
  setSessionPauseReason,
  clearSessionPauseReasonIf,
} from '../../db/queries';
import { AgentSession } from '../AgentSession';
import type { ISessionRunner } from '../SessionRunner';
import type { ISessionManager } from '../SessionAuditor';
import type { TaskBackend } from '../../tasks/TaskBackend';

function seed(sessionId: string, sessionType = 'standard'): void {
  insertSession({
    session_id: sessionId,
    task_id: 'task-1',
    task_url: 'https://notion.so/task-1',
    project_context_url: 'https://notion.so/ctx',
    status: 'running',
    started_at: Date.now(),
    session_type: sessionType,
  });
}

function reasonOf(sessionId: string): string | null {
  return (
    db
      .prepare('SELECT pause_reason FROM sessions WHERE session_id = ?')
      .get(sessionId) as { pause_reason: string | null }
  ).pause_reason;
}

function clearedAuditCount(): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'session_pause_reason_cleared'",
      )
      .get() as { n: number }
  ).n;
}

function makeSession(sessionId: string, sessionType = 'standard') {
  const runner: ISessionRunner = {
    run: vi.fn(() => new Promise<number | null>(() => {})),
    sendMessage: vi.fn(),
    endSession: vi.fn(async () => false),
    kill: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    hasSpawnError: false,
  };
  const sm = { markSessionErrored: vi.fn(), send: vi.fn(), isAlive: vi.fn() };
  const session = new AgentSession(
    sessionId,
    'https://notion.so/task',
    'https://notion.so/ctx',
    {
      type: 'notion',
      fetchReadyTasks: vi.fn(async () => []),
      attachPR: vi.fn(async () => {}),
      updateStatus: vi.fn(async () => {}),
      fetchTaskPage: vi.fn(async () => ''),
    } as unknown as TaskBackend,
    '/tmp/worktree',
    'notion:task-abc',
    undefined,
    undefined,
    sessionType,
    sm as unknown as ISessionManager,
    undefined,
    [],
    undefined,
    runner,
  );
  return session as unknown as {
    handleRawEvent(e: Record<string, unknown>): void;
    wasLastEventSuccessfulResult(): boolean;
  };
}

function addEvent(sessionId: string, payload: Record<string, unknown>): void {
  upsertSessionEvent({
    session_id: sessionId,
    event_type: 'system',
    payload: JSON.stringify(payload),
    timestamp: Date.now(),
  });
}

beforeEach(() => {
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM session_events').run();
});

describe('clearSessionPauseReasonIf', () => {
  it('clears only a listed reason and audits it', () => {
    seed('s1');
    setSessionPauseReason('s1', 'stalled_idle');
    expect(clearSessionPauseReasonIf('s1', ['stalled_idle'], 'x')).toBe(true);
    expect(reasonOf('s1')).toBeNull();
    expect(clearedAuditCount()).toBe(1);
  });

  it('leaves a different reason intact and writes no audit row', () => {
    seed('s2');
    setSessionPauseReason('s2', 'mcp_unreachable_exhausted');
    expect(clearSessionPauseReasonIf('s2', ['stalled_idle'], 'x')).toBe(false);
    expect(reasonOf('s2')).toBe('mcp_unreachable_exhausted');
    expect(clearedAuditCount()).toBe(0);
  });
});

describe('AgentSession pause_reason lifecycle', () => {
  it('init with orchestrator status pending sets no pause reason; failed does', () => {
    seed('s3');
    const s = makeSession('s3');
    const init = (status: string) => ({
      type: 'system',
      subtype: 'init',
      mcp_servers: [{ name: 'orchestrator', status }],
    });
    s.handleRawEvent(init('pending'));
    expect(reasonOf('s3')).toBeNull();
    s.handleRawEvent(init('failed'));
    expect(reasonOf('s3')).toBe('orchestrator_mcp_connect_failed');
  });

  it('a successful result clears liveness reasons but not others', () => {
    seed('s4');
    const s = makeSession('s4');
    setSessionPauseReason('s4', 'runner_killed_unexpected');
    s.handleRawEvent({ type: 'result', is_error: false });
    expect(reasonOf('s4')).toBeNull();

    setSessionPauseReason('s4', 'stalled_idle');
    s.handleRawEvent({ type: 'result', is_error: false });
    expect(reasonOf('s4')).toBeNull();

    for (const r of [
      'awaiting_operator_conclusion',
      'mcp_unreachable_exhausted',
    ]) {
      setSessionPauseReason('s4', r);
      s.handleRawEvent({ type: 'result', is_error: false });
      expect(reasonOf('s4')).toBe(r);
    }
  });

  it('an error result does not clear a liveness reason', () => {
    seed('s5');
    const s = makeSession('s5');
    setSessionPauseReason('s5', 'stalled_idle');
    s.handleRawEvent({ type: 'result', is_error: true });
    expect(reasonOf('s5')).toBe('stalled_idle');
  });

  it('wasLastEventSuccessfulResult skips trailing tool_progress rows', () => {
    seed('s6');
    const s = makeSession('s6');
    addEvent('s6', { type: 'result', is_error: false });
    addEvent('s6', { type: 'tool_progress' });
    addEvent('s6', { type: 'tool_progress' });
    expect(s.wasLastEventSuccessfulResult()).toBe(true);
  });

  it('wasLastEventSuccessfulResult stays false mid-turn', () => {
    seed('s7');
    const s = makeSession('s7');
    addEvent('s7', { type: 'tool_use', name: 'Bash' });
    addEvent('s7', { type: 'tool_progress' });
    expect(s.wasLastEventSuccessfulResult()).toBe(false);
  });
});
