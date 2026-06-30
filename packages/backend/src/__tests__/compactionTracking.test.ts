import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';

// ── Mock child_process.spawn ───────────────────────────────────────────────

function createMockProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdinChunks: string[] = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinChunks.push(chunk.toString());
      cb();
    },
  });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    pid: 42000,
  });
  return { proc, stdinChunks, stdout, stderr };
}

let mockProc: ReturnType<typeof createMockProc>;

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockProc.proc),
  execFile: vi.fn(),
}));

// ── Mock DB queries ────────────────────────────────────────────────────────

const mockIncrementCompactionCount = vi.fn();

vi.mock('../db/queries', () => ({
  upsertSessionEvent: vi.fn(() => 1),
  insertPermissionEvent: vi.fn(),
  updateSessionStatus: vi.fn(),
  markSessionDone: vi.fn(),
  markSessionIdle: vi.fn(),
  getEventsBySession: vi.fn(() => []),
  getRules: vi.fn(() => []),
  insertPermissionDenial: vi.fn(),
  upsertPullRequest: vi.fn(),
  insertSessionAudit: vi.fn(),
  incrementTokens: vi.fn(),
  incrementCompactionCount: (...args: unknown[]) =>
    mockIncrementCompactionCount(...args),
  setContextOccupancy: vi.fn(),
  setSessionModel: vi.fn(),
  getPRBySessionId: vi.fn(() => null),
  getPRByNotionTaskId: vi.fn(() => null),
  getPRByNumber: vi.fn(() => null),
  setHeadSha: vi.fn(),
  setPauseReason: vi.fn(),
  getSession: vi.fn(() => null),
  getProjectRowById: vi.fn(() => null),
  insertLocalBranch: vi.fn(),
  setSessionMetadata: vi.fn(),
  setSessionLastErrorDetail: vi.fn(),
}));

vi.mock('../orchestration/localBranchHelpers', () => ({
  getCurrentBranch: vi.fn(async () => 'feature/some-task'),
  hasNonEmptyDiff: vi.fn(async () => false),
}));

vi.mock('../github/NoOpInvestigator', () => ({
  NoOpInvestigator: vi.fn().mockImplementation(() => ({
    investigate: vi.fn(async () => {}),
  })),
}));

import { AgentSession } from '../session/AgentSession';
import type { ServerMessage } from '../ws/types';

describe('compaction tracking — AgentSession', () => {
  beforeEach(() => {
    mockProc = createMockProc();
    vi.clearAllMocks();
  });

  it('increments compactionCount and persists on compact_boundary event', async () => {
    const session = new AgentSession(
      'cmp-session-1',
      'https://notion.so/task',
      'https://notion.so/ctx',
      undefined,
      '/tmp',
      'task-1',
    );

    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    const runPromise = session.run();

    mockProc.stdout.push(
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        session_id: 'cmp-session-1',
        uuid: 'abc-uuid-1',
        compact_metadata: {
          trigger: 'auto',
          pre_tokens: 167135,
          post_tokens: 16285,
          duration_ms: 97390,
        },
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(mockIncrementCompactionCount).toHaveBeenCalledWith('cmp-session-1');

    const updatedMessages = messages.filter(
      (m) => m.type === 'session_updated' && 'compactionCount' in m,
    );
    expect(updatedMessages).toHaveLength(1);
    expect(
      (updatedMessages[0] as { compactionCount?: number }).compactionCount,
    ).toBe(1);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  it('increments counter correctly for 3 compact_boundary events', async () => {
    const session = new AgentSession(
      'cmp-session-2',
      'https://notion.so/task',
      'https://notion.so/ctx',
      undefined,
      '/tmp',
      'task-2',
    );

    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    const runPromise = session.run();

    const compactEvent = (uuid: string) =>
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        session_id: 'cmp-session-2',
        uuid,
        compact_metadata: {
          trigger: 'auto',
          pre_tokens: 200000,
          post_tokens: 5000,
          duration_ms: 60000,
        },
      }) + '\n';

    mockProc.stdout.push(compactEvent('uuid-1'));
    mockProc.stdout.push(compactEvent('uuid-2'));
    mockProc.stdout.push(compactEvent('uuid-3'));
    await new Promise((r) => setTimeout(r, 50));

    expect(mockIncrementCompactionCount).toHaveBeenCalledTimes(3);
    expect(mockIncrementCompactionCount).toHaveBeenCalledWith('cmp-session-2');

    const updatedMessages = messages.filter(
      (m) => m.type === 'session_updated' && 'compactionCount' in m,
    ) as Array<{ compactionCount?: number }>;
    const counts = updatedMessages.map((m) => m.compactionCount);
    expect(counts).toContain(3);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  it('includes compactionCount in session_updated broadcast payload', async () => {
    const session = new AgentSession(
      'cmp-session-3',
      'https://notion.so/task',
      'https://notion.so/ctx',
      undefined,
      '/tmp',
      'task-3',
    );

    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    const runPromise = session.run();

    mockProc.stdout.push(
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        session_id: 'cmp-session-3',
        uuid: 'uuid-x',
        compact_metadata: {
          trigger: 'manual',
          pre_tokens: 150000,
          post_tokens: 8000,
          duration_ms: 55000,
        },
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 50));

    const updatedMsg = messages.find(
      (m) => m.type === 'session_updated' && 'compactionCount' in m,
    );
    expect(updatedMsg).toBeDefined();
    expect(updatedMsg).toMatchObject({
      type: 'session_updated',
      sessionId: 'cmp-session-3',
      compactionCount: 1,
    });

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  it('does not pause or kill on any compaction count (no side-effects)', async () => {
    const session = new AgentSession(
      'cmp-session-4',
      'https://notion.so/task',
      'https://notion.so/ctx',
      undefined,
      '/tmp',
      'task-4',
    );

    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    const runPromise = session.run();

    for (let i = 0; i < 10; i++) {
      mockProc.stdout.push(
        JSON.stringify({
          type: 'system',
          subtype: 'compact_boundary',
          session_id: 'cmp-session-4',
          uuid: `uuid-${i}`,
          compact_metadata: {
            trigger: 'auto',
            pre_tokens: 200000,
            post_tokens: 10000,
            duration_ms: 80000,
          },
        }) + '\n',
      );
    }
    await new Promise((r) => setTimeout(r, 50));

    const pausedMessages = messages.filter(
      (m) =>
        m.type === 'stuck_session_paused' ||
        m.type === 'stuck_session_killed' ||
        m.type === 'api_overloaded_paused',
    );
    expect(pausedMessages).toHaveLength(0);
    expect(mockProc.proc.kill).not.toHaveBeenCalled();

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });
});

// ── Schema: migration guard ─────────────────────────────────────────────────

describe('runMigrations() — compaction_count column', () => {
  it('adds compaction_count column with try/catch for idempotency', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'schema.ts'),
      'utf-8',
    );
    expect(source).toMatch(/ALTER TABLE sessions ADD COLUMN.*compaction_count/);
  });

  it('wraps compaction_count column addition in try/catch', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'schema.ts'),
      'utf-8',
    );
    const match = source.match(/try\s*\{[^}]*compaction_count[^}]*\}/s);
    expect(match).not.toBeNull();
  });
});
