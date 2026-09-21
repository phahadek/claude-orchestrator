// Worker-thread entry point for collectStructuredTestResultOffMainThread
// (session/test-runner.ts). Runs collectStructuredTestResult's readFileSync
// + JUnit-XML regex parse on a worker thread instead of the main thread —
// for a large suite this is real synchronous I/O + CPU work, and the
// test-lane's completion handler is on the hot path shared with every other
// request the backend serves.
//
// Imports only session/testReportCollector.ts, which is deliberately
// dependency-free (no db.ts/queries.ts, no logger) — see that file's own
// doc comment, and db/flakyTestRollupWorker.ts's for why a worker entry
// point can never import a module that transitively opens the shared
// main-thread `db` singleton.
import { parentPort, workerData } from 'worker_threads';
import { collectStructuredTestResult } from './testReportCollector';
import type { StructuredTestResult } from '../db/types';

interface TestReportCollectorWorkerData {
  worktreePath: string;
  reportGlob: string;
  expectedReportCount: number;
  startedAt?: number;
}

function run(): StructuredTestResult | null {
  const { worktreePath, reportGlob, expectedReportCount, startedAt } =
    workerData as TestReportCollectorWorkerData;
  return collectStructuredTestResult(
    worktreePath,
    reportGlob,
    expectedReportCount,
    startedAt,
  );
}

if (!parentPort) {
  throw new Error(
    '[testReportCollectorWorker] must be run as a worker_threads Worker',
  );
}

try {
  parentPort.postMessage({ ok: true, result: run() });
} catch (err) {
  parentPort.postMessage({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  });
}
