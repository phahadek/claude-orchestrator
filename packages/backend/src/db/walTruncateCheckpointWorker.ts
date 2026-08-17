// Worker-thread entry point for the hourly WAL TRUNCATE checkpoint.
//
// wal_checkpoint(TRUNCATE) has to flush every dirty WAL page back into the
// main database file and then truncate the WAL — real, synchronous disk I/O
// that, if issued on the shared main-thread `db` connection, blocks every
// Express route and WebSocket handler for its own duration (see
// runWalTruncateCheckpointOffMainThread in db.ts). This file runs on a
// separate worker thread and opens its OWN connection against the same
// WAL-mode database file, so the checkpoint's I/O never occupies the main
// thread's event loop. It deliberately does not import db.ts: doing so
// would re-run that module's side effects (opening the shared `db`
// singleton, schema assertions, migrations) on the worker thread.
import { parentPort, workerData } from 'worker_threads';
import Database from 'better-sqlite3';
import fs from 'fs';

interface WalTruncateCheckpointWorkerData {
  dbPath: string;
}

interface WalTruncateCheckpointResult {
  walSizeBeforeBytes: number;
  walSizeAfterBytes: number;
  busy: number;
  log: number;
  checkpointed: number;
}

function walFileSizeBytes(targetPath: string): number {
  try {
    return fs.statSync(`${targetPath}-wal`).size;
  } catch {
    return 0;
  }
}

function run(): WalTruncateCheckpointResult {
  const { dbPath } = workerData as WalTruncateCheckpointWorkerData;
  const database = new Database(dbPath);
  try {
    const walSizeBeforeBytes = walFileSizeBytes(dbPath);
    const rows = database.pragma('wal_checkpoint(TRUNCATE)') as
      | { busy: number; log: number; checkpointed: number }[]
      | undefined;
    const result = rows?.[0] ?? { busy: 0, log: 0, checkpointed: 0 };
    const walSizeAfterBytes = walFileSizeBytes(dbPath);
    return {
      walSizeBeforeBytes,
      walSizeAfterBytes,
      busy: result.busy,
      log: result.log,
      checkpointed: result.checkpointed,
    };
  } finally {
    database.close();
  }
}

if (!parentPort) {
  throw new Error(
    '[walTruncateCheckpointWorker] must be run as a worker_threads Worker',
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
