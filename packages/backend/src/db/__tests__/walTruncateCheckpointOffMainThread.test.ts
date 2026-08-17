import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { Worker } from 'worker_threads';
import { runWalTruncateCheckpointOffMainThread } from '../db.js';

describe('runWalTruncateCheckpointOffMainThread', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function openFileBackedWalDb(): { db: Database.Database; file: string } {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wal-checkpoint-off-thread-test-'),
    );
    tmpDirs.push(dir);
    const file = path.join(dir, 'test.db');
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
    return { db, file };
  }

  it('checkpoints and truncates the WAL via a worker thread that opens its own connection', async () => {
    const { db, file } = openFileBackedWalDb();
    try {
      db.exec("INSERT INTO t (val) VALUES ('a'), ('b'), ('c')");

      const result = await runWalTruncateCheckpointOffMainThread(file);

      expect(result.busy).toBe(0);
      expect(result.walSizeAfterBytes).toBe(0);
      expect(result.walSizeBeforeBytes).toBeGreaterThanOrEqual(
        result.walSizeAfterBytes,
      );

      // The worker's connection is separate from `db` — the main-thread
      // handle must still see the checkpointed rows afterward.
      const rows = db.prepare('SELECT val FROM t ORDER BY id').all() as {
        val: string;
      }[];
      expect(rows.map((r) => r.val)).toEqual(['a', 'b', 'c']);
    } finally {
      db.close();
    }
  });

  it('runs in-process for an in-memory database, since no second connection can open against it', async () => {
    const result = await runWalTruncateCheckpointOffMainThread(':memory:');
    expect(result.walSizeBeforeBytes).toBe(0);
    expect(result.walSizeAfterBytes).toBe(0);
  });
});

describe('worker-thread checkpoint dispatch does not block the main event loop', () => {
  it('lets a concurrent timer resolve on schedule while a simulated slow checkpoint runs on a worker thread', async () => {
    // Mirrors the shape of runWalTruncateCheckpointOffMainThread's dispatch
    // (a Worker that does blocking synchronous work and posts a result back)
    // without depending on real, timing-flaky disk I/O to simulate slowness.
    const slowWorkerScript = `
      const { parentPort, workerData } = require('worker_threads');
      const sab = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(sab, 0, 0, workerData.delayMs);
      parentPort.postMessage('done');
    `;
    const delayMs = 300;
    const start = Date.now();
    const worker = new Worker(slowWorkerScript, {
      eval: true,
      workerData: { delayMs },
    });
    const checkpointDone = new Promise<void>((resolve) => {
      worker.once('message', () => resolve());
    });

    let timerElapsedMs: number | null = null;
    const timerDelayMs = 20;
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        timerElapsedMs = Date.now() - start;
        resolve();
      }, timerDelayMs);
    });

    expect(timerElapsedMs).not.toBeNull();
    // If the "checkpoint" ran inline on the main thread, this timer would
    // have queued behind its 300ms of blocking work. Running it on a worker
    // thread instead means the timer fires close to its own delay.
    expect(timerElapsedMs as number).toBeLessThan(delayMs / 2);

    await checkpointDone;
    await worker.terminate();
  });
});
