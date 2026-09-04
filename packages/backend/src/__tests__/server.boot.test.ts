/**
 * Tests for the listen-first boot sequence.
 *
 * Verifies:
 * 1. server.listen is called before any reconciler runs.
 * 2. Background reconciliation chain preserves internal ordering.
 * 3. process.exit(1) is called on failure for critical steps (jsonl_import,
 *    resume_orphan_sessions).
 * 4. Non-critical steps log a warning and continue.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { createResponseCompression } from '../middleware/responseCompression';
import { ORCHESTRATOR_MCP_FULL_PATH } from '../mcp/orchestratorMcpServer';
import type { ServerMessage } from '../ws/types';

vi.mock('../github/PRBootSweep', () => ({
  runPRBootSweep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../session/bootIdleReconciliation', () => ({
  runBootIdleReconciliation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../orchestration/WorktreeReconciler', () => ({
  runBootWorktreeReconciliation: vi.fn().mockResolvedValue(undefined),
}));

function makeDeps(
  overrides: Partial<
    Parameters<(typeof import('../bootSequence'))['runBootSequence']>[0]
  > = {},
) {
  const server = Object.assign(new EventEmitter(), {
    listen: vi.fn((_port: number, _host: string, cb: () => void) => cb()),
  }) as unknown as http.Server;

  return {
    jsonlReader: {
      importAll: vi.fn().mockResolvedValue(undefined),
      backfillTokens: vi.fn(),
    },
    sessionManager: {
      resumeOrphanSessions: vi.fn().mockResolvedValue(undefined),
    },
    planningOrchestrator: {
      reconcilePendingApproveTerminals: vi.fn(),
    },
    stuckSessionMonitor: {
      rehydrate: vi.fn(),
    },
    autoMerger: {
      rehydrate: vi.fn(),
    },
    githubClient: {} as Parameters<
      (typeof import('../bootSequence'))['runBootSequence']
    >[0]['githubClient'],
    autoLauncher: { pollOnce: vi.fn().mockResolvedValue(undefined) },
    scheduler: { start: vi.fn() },
    sessionEventsPruner: {
      runAtBoot: vi.fn().mockResolvedValue(undefined),
    },
    broadcast: vi.fn() as (msg: ServerMessage) => void,
    server,
    port: 3000,
    ...overrides,
  };
}

/** Flush all pending microtasks and macrotasks so background chains settle. */
function flushQueue(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('runBootSequence — listen-first', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const originalBindHost = process.env.ORCHESTRATOR_BIND_HOST;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error('process.exit called');
    });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Boot binds to the systemd production host via ORCHESTRATOR_BIND_HOST;
    // pin it here so the assertion doesn't depend on the ambient environment.
    process.env.ORCHESTRATOR_BIND_HOST = '0.0.0.0';
  });

  afterEach(() => {
    if (originalBindHost === undefined) {
      delete process.env.ORCHESTRATOR_BIND_HOST;
    } else {
      process.env.ORCHESTRATOR_BIND_HOST = originalBindHost;
    }
  });

  it('calls server.listen before any reconciler', async () => {
    const { runBootSequence } = await import('../bootSequence');
    const callOrder: string[] = [];
    const deps = makeDeps();

    (deps.server.listen as ReturnType<typeof vi.fn>).mockImplementation(
      (_port: number, _host: string, cb: () => void) => {
        callOrder.push('server.listen');
        cb();
      },
    );
    deps.jsonlReader.importAll = vi.fn().mockImplementation(async () => {
      callOrder.push('importAll');
    });

    await runBootSequence(deps);
    await flushQueue();

    expect(callOrder[0]).toBe('server.listen');
    expect(callOrder).toContain('importAll');
    expect(callOrder.indexOf('server.listen')).toBeLessThan(
      callOrder.indexOf('importAll'),
    );
  });

  it('resolves immediately after server.listen (background chain is fire-and-forget)', async () => {
    const { runBootSequence } = await import('../bootSequence');
    const deps = makeDeps();

    await expect(runBootSequence(deps)).resolves.toBeUndefined();
    expect(deps.server.listen).toHaveBeenCalledWith(
      3000,
      '0.0.0.0',
      expect.any(Function),
    );
  });

  it('background chain preserves ordering: jsonl → resumeOrphans → rehydrates → worktree → autoLauncher', async () => {
    const { runBootSequence } = await import('../bootSequence');
    const callOrder: string[] = [];
    const deps = makeDeps();

    deps.jsonlReader.importAll = vi.fn().mockImplementation(async () => {
      callOrder.push('importAll');
    });
    deps.sessionManager.resumeOrphanSessions = vi
      .fn()
      .mockImplementation(async () => {
        callOrder.push('resumeOrphanSessions');
      });
    deps.stuckSessionMonitor.rehydrate = vi.fn().mockImplementation(() => {
      callOrder.push('stuckRehydrate');
    });
    deps.autoMerger.rehydrate = vi.fn().mockImplementation(() => {
      callOrder.push('autoMergerRehydrate');
    });
    deps.autoLauncher.pollOnce = vi.fn().mockImplementation(async () => {
      callOrder.push('autoLauncherStart');
    });

    await runBootSequence(deps);
    await flushQueue();

    const idxImport = callOrder.indexOf('importAll');
    const idxOrphans = callOrder.indexOf('resumeOrphanSessions');
    const idxStuck = callOrder.indexOf('stuckRehydrate');
    const idxAutoMerger = callOrder.indexOf('autoMergerRehydrate');
    const idxLauncher = callOrder.indexOf('autoLauncherStart');

    expect(idxImport).toBeGreaterThanOrEqual(0);
    expect(idxImport).toBeLessThan(idxOrphans);
    expect(idxOrphans).toBeLessThan(idxStuck);
    expect(idxStuck).toBeLessThan(idxAutoMerger);
    expect(idxAutoMerger).toBeLessThan(idxLauncher);
  });

  it('calls process.exit(1) when jsonl_import fails', async () => {
    const { runBootSequence } = await import('../bootSequence');
    const err = new Error('FK constraint violation');
    const deps = makeDeps({
      jsonlReader: {
        importAll: vi.fn().mockRejectedValue(err),
        backfillTokens: vi.fn(),
      },
    });

    await runBootSequence(deps);
    await flushQueue();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls process.exit(1) when resume_orphan_sessions fails', async () => {
    const { runBootSequence } = await import('../bootSequence');
    const err = new Error('SQLITE_CONSTRAINT_FOREIGNKEY');
    const deps = makeDeps({
      sessionManager: { resumeOrphanSessions: vi.fn().mockRejectedValue(err) },
    });

    await runBootSequence(deps);
    await flushQueue();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does NOT call process.exit when stuck_session_monitor_rehydrate fails (non-fatal)', async () => {
    const { runBootSequence } = await import('../bootSequence');
    const err = new Error('rehydrate failed');
    const deps = makeDeps({
      stuckSessionMonitor: {
        rehydrate: vi.fn().mockImplementation(() => {
          throw err;
        }),
      },
    });

    await runBootSequence(deps);
    await flushQueue();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('continues boot and resolves when all steps succeed', async () => {
    const { runBootSequence } = await import('../bootSequence');
    const deps = makeDeps();

    await expect(runBootSequence(deps)).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(deps.server.listen).toHaveBeenCalledWith(
      3000,
      '0.0.0.0',
      expect.any(Function),
    );
    await flushQueue();
    expect(deps.autoLauncher.pollOnce).toHaveBeenCalled();
  });
});

describe('response compression', () => {
  const largeBody = { items: Array.from({ length: 100 }, (_, i) => ({ i, note: 'x'.repeat(20) })) };
  const smallBody = { ok: true };

  function makeApp() {
    const app = express();
    app.use(createResponseCompression());
    app.get('/api/large', (_req, res) => res.json(largeBody));
    app.get('/api/small', (_req, res) => res.json(smallBody));
    app.get(`${ORCHESTRATOR_MCP_FULL_PATH}`, (_req, res) => res.json(largeBody));
    app.get('/api/events', (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.send(JSON.stringify(largeBody));
    });
    return app;
  }

  it('compresses a JSON response over the threshold when the client accepts gzip', async () => {
    const res = await request(makeApp())
      .get('/api/large')
      .set('Accept-Encoding', 'gzip');

    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body).toEqual(largeBody);
  });

  it('returns identity response with no Content-Encoding when the client sends no Accept-Encoding', async () => {
    const res = await request(makeApp())
      .get('/api/large')
      .unset('Accept-Encoding');

    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body).toEqual(largeBody);
  });

  it('does not compress a response under the 1 KB threshold', async () => {
    const res = await request(makeApp())
      .get('/api/small')
      .set('Accept-Encoding', 'gzip');

    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body).toEqual(smallBody);
  });

  it('excludes the MCP streamable-HTTP route from compression', async () => {
    const res = await request(makeApp())
      .get(ORCHESTRATOR_MCP_FULL_PATH)
      .set('Accept-Encoding', 'gzip');

    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('excludes text/event-stream responses from compression', async () => {
    const res = await request(makeApp())
      .get('/api/events')
      .set('Accept-Encoding', 'gzip');

    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('serves a compressed static bundle when the client accepts gzip', async () => {
    const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compression-static-'));
    fs.writeFileSync(
      path.join(staticDir, 'bundle.js'),
      `console.log(${JSON.stringify('x'.repeat(2000))});`,
    );

    const app = express();
    app.use(createResponseCompression());
    app.use(express.static(staticDir));

    try {
      const res = await request(app).get('/bundle.js').set('Accept-Encoding', 'gzip');
      expect(res.headers['content-encoding']).toBe('gzip');
    } finally {
      fs.rmSync(staticDir, { recursive: true, force: true });
    }
  });
});
