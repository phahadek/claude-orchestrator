import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'http';

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

import {
  runBootSequence,
  getReadinessState,
  setReadinessState,
  EXTRACTION_SWEEP_BOOT_CAP,
} from '../bootSequence.js';
import type { BootDeps } from '../bootSequence.js';
import type { ServerMessage } from '../ws/types.js';
import { db } from '../db/db.js';
import { insertTestRequestRun, completeTestRequestRun } from '../db/queries.js';
import fs from 'fs';
import path from 'path';

function makeDeps(): {
  deps: BootDeps;
  eventLog: string[];
  broadcast: ReturnType<typeof vi.fn>;
  scheduler: { start: ReturnType<typeof vi.fn> };
} {
  const eventLog: string[] = [];

  const broadcast = vi.fn((msg: ServerMessage) => {
    if (msg.type === 'boot_reconciliation_completed') {
      eventLog.push('boot_reconciliation_completed');
    }
    if (msg.type === 'boot_reconciliation_started') {
      eventLog.push('boot_reconciliation_started');
    }
  });

  const scheduler = {
    start: vi.fn(() => {
      eventLog.push('scheduler_start');
    }),
  };

  const server = {
    listen: vi.fn((_port: number, _host: string, cb: () => void) => {
      cb();
      return server;
    }),
  } as unknown as http.Server;

  const deps: BootDeps = {
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
    stuckSessionMonitor: { rehydrate: vi.fn() },
    autoMerger: { rehydrate: vi.fn() },
    githubClient: {} as never,
    autoLauncher: { pollOnce: vi.fn().mockResolvedValue(undefined) },
    scheduler,
    sessionEventsPruner: { runAtBoot: vi.fn().mockResolvedValue(undefined) },
    stalledPRReconciler: {
      reconcileOnce: vi.fn().mockResolvedValue(undefined),
    },
    gateVerifyReconciler: {
      reattachOutstanding: vi.fn().mockResolvedValue(undefined),
    },
    server,
    port: 3000,
    broadcast,
  };

  return { deps, eventLog, broadcast, scheduler };
}

async function runAndDrain(deps: BootDeps): Promise<void> {
  await runBootSequence(deps);
  // runReconciliationChain is fired as a void promise; drain the microtask queue
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}

beforeEach(() => {
  vi.clearAllMocks();
  setReadinessState('migrating');
  db.prepare('DELETE FROM test_run_summaries').run();
  db.prepare('DELETE FROM test_request_runs').run();
});

function seedPendingExtractionRun(id: string, requestedAt: number): void {
  const structured = JSON.stringify({
    suites: [
      { tests: [{ id: 't1', name: 'n', outcome: 'failed', durationMs: 5 }] },
    ],
  });
  insertTestRequestRun(id, 'proj-1', `hash-${id}`, null, requestedAt);
  completeTestRequestRun(id, 'passed', 'ok', null, structured);
}

// ── Boot-safety gate ──────────────────────────────────────────────────────────

describe('boot-safety gate — scheduler.start() fires after boot_reconciliation_completed', () => {
  it('scheduler.start() is called strictly after boot_reconciliation_completed is emitted', async () => {
    const { deps, eventLog } = makeDeps();

    await runAndDrain(deps);

    const completedIdx = eventLog.indexOf('boot_reconciliation_completed');
    const startIdx = eventLog.indexOf('scheduler_start');

    expect(completedIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(completedIdx);
  });

  it('scheduler.start() is NOT called before boot_reconciliation_completed', async () => {
    const { deps, eventLog } = makeDeps();
    let schedulerStartedBeforeCompleted = false;

    vi.mocked(deps.scheduler.start).mockImplementation(() => {
      const completedSoFar = eventLog.includes('boot_reconciliation_completed');
      if (!completedSoFar) schedulerStartedBeforeCompleted = true;
      eventLog.push('scheduler_start');
    });

    await runAndDrain(deps);

    expect(schedulerStartedBeforeCompleted).toBe(false);
  });
});

// ── worktree_reconciliation removed from chain ────────────────────────────────

describe('boot chain — worktree_reconciliation step removed', () => {
  it('boot_reconciliation_started does not include worktree_reconciliation', async () => {
    const { deps, broadcast } = makeDeps();

    await runAndDrain(deps);

    const startedCall = vi
      .mocked(broadcast)
      .mock.calls.find(([msg]) => msg.type === 'boot_reconciliation_started');
    expect(startedCall).toBeDefined();
    const steps = (
      startedCall![0] as Extract<
        ServerMessage,
        { type: 'boot_reconciliation_started' }
      >
    ).steps;
    expect(steps).not.toContain('worktree_reconciliation');
  });

  it('no boot step emits worktree_reconciliation', async () => {
    const { deps, broadcast } = makeDeps();

    await runAndDrain(deps);

    const stepCalls = vi
      .mocked(broadcast)
      .mock.calls.filter(([msg]) => msg.type === 'boot_reconciliation_step');
    const stepNames = stepCalls.map(
      ([msg]) =>
        (msg as Extract<ServerMessage, { type: 'boot_reconciliation_step' }>)
          .step,
    );
    expect(stepNames).not.toContain('worktree_reconciliation');
  });
});

// ── gate_verify_reattachment boot step ────────────────────────────────────────

describe('boot chain — gate_verify_reattachment step', () => {
  it('runs gateVerifyReconciler.reattachOutstanding as part of the chain', async () => {
    const { deps } = makeDeps();

    await runAndDrain(deps);

    expect(deps.gateVerifyReconciler.reattachOutstanding).toHaveBeenCalledTimes(
      1,
    );
  });

  it('includes gate_verify_reattachment in the announced boot steps', async () => {
    const { deps, broadcast } = makeDeps();

    await runAndDrain(deps);

    const startedCall = vi
      .mocked(broadcast)
      .mock.calls.find(([msg]) => msg.type === 'boot_reconciliation_started');
    const steps = (
      startedCall![0] as Extract<
        ServerMessage,
        { type: 'boot_reconciliation_started' }
      >
    ).steps;
    expect(steps).toContain('gate_verify_reattachment');
  });

  it('a rejection from reattachOutstanding does not block boot completion', async () => {
    const { deps } = makeDeps();
    vi.mocked(deps.gateVerifyReconciler.reattachOutstanding).mockRejectedValue(
      new Error('boom'),
    );

    await expect(runAndDrain(deps)).resolves.toBeUndefined();
    expect(deps.scheduler.start).toHaveBeenCalledTimes(1);
  });
});

// ── token_backfill and session_events_pruner_at_boot are fully awaited ────────

describe('boot chain — token_backfill and session_events_pruner_at_boot are awaited', () => {
  it('announces both steps in the boot step list', async () => {
    const { deps, broadcast } = makeDeps();

    await runAndDrain(deps);

    const startedCall = vi
      .mocked(broadcast)
      .mock.calls.find(([msg]) => msg.type === 'boot_reconciliation_started');
    const steps = (
      startedCall![0] as Extract<
        ServerMessage,
        { type: 'boot_reconciliation_started' }
      >
    ).steps;
    expect(steps).toContain('token_backfill');
    expect(steps).toContain('session_events_pruner_at_boot');
  });

  it('runs jsonlReader.backfillTokens as a timed, tracked step', async () => {
    const { deps, broadcast } = makeDeps();

    await runAndDrain(deps);

    expect(deps.jsonlReader.backfillTokens).toHaveBeenCalledTimes(1);
    const stepCalls = vi
      .mocked(broadcast)
      .mock.calls.filter(([msg]) => msg.type === 'boot_reconciliation_step');
    const stepNames = stepCalls.map(
      ([msg]) =>
        (msg as Extract<ServerMessage, { type: 'boot_reconciliation_step' }>)
          .step,
    );
    expect(stepNames).toContain('token_backfill');
  });

  it('boot_reconciliation_completed does not fire until a slow session_events_pruner_at_boot settles', async () => {
    const { deps, eventLog } = makeDeps();
    let resolvePruner: () => void = () => {};
    vi.mocked(deps.sessionEventsPruner.runAtBoot).mockReturnValue(
      new Promise<void>((resolve) => {
        resolvePruner = resolve;
      }),
    );

    const runPromise = runBootSequence(deps);
    await runPromise;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(eventLog).not.toContain('boot_reconciliation_completed');
    expect(deps.scheduler.start).not.toHaveBeenCalled();

    resolvePruner();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(eventLog).toContain('boot_reconciliation_completed');
    expect(deps.scheduler.start).toHaveBeenCalledTimes(1);
  });

  it('a rejection from session_events_pruner_at_boot does not block boot completion (non-fatal)', async () => {
    const { deps } = makeDeps();
    vi.mocked(deps.sessionEventsPruner.runAtBoot).mockRejectedValue(
      new Error('pruner boom'),
    );

    await expect(runAndDrain(deps)).resolves.toBeUndefined();
    expect(deps.scheduler.start).toHaveBeenCalledTimes(1);
  });
});

// ── readiness surface ───────────────────────────────────────────────────────

describe('readiness state', () => {
  it('starts as migrating (the module-load default, before runBootSequence is ever called)', () => {
    expect(getReadinessState()).toBe('migrating');
  });

  it('flips to boot_steps_running synchronously as soon as runBootSequence starts, before the listener resolves', () => {
    const { deps } = makeDeps();

    const pending = runBootSequence(deps);

    expect(getReadinessState()).toBe('boot_steps_running');
    return pending;
  });

  it('only reaches serving once the full reconciliation chain has completed', async () => {
    const { deps } = makeDeps();

    await runAndDrain(deps);

    expect(getReadinessState()).toBe('serving');
  });

  it('is still boot_steps_running mid-chain, not serving early', async () => {
    const { deps } = makeDeps();
    let resolvePruner: () => void = () => {};
    vi.mocked(deps.sessionEventsPruner.runAtBoot).mockReturnValue(
      new Promise<void>((resolve) => {
        resolvePruner = resolve;
      }),
    );

    await runBootSequence(deps);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(getReadinessState()).toBe('boot_steps_running');

    resolvePruner();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(getReadinessState()).toBe('serving');
  });
});

// ── extraction sweep — bounded per boot, progress reported, residual left for the drain ──

describe('boot chain — test_run_results_extraction_sweep is bounded and reported', () => {
  it('emits a boot_reconciliation_progress record naming the step and the remaining count as it works', async () => {
    seedPendingExtractionRun('run-a', Date.now());
    seedPendingExtractionRun('run-b', Date.now() + 1);
    const { deps, broadcast } = makeDeps();

    await runAndDrain(deps);

    const progressCalls = vi
      .mocked(broadcast)
      .mock.calls.map(([msg]) => msg)
      .filter(
        (msg): msg is Extract<
          ServerMessage,
          { type: 'boot_reconciliation_progress' }
        > => msg.type === 'boot_reconciliation_progress',
      )
      .filter((msg) => msg.step === 'test_run_results_extraction_sweep');

    expect(progressCalls.length).toBe(2);
    expect(progressCalls.map((msg) => msg.remaining)).toEqual([1, 0]);
  });

  it('processes at most EXTRACTION_SWEEP_BOOT_CAP runs and still completes the boot sequence when more are pending', async () => {
    const total = EXTRACTION_SWEEP_BOOT_CAP + 5;
    for (let i = 0; i < total; i++) {
      seedPendingExtractionRun(`run-cap-${i}`, Date.now() + i);
    }
    const { deps, eventLog } = makeDeps();

    await runAndDrain(deps);

    // Boot completed despite a backlog bigger than the cap.
    expect(eventLog).toContain('boot_reconciliation_completed');
    expect(eventLog).toContain('scheduler_start');

    // The residual work list is non-empty and still discoverable afterwards.
    const remaining = db
      .prepare(
        `SELECT COUNT(*) AS n FROM test_request_runs
         WHERE structured_result IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM test_run_summaries
             WHERE test_run_summaries.test_request_run_id = test_request_runs.id
           )`,
      )
      .get() as { n: number };
    expect(remaining.n).toBe(5);
  });
});

// ── boot ordering ────────────────────────────────────────────────────────────

describe('boot ordering', () => {
  it('server.ts runs migrations before starting the boot sequence that binds the listener', () => {
    const serverSrc = fs.readFileSync(
      path.join(__dirname, '..', 'server.ts'),
      'utf8',
    );
    const migrationsIdx = serverSrc.indexOf('runMigrations(db)');
    const bootSequenceIdx = serverSrc.indexOf('void runBootSequence(');

    expect(migrationsIdx).toBeGreaterThanOrEqual(0);
    expect(bootSequenceIdx).toBeGreaterThan(migrationsIdx);
  });

  it('runs the post-listen steps in their declared order', async () => {
    const { deps, broadcast } = makeDeps();

    await runAndDrain(deps);

    const startedCall = vi
      .mocked(broadcast)
      .mock.calls.find(([msg]) => msg.type === 'boot_reconciliation_started');
    const declaredSteps = (
      startedCall![0] as Extract<
        ServerMessage,
        { type: 'boot_reconciliation_started' }
      >
    ).steps;

    const startedStepNames = vi
      .mocked(broadcast)
      .mock.calls.map(([msg]) => msg)
      .filter(
        (msg): msg is Extract<
          ServerMessage,
          { type: 'boot_reconciliation_step' }
        > => msg.type === 'boot_reconciliation_step' && msg.status === 'started',
      )
      .map((msg) => msg.step);

    expect(startedStepNames).toEqual(declaredSteps);
  });
});
