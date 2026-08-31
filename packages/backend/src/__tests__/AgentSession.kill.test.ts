import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import { mockDbQueries } from './helpers/mockDbQueries';

// AgentSession imports spawn at module load time — mock before importing.
function createMockProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  return Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    pid: 12345,
    exitCode: null as number | null,
  });
}

vi.mock('child_process', () => ({
  spawn: vi.fn(() => createMockProc()),
  execFile: vi.fn(),
}));

vi.mock('../db/queries', () =>
  mockDbQueries({
    getSession: vi.fn(),
    updateSessionStatus: vi.fn(),
    setSessionTerminalCompletionReason: vi.fn(),
  }),
);

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

import { AgentSession } from '../session/AgentSession';
import { getSession, updateSessionStatus } from '../db/queries';
import type { NotionClient } from '../notion/NotionClient';
import type { ServerMessage } from '../ws/types';
import type { Session } from '../db/types';

function fakeNotionClient(): NotionClient {
  return {
    fetchReadyTasks: vi.fn(async () => []),
    updateStatus: vi.fn(async () => {}),
    attachPR: vi.fn(async () => {}),
  } as unknown as NotionClient;
}

function fakeSessionRow(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'sess-reclaimed',
    task_id: null,
    status: 'idle',
    session_type: 'standard',
    project_id: null,
    started_at: Date.now(),
    ended_at: null,
    archived: 1,
    pause_reason: null,
    ...overrides,
  } as unknown as Session;
}

describe('AgentSession.kill() after reclaimProcess()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('still calls markSessionErrored(killed, user_kill) even though reclaimProcess() already set hasEnded', async () => {
    // Simulates the automatic reclaim/archive path: the session's DB row
    // stays non-terminal (idle, archived) so it can resume, but the
    // in-memory AgentSession's hasEnded flag flips to true.
    const row = fakeSessionRow({ status: 'idle' });
    vi.mocked(getSession).mockReturnValue(row);

    const markSessionErrored = vi.fn();
    const sessionManager = { markSessionErrored } as any;

    const notion = fakeNotionClient();
    const session = new AgentSession(
      'sess-reclaimed',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
      undefined,
      undefined,
      'standard',
      sessionManager,
    );

    await session.reclaimProcess();
    expect(session.hasEnded).toBe(true);

    await session.kill();

    expect(markSessionErrored).toHaveBeenCalledWith(
      'sess-reclaimed',
      'killed',
      'user_kill',
      'killed by user request',
    );
  });

  it('falls back to a direct DB write + session_ended broadcast when no sessionManager is present, despite hasEnded already being true', async () => {
    const row = fakeSessionRow({ status: 'idle' });
    vi.mocked(getSession).mockReturnValue(row);

    const notion = fakeNotionClient();
    const session = new AgentSession(
      'sess-reclaimed-nomgr',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
    );

    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    await session.reclaimProcess();
    expect(session.hasEnded).toBe(true);

    await session.kill();

    expect(updateSessionStatus).toHaveBeenCalledWith(
      'sess-reclaimed-nomgr',
      'killed',
      expect.any(Number),
    );
    const ended = messages.find((m) => m.type === 'session_ended');
    expect(ended).toBeDefined();
    expect((ended as { status: string }).status).toBe('killed');
  });

  it('does NOT double-write when the DB row is already genuinely terminal', async () => {
    const row = fakeSessionRow({ status: 'killed' });
    vi.mocked(getSession).mockReturnValue(row);

    const markSessionErrored = vi.fn();
    const sessionManager = { markSessionErrored } as any;

    const notion = fakeNotionClient();
    const session = new AgentSession(
      'sess-already-killed',
      'https://notion.so/task',
      'https://notion.so/ctx',
      notion,
      '/tmp',
      'task-id',
      undefined,
      undefined,
      'standard',
      sessionManager,
    );

    await session.kill();

    expect(markSessionErrored).not.toHaveBeenCalled();
    expect(updateSessionStatus).not.toHaveBeenCalled();
  });
});
