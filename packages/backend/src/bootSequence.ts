import http from 'http';
import { GitHubClient } from './github/GitHubClient';
import { runPRBootSweep } from './github/PRBootSweep';
import { runBootIdleReconciliation } from './session/bootIdleReconciliation';
import { runBootWorktreeReconciliation } from './orchestration/WorktreeReconciler';
import { logger } from './logger';
import type { ServerMessage } from './ws/types';

export interface BootDeps {
  jsonlReader: {
    importAll(): Promise<void>;
    backfillTokens(): void;
  };
  sessionManager: {
    resumeOrphanSessions(): Promise<void>;
  };
  stuckSessionMonitor: {
    rehydrate(): void;
    startScan(): void;
  };
  autoMerger: {
    rehydrate(): void;
  };
  githubClient: GitHubClient;
  autoLauncher: {
    start(): Promise<void>;
  };
  orphanedTaskSweeper: {
    start(): void;
  };
  scheduler: {
    start(): void;
  };
  taskCacheRefresher: {
    start(): void;
  };
  sessionEventsPruner: {
    runAtBoot(): Promise<void>;
    start(): void;
  };
  server: http.Server;
  port: number;
  broadcast: (msg: ServerMessage) => void;
}

export class BootStatusTracker {
  private broadcast: (msg: ServerMessage) => void;
  private steps: string[] = [];
  private startedAt: string = '';
  private eventLog: ServerMessage[] = [];
  private state: 'idle' | 'in_progress' | 'completed' = 'idle';

  constructor(broadcast: (msg: ServerMessage) => void) {
    this.broadcast = broadcast;
  }

  private emit(msg: ServerMessage): void {
    this.broadcast(msg);
    this.eventLog.push(msg);
  }

  startSequence(steps: string[]): void {
    this.steps = steps;
    this.startedAt = new Date().toISOString();
    this.state = 'in_progress';
    this.emit({
      type: 'boot_reconciliation_started',
      steps,
      started_at: this.startedAt,
    });
  }

  async runStep(
    name: string,
    fn: () => Promise<void> | void,
    opts?: { fatalOnError?: boolean },
  ): Promise<void> {
    const stepStart = Date.now();
    this.emit({
      type: 'boot_reconciliation_step',
      step: name,
      status: 'started',
    });
    try {
      await fn();
      this.emit({
        type: 'boot_reconciliation_step',
        step: name,
        status: 'completed',
        duration_ms: Date.now() - stepStart,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.emit({
        type: 'boot_reconciliation_step',
        step: name,
        status: 'failed',
        error,
      });
      if (opts?.fatalOnError) {
        logger.error(`[server] BOOT FAILURE in ${name}:`, err);
        process.exit(1);
      } else {
        logger.warn(`[server] boot step ${name} failed:`, err);
      }
    }
  }

  completeSequence(): void {
    const completedAt = new Date().toISOString();
    const duration_ms =
      new Date(completedAt).getTime() - new Date(this.startedAt).getTime();
    this.state = 'completed';
    this.emit({
      type: 'boot_reconciliation_completed',
      duration_ms,
      completed_at: completedAt,
    });
  }

  getSnapshot(): ServerMessage[] | null {
    if (this.state === 'idle') return null;
    return [...this.eventLog];
  }
}

let _activeBootTracker: BootStatusTracker | null = null;

export function getActiveBootTracker(): BootStatusTracker | null {
  return _activeBootTracker;
}

export async function runBootSequence(deps: BootDeps): Promise<void> {
  const { server, port } = deps;
  await new Promise<void>((resolve) =>
    server.listen(port, '0.0.0.0', () => {
      logger.info(`[server] listening on port ${port}`);
      logger.info('[server] LAN access enabled — device auth required');
      resolve();
    }),
  );
  void runReconciliationChain(deps).catch((err) =>
    logger.error('[server] background boot reconciliation crashed:', err),
  );
}

async function runReconciliationChain(deps: BootDeps): Promise<void> {
  const tracker = new BootStatusTracker(deps.broadcast);
  _activeBootTracker = tracker;
  tracker.startSequence([
    'jsonl_import',
    'session_events_pruner_at_boot',
    'resume_orphan_sessions',
    'stuck_session_monitor_rehydrate',
    'auto_merger_rehydrate',
    'worktree_reconciliation',
    'pr_boot_sweep',
    'boot_idle_reconciliation',
    'auto_launcher_start',
  ]);
  await tracker.runStep('jsonl_import', () => deps.jsonlReader.importAll(), {
    fatalOnError: true,
  });
  deps.jsonlReader.backfillTokens();
  void tracker.runStep('session_events_pruner_at_boot', () =>
    deps.sessionEventsPruner.runAtBoot(),
  );
  deps.sessionEventsPruner.start();
  await tracker.runStep(
    'resume_orphan_sessions',
    () => deps.sessionManager.resumeOrphanSessions(),
    { fatalOnError: true },
  );
  await tracker.runStep('stuck_session_monitor_rehydrate', () =>
    deps.stuckSessionMonitor.rehydrate(),
  );
  deps.stuckSessionMonitor.startScan();
  await tracker.runStep('auto_merger_rehydrate', () =>
    deps.autoMerger.rehydrate(),
  );
  await tracker.runStep('worktree_reconciliation', () =>
    runBootWorktreeReconciliation(),
  );
  await tracker.runStep('pr_boot_sweep', () =>
    runPRBootSweep(deps.githubClient),
  );
  await tracker.runStep('boot_idle_reconciliation', () =>
    runBootIdleReconciliation(),
  );
  await tracker.runStep('auto_launcher_start', () => deps.autoLauncher.start());
  deps.orphanedTaskSweeper.start();
  deps.scheduler.start();
  deps.taskCacheRefresher.start();
  tracker.completeSequence();
}
