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
  getCorporateMode: vi.fn().mockReturnValue({ enabled: false, envLocked: false, gates: {} }),
}));

import { runBootSequence } from '../bootSequence.js';
import type { BootDeps } from '../bootSequence.js';
import type { ServerMessage } from '../ws/types.js';

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
    stuckSessionMonitor: { rehydrate: vi.fn() },
    autoMerger: { rehydrate: vi.fn() },
    githubClient: {} as never,
    autoLauncher: { pollOnce: vi.fn().mockResolvedValue(undefined) },
    scheduler,
    sessionEventsPruner: { runAtBoot: vi.fn().mockResolvedValue(undefined) },
    stalledPRReconciler: { reconcileOnce: vi.fn().mockResolvedValue(undefined) },
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
});

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

    const startedCall = vi.mocked(broadcast).mock.calls.find(
      ([msg]) => msg.type === 'boot_reconciliation_started',
    );
    expect(startedCall).toBeDefined();
    const steps = (startedCall![0] as Extract<ServerMessage, { type: 'boot_reconciliation_started' }>).steps;
    expect(steps).not.toContain('worktree_reconciliation');
  });

  it('no boot step emits worktree_reconciliation', async () => {
    const { deps, broadcast } = makeDeps();

    await runAndDrain(deps);

    const stepCalls = vi.mocked(broadcast).mock.calls.filter(
      ([msg]) => msg.type === 'boot_reconciliation_step',
    );
    const stepNames = stepCalls.map(
      ([msg]) => (msg as Extract<ServerMessage, { type: 'boot_reconciliation_step' }>).step,
    );
    expect(stepNames).not.toContain('worktree_reconciliation');
  });
});
