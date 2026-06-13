import http from 'http';
import { GitHubClient } from './github/GitHubClient';
import { runPRBootSweep } from './github/PRBootSweep';
import { runBootIdleReconciliation } from './session/bootIdleReconciliation';
import { runBootWorktreeReconciliation } from './orchestration/WorktreeReconciler';
import { logger } from './logger';

interface BootDeps {
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
  prMergeWatcher: {
    start(): void;
  };
  reviewerCommentsWatcher: {
    start(): void;
  };
  autoLauncher: {
    start(): Promise<void>;
  };
  orphanedTaskSweeper: {
    start(): void;
  };
  concludedSessionArchiver: {
    start(): void;
  };
  updateChecker: {
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
}

export async function runBootSequence(deps: BootDeps): Promise<void> {
  const {
    jsonlReader,
    sessionManager,
    stuckSessionMonitor,
    autoMerger,
    githubClient,
    prMergeWatcher,
    reviewerCommentsWatcher,
    autoLauncher,
    orphanedTaskSweeper,
    concludedSessionArchiver,
    updateChecker,
    taskCacheRefresher,
    sessionEventsPruner,
    server,
    port,
  } = deps;

  try {
    await jsonlReader.importAll();
  } catch (err) {
    logger.error('[server] BOOT FAILURE in JSONL import:', err);
    process.exit(1);
  }

  jsonlReader.backfillTokens();

  void sessionEventsPruner
    .runAtBoot()
    .catch((err: unknown) =>
      logger.warn('[server] SessionEventsPruner boot run failed:', err),
    );
  sessionEventsPruner.start();

  try {
    await sessionManager.resumeOrphanSessions();
  } catch (err) {
    logger.error('[server] BOOT FAILURE in resumeOrphanSessions:', err);
    process.exit(1);
  }

  try {
    stuckSessionMonitor.rehydrate();
  } catch (err) {
    logger.error(
      '[server] BOOT FAILURE in StuckSessionMonitor.rehydrate:',
      err,
    );
    process.exit(1);
  }

  stuckSessionMonitor.startScan();
  autoMerger.rehydrate();

  await runBootWorktreeReconciliation().catch((err: unknown) =>
    logger.warn('[server] WorktreeReconciler boot sweep failed:', err),
  );

  void runPRBootSweep(githubClient)
    .then(() => runBootIdleReconciliation())
    .catch((err: unknown) =>
      logger.warn('[server] PR boot sweep failed:', err),
    );

  prMergeWatcher.start();
  reviewerCommentsWatcher.start();

  await autoLauncher
    .start()
    .catch((err: unknown) =>
      logger.warn('[server] auto-launcher start failed:', err),
    );

  orphanedTaskSweeper.start();
  concludedSessionArchiver.start();
  updateChecker.start();
  taskCacheRefresher.start();

  server.listen(port, '0.0.0.0', () => {
    logger.info(`[server] listening on port ${port}`);
    logger.info('[server] LAN access enabled — device auth required');
  });
}
