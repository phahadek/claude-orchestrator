import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'http';

// ── In-memory DB setup ────────────────────────────────────────────────────────
vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../github/PRBootSweep.js', () => ({
  runPRBootSweep: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../session/bootIdleReconciliation.js', () => ({
  runBootIdleReconciliation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../orchestration/gitConfigIntegrity.js', () => ({
  runGitConfigIntegrityCheck: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../config/corporateMode.js', () => ({
  getCorporateMode: vi
    .fn()
    .mockReturnValue({ enabled: false, envLocked: false, gates: {} }),
}));

import * as AuditLog from '../audit/AuditLog';
import {
  recordFault,
  handleUncaughtException,
  handleUnhandledRejection,
} from '../audit/recordFault';
import { runBootSequence } from '../bootSequence.js';
import type { BootDeps } from '../bootSequence.js';
import type { ServerMessage } from '../ws/types.js';

function getRows(db: import('better-sqlite3').Database, eventType: string) {
  return db
    .prepare(`SELECT * FROM audit_log WHERE event_type = ?`)
    .all(eventType) as Record<string, unknown>[];
}

beforeEach(async () => {
  const { db } = await import('../db/db.js');
  (db as import('better-sqlite3').Database).exec('DELETE FROM audit_log');
  vi.clearAllMocks();
});

// ── recordFault / handler wiring ──────────────────────────────────────────────

describe('handleUncaughtException', () => {
  it('records exactly one process_fault row with a non-empty stack and invokes shutdown with exit code 1', async () => {
    const { db } = await import('../db/db.js');
    const shutdown = vi.fn();
    const err = new Error('boom');

    handleUncaughtException(err, shutdown);

    const rows = getRows(
      db as import('better-sqlite3').Database,
      'process_fault',
    );
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload as string);
    expect(payload.kind).toBe('uncaughtException');
    expect(payload.willShutdown).toBe(true);
    expect(typeof payload.stack).toBe('string');
    expect((payload.stack as string).length).toBeGreaterThan(0);

    expect(shutdown).toHaveBeenCalledWith('uncaughtException', 1);
  });
});

describe('handleUnhandledRejection', () => {
  it('records one process_fault row with willShutdown=false and does not shut down', async () => {
    const { db } = await import('../db/db.js');
    const err = new Error('rejected');

    handleUnhandledRejection(err);

    const rows = getRows(
      db as import('better-sqlite3').Database,
      'process_fault',
    );
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload as string);
    expect(payload.kind).toBe('unhandledRejection');
    expect(payload.willShutdown).toBe(false);
  });
});

describe('recordFault — recordEvent failure is swallowed', () => {
  it('shutdown still fires when recordEvent throws', () => {
    const spy = vi.spyOn(AuditLog, 'recordEvent').mockImplementation(() => {
      throw new Error('db exploded');
    });
    const shutdown = vi.fn();

    expect(() =>
      handleUncaughtException(new Error('boom'), shutdown),
    ).not.toThrow();
    expect(shutdown).toHaveBeenCalledWith('uncaughtException', 1);

    spy.mockRestore();
  });

  it('recordFault itself does not throw when recordEvent throws', () => {
    const spy = vi.spyOn(AuditLog, 'recordEvent').mockImplementation(() => {
      throw new Error('db exploded');
    });

    expect(() =>
      recordFault('unhandledRejection', new Error('x'), false),
    ).not.toThrow();

    spy.mockRestore();
  });
});

// ── Boot-time recovery detection ──────────────────────────────────────────────

function makeBootDeps(broadcast: (msg: ServerMessage) => void): BootDeps {
  const server = {
    listen: vi.fn((_port: number, _host: string, cb: () => void) => {
      cb();
      return server;
    }),
  } as unknown as http.Server;

  return {
    jsonlReader: {
      importAll: vi.fn().mockResolvedValue(undefined),
      backfillTokens: vi.fn(),
    },
    sessionManager: {
      resumeOrphanSessions: vi.fn().mockResolvedValue(undefined),
      reconcileInboxAtBoot: vi.fn().mockResolvedValue(undefined),
      isAlive: vi.fn().mockReturnValue(true),
    },
    planningOrchestrator: {
      reconcilePendingApproveTerminals: vi.fn(),
    },
    stuckSessionMonitor: { rehydrate: vi.fn() },
    autoMerger: { rehydrate: vi.fn() },
    githubClient: {} as never,
    autoLauncher: { pollOnce: vi.fn().mockResolvedValue(undefined) },
    scheduler: { start: vi.fn() },
    sessionEventsPruner: { runAtBoot: vi.fn().mockResolvedValue(undefined) },
    stalledPRReconciler: {
      reconcileOnce: vi.fn().mockResolvedValue(undefined),
    },
    server,
    port: 3000,
    broadcast,
  };
}

async function runAndDrain(deps: BootDeps): Promise<void> {
  await runBootSequence(deps);
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}

describe('boot-time process_fault recovery detection', () => {
  it('emits a recovery log + error broadcast when the latest process_fault is newer than the prior process_boot', async () => {
    const { db } = await import('../db/db.js');
    const insert = (db as import('better-sqlite3').Database).prepare(
      `INSERT INTO audit_log (ts, event_type, actor_type, payload) VALUES (?, ?, 'system', ?)`,
    );
    insert.run(1000, 'process_boot', '{}');
    insert.run(2000, 'process_fault', JSON.stringify({ message: 'FK failed' }));

    const broadcast = vi.fn();
    const deps = makeBootDeps(broadcast);

    await runAndDrain(deps);

    const errorBroadcast = vi
      .mocked(broadcast)
      .mock.calls.find(([msg]) => msg.type === 'error');
    expect(errorBroadcast).toBeDefined();
    const msg = errorBroadcast![0] as Extract<ServerMessage, { type: 'error' }>;
    expect(msg.message).toContain('recovered from prior process_fault');
    expect(msg.message).toContain('FK failed');
  });

  it('stays silent when the latest process_boot is newer than the latest process_fault', async () => {
    const { db } = await import('../db/db.js');
    const insert = (db as import('better-sqlite3').Database).prepare(
      `INSERT INTO audit_log (ts, event_type, actor_type, payload) VALUES (?, ?, 'system', ?)`,
    );
    insert.run(1000, 'process_fault', JSON.stringify({ message: 'old fault' }));
    insert.run(2000, 'process_boot', '{}');

    const broadcast = vi.fn();
    const deps = makeBootDeps(broadcast);

    await runAndDrain(deps);

    const errorBroadcast = vi
      .mocked(broadcast)
      .mock.calls.find(([msg]) => msg.type === 'error');
    expect(errorBroadcast).toBeUndefined();
  });

  it('stays silent when there is no process_fault at all', async () => {
    const broadcast = vi.fn();
    const deps = makeBootDeps(broadcast);

    await runAndDrain(deps);

    const errorBroadcast = vi
      .mocked(broadcast)
      .mock.calls.find(([msg]) => msg.type === 'error');
    expect(errorBroadcast).toBeUndefined();
  });

  it('records a process_boot row at the end of the boot sequence', async () => {
    const { db } = await import('../db/db.js');
    const broadcast = vi.fn();
    const deps = makeBootDeps(broadcast);

    await runAndDrain(deps);

    const rows = getRows(
      db as import('better-sqlite3').Database,
      'process_boot',
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
