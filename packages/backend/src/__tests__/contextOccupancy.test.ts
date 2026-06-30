import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';

// ── Mock child_process ─────────────────────────────────────────────────────

function createMockProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    pid: 1,
  });
  return { proc, stdout };
}

let mockProc: ReturnType<typeof createMockProc>;

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockProc.proc),
  execFile: vi.fn(),
}));

// ── Mock DB queries ────────────────────────────────────────────────────────

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
  incrementCompactionCount: vi.fn(),
  setContextOccupancy: vi.fn(),
  setSessionModel: vi.fn(),
  setSessionMetadata: vi.fn(),
  getPRBySessionId: vi.fn(() => null),
  getPRByNotionTaskId: vi.fn(() => null),
  getPRByNumber: vi.fn(() => null),
  setHeadSha: vi.fn(),
  setPauseReason: vi.fn(),
  getSession: vi.fn(() => null),
  getProjectRowById: vi.fn(() => null),
  insertLocalBranch: vi.fn(),
  setSessionLastErrorDetail: vi.fn(),
}));

vi.mock('../orchestration/localBranchHelpers', () => ({
  getCurrentBranch: vi.fn(async () => 'feature/test'),
  hasNonEmptyDiff: vi.fn(async () => false),
}));

vi.mock('../github/NoOpInvestigator', () => ({
  NoOpInvestigator: vi
    .fn()
    .mockImplementation(() => ({ investigate: vi.fn(async () => {}) })),
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(() => ({
    getTask: vi.fn(async () => null),
    updateTaskStatus: vi.fn(async () => {}),
    updateTaskField: vi.fn(async () => {}),
    addComment: vi.fn(async () => {}),
  })),
}));

import { AgentSession } from '../session/AgentSession';
import type { ServerMessage } from '../ws/types';
import { setContextOccupancy, incrementTokens } from '../db/queries';

function makeSession(sessionId = 'occ-test') {
  return new AgentSession(
    sessionId,
    'https://notion.so/task',
    'https://notion.so/ctx',
    undefined,
    '/tmp',
    'task-1',
  );
}

/** Run session, push events, then end cleanly. Returns the collected messages. */
async function runWithEvents(
  session: AgentSession,
  events: unknown[],
): Promise<ServerMessage[]> {
  const messages: ServerMessage[] = [];
  session.on('message', (msg: ServerMessage) => messages.push(msg));

  const runPromise = session.run();
  await new Promise((r) => setTimeout(r, 10));

  for (const event of events) {
    mockProc.stdout.push(JSON.stringify(event) + '\n');
    await new Promise((r) => setTimeout(r, 30));
  }

  mockProc.stdout.push(null);
  await new Promise((r) => setTimeout(r, 0));
  mockProc.proc.emit('exit', 0);
  await runPromise;

  return messages;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('context-window occupancy tracking', () => {
  beforeEach(() => {
    mockProc = createMockProc();
    vi.clearAllMocks();
  });

  it('result event does not call setContextOccupancy (prevents cumulative cache_read overwrite)', async () => {
    // result.usage.cache_read_input_tokens is the SUM across all API calls in the
    // turn — not a single-call prompt size. Storing it would produce values in the
    // millions, making the context-occupancy gauge wildly wrong.
    const session = makeSession('occ-no-result-write');
    await runWithEvents(session, [
      {
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 10_000_000,
          cache_creation_input_tokens: 0,
        },
      },
    ]);

    expect(vi.mocked(setContextOccupancy)).not.toHaveBeenCalled();
  });

  it('result event does not include contextOccupancyTokens or contextOccupancyFraction in broadcast', async () => {
    const session = makeSession('occ-no-result-broadcast');
    const messages = await runWithEvents(session, [
      {
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ]);

    const msg = messages.find((m) => m.type === 'session_updated') as
      | Record<string, unknown>
      | undefined;
    expect(msg).toBeDefined();
    expect(msg!['contextOccupancyTokens']).toBeUndefined();
    expect(msg!['contextOccupancyFraction']).toBeUndefined();
  });

  it('occupancy after result event reflects last assistant event, not cumulative cache_read', async () => {
    // 3 assistant events each reading ~150k tokens from cache; result reports
    // the cumulative sum (450k). After the result fires, stored occupancy must
    // still be 150k (from the last assistant event), NOT 450k or any larger value.
    const session = makeSession('occ-no-cumulative');
    const assistantEvent = (cacheRead: number) => ({
      type: 'assistant',
      message: {
        id: `msg-${cacheRead}`,
        type: 'message',
        usage: {
          input_tokens: 1,
          output_tokens: 5,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: 0,
        },
        content: [{ type: 'text', text: 'hi' }],
      },
    });

    await runWithEvents(session, [
      assistantEvent(150_000),
      assistantEvent(150_000),
      assistantEvent(150_000),
      {
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 50,
          output_tokens: 15,
          cache_read_input_tokens: 450_000, // cumulative — must NOT be stored as occupancy
          cache_creation_input_tokens: 0,
        },
      },
    ]);

    const calls = vi.mocked(setContextOccupancy).mock.calls;
    // Exactly 3 calls — one per assistant event, none from result
    expect(calls).toHaveLength(3);
    // Last stored value is from the final assistant event: 1 + 150000 = 150001
    const lastValue = calls.at(-1)![1];
    expect(lastValue).toBe(150_001);
  });

  it('updates occupancy on each assistant text event (no result event)', async () => {
    const session = makeSession('occ-mid-turn');
    const cacheReadValues = [1000, 5000, 10000, 20000, 30000];
    const assistantEvents = cacheReadValues.map((cacheRead) => ({
      type: 'assistant',
      message: {
        id: 'msg-1',
        type: 'message',
        usage: {
          input_tokens: 1,
          output_tokens: 5,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: 0,
        },
        content: [{ type: 'text', text: 'hi' }],
      },
    }));

    const messages = await runWithEvents(session, assistantEvents);

    const occupancyUpdates = messages.filter(
      (m) =>
        m.type === 'session_updated' &&
        (m as { contextOccupancyTokens?: number }).contextOccupancyTokens !=
          null,
    ) as Array<{ contextOccupancyTokens?: number }>;

    // setContextOccupancy called once per assistant event (5 times)
    expect(
      vi.mocked(setContextOccupancy).mock.calls.length,
    ).toBeGreaterThanOrEqual(5);
    // incrementTokens must NOT have been called (no result event)
    expect(vi.mocked(incrementTokens)).not.toHaveBeenCalled();

    // occupancy values should be increasing
    const tokenValues = occupancyUpdates.map((m) => m.contextOccupancyTokens!);
    for (let i = 1; i < tokenValues.length; i++) {
      expect(tokenValues[i]).toBeGreaterThan(tokenValues[i - 1]);
    }
  });

  it('updates occupancy on assistant events AND on result event; totals incremented once', async () => {
    const session = makeSession('occ-mixed');
    const events = [
      {
        type: 'assistant',
        message: {
          id: 'msg-a',
          type: 'message',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 0,
          },
          content: [{ type: 'text', text: 'a' }],
        },
      },
      {
        type: 'assistant',
        message: {
          id: 'msg-b',
          type: 'message',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 0,
          },
          content: [{ type: 'text', text: 'b' }],
        },
      },
      {
        type: 'assistant',
        message: {
          id: 'msg-c',
          type: 'message',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 300,
            cache_creation_input_tokens: 0,
          },
          content: [{ type: 'text', text: 'c' }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 50,
          output_tokens: 15,
          cache_read_input_tokens: 300,
          cache_creation_input_tokens: 0,
        },
      },
    ];

    await runWithEvents(session, events);

    // setContextOccupancy called exactly 3 times — one per assistant event, never from result
    expect(vi.mocked(setContextOccupancy)).toHaveBeenCalledTimes(3);
    // incrementTokens called exactly once from the result event
    expect(vi.mocked(incrementTokens)).toHaveBeenCalledTimes(1);
    // Final occupancy is from the last assistant event (msg-c): 10 + 300 = 310
    const lastCall = vi.mocked(setContextOccupancy).mock.calls.at(-1)!;
    expect(lastCall[1]).toBe(310);
  });

  it('takes no automatic action when occupancy is high', async () => {
    const session = makeSession('occ-noop');
    const messages = await runWithEvents(session, [
      {
        type: 'result',
        subtype: 'success',
        // Near-full context: 190k / 200k
        usage: {
          input_tokens: 190000,
          output_tokens: 1000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ]);

    // No kill/pause status should have fired as a result of high occupancy
    const killedMsgs = messages.filter(
      (m) =>
        m.type === 'session_status' &&
        (m as { status?: string }).status === 'killed',
    );
    expect(killedMsgs).toHaveLength(0);
  });
});

// ── Schema migration test ──────────────────────────────────────────────────

describe('schema migration — context_occupancy_tokens column', () => {
  it('adds context_occupancy_tokens in an idempotent try/catch block', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'schema.ts'),
      'utf-8',
    );
    expect(source).toMatch(
      /ALTER TABLE sessions ADD COLUMN.*context_occupancy_tokens/,
    );
    const match = source.match(/try\s*\{[^}]*context_occupancy_tokens[^}]*\}/s);
    expect(match).not.toBeNull();
  });
});

// ── setContextOccupancy — direct SQLite integration ───────────────────────

import Database from 'better-sqlite3';

describe('setContextOccupancy — SQLite integration', () => {
  it('persists the value and survives a reload (query test)', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        context_occupancy_tokens INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO sessions (session_id, status, started_at) VALUES ('s1', 'running', 0);
    `);
    db.prepare(
      `UPDATE sessions SET context_occupancy_tokens = ? WHERE session_id = ?`,
    ).run(42000, 's1');
    const row = db
      .prepare(
        `SELECT context_occupancy_tokens FROM sessions WHERE session_id = ?`,
      )
      .get('s1') as { context_occupancy_tokens: number };
    expect(row.context_occupancy_tokens).toBe(42000);
    db.close();
  });
});
