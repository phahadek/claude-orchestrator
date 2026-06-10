import http from 'http';
import { GitHubClient } from './github/GitHubClient';
import { runPRBootSweep } from './github/PRBootSweep';
import { runBootIdleReconciliation } from './session/bootIdleReconciliation';

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
    console.error('[server] BOOT FAILURE in JSONL import:', err);
    process.exit(1);
  }

  jsonlReader.backfillTokens();

  void sessionEventsPruner.runAtBoot().catch((err: unknown) =>
    console.warn('[server] SessionEventsPruner boot run failed:', err),
  );
  sessionEventsPruner.start();

  try {
    await sessionManager.resumeOrphanSessions();
  } catch (err) {
    console.error('[server] BOOT FAILURE in resumeOrphanSessions:', err);
    process.exit(1);
  }

  try {
    stuckSessionMonitor.rehydrate();
  } catch (err) {
    console.error(
      '[server] BOOT FAILURE in StuckSessionMonitor.rehydrate:',
      err,
    );
    process.exit(1);
  }

  stuckSessionMonitor.startScan();
  autoMerger.rehydrate();

  void runPRBootSweep(githubClient)
    .then(() => runBootIdleReconciliation())
    .catch((err: unknown) =>
      console.warn('[server] PR boot sweep failed:', err),
    );

  prMergeWatcher.start();
  reviewerCommentsWatcher.start();

  await autoLauncher
    .start()
    .catch((err: unknown) =>
      console.warn('[server] auto-launcher start failed:', err),
    );

  orphanedTaskSweeper.start();
  concludedSessionArchiver.start();
  updateChecker.start();
  taskCacheRefresher.start();

  server.listen(port, '0.0.0.0', () => {
    console.log(`[server] listening on port ${port}`);
    console.log('[server] LAN access enabled — device auth required');
  });
}
