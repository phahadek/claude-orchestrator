import fs from 'fs';
import { logger } from '../logger';
import { db, dbPath } from '../db/db';
import type { Scheduler } from './Scheduler';

const CHECKPOINT_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Periodic `PRAGMA wal_checkpoint(TRUNCATE)` — a passive checkpoint alone
 * can't advance past an overlapping reader transaction, and this host runs
 * enough continuously-overlapping read transactions (scheduler jobs) to
 * starve it indefinitely, letting the WAL grow unbounded and slowing every
 * read against it. TRUNCATE is safe: it never discards committed data, only
 * the already-checkpointed portion of the WAL file on disk.
 */
export class WalCheckpointJob {
  register(scheduler: Scheduler): void {
    scheduler.register({
      name: 'wal_checkpoint',
      intervalMs: CHECKPOINT_INTERVAL_MS,
      concurrency: 'skip-if-running',
      run: async () => this.checkpointOnce(),
    });
  }

  checkpointOnce(): { items_processed: number } {
    const walSizeBefore = this._walSizeBytes();

    const rows = db.pragma('wal_checkpoint(TRUNCATE)') as
      | { busy: number; log: number; checkpointed: number }[]
      | undefined;

    const walSizeAfter = this._walSizeBytes();
    const bytesFreed = Math.max(0, walSizeBefore - walSizeAfter);

    logger.info(
      `[WalCheckpointJob] wal_checkpoint(TRUNCATE): wal size ${walSizeBefore} -> ${walSizeAfter} bytes ` +
        `(freed ${bytesFreed})` +
        (rows?.[0]
          ? ` [busy=${rows[0].busy} log=${rows[0].log} checkpointed=${rows[0].checkpointed}]`
          : ''),
    );

    return { items_processed: bytesFreed };
  }

  private _walSizeBytes(): number {
    if (dbPath === ':memory:') return 0;
    try {
      return fs.statSync(`${dbPath}-wal`).size;
    } catch {
      return 0;
    }
  }
}
