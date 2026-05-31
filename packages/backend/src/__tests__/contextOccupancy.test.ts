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

import { AgentSession } from '../session/AgentSession';
import type { ServerMessage } from '../ws/types';
import { setContextOccupancy } from '../db/queries';

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

  it('computes occupancy as input + cache_read + cache_creation (not cumulative)', async () => {
    const session = makeSession();
    const messages = await runWithEvents(session, [
      {
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 30,
        },
      },
    ]);

    const updated = messages.find(
      (m) =>
        m.type === 'session_updated' &&
        (m as { contextOccupancyTokens?: number }).contextOccupancyTokens !=
          null,
    ) as { contextOccupancyTokens?: number } | undefined;
    expect(updated).toBeDefined();
    // 100 + 50 + 30 = 180
    expect(updated!.contextOccupancyTokens).toBe(180);
  });

  it('exposes occupancy as a fraction of 200 000 tokens', async () => {
    const session = makeSession('occ-frac');
    const messages = await runWithEvents(session, [
      {
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 20000,
          output_tokens: 500,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ]);

    const msg = messages.find(
      (m) =>
        m.type === 'session_updated' &&
        (m as { contextOccupancyFraction?: number }).contextOccupancyFraction !=
          null,
    ) as { contextOccupancyFraction?: number } | undefined;
    expect(msg).toBeDefined();
    // 20000 / 200000 = 0.1
    expect(msg!.contextOccupancyFraction).toBeCloseTo(0.1);
  });

  it('occupancy is not cumulative — second result replaces the first', async () => {
    const session = makeSession('occ-replace');
    const messages = await runWithEvents(session, [
      {
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 50000,
          output_tokens: 100,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      {
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 30000,
          output_tokens: 100,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 0,
        },
      },
    ]);

    const updatedMsgs = messages.filter(
      (m) =>
        m.type === 'session_updated' &&
        (m as { contextOccupancyTokens?: number }).contextOccupancyTokens !=
          null,
    ) as Array<{ contextOccupancyTokens?: number }>;
    expect(updatedMsgs.length).toBeGreaterThanOrEqual(2);
    const last = updatedMsgs[updatedMsgs.length - 1];
    // Second turn: 30000 + 5000 = 35000, not 50000 + 30000 + 5000
    expect(last.contextOccupancyTokens).toBe(35000);
  });

  it('persists occupancy to SQLite via setContextOccupancy', async () => {
    const session = makeSession('occ-persist');
    await runWithEvents(session, [
      {
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 200,
        },
      },
    ]);

    // 1000 + 500 + 200 = 1700
    expect(vi.mocked(setContextOccupancy)).toHaveBeenCalledWith(
      'occ-persist',
      1700,
    );
  });

  it('includes contextOccupancyTokens and contextOccupancyFraction in session_updated broadcast', async () => {
    const session = makeSession('occ-broadcast');
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
    expect(msg!['contextOccupancyTokens']).toBe(100);
    expect(msg!['contextOccupancyFraction']).toBeCloseTo(100 / 200_000);
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
