import { performance } from 'node:perf_hooks';
import type Database from 'better-sqlite3';

export const SLOW_STATEMENT_THRESHOLD_MS = 250;
const SLOW_STATEMENT_BUFFER_SIZE = 100;
const SQL_MAX_CHARS = 200;

export interface SlowStatement {
  sql: string;
  durationMs: number;
  endedAt: number;
}

export class SlowStatementRecorder {
  private readonly buffer: SlowStatement[] = [];

  constructor(
    private readonly thresholdMs: number = SLOW_STATEMENT_THRESHOLD_MS,
    private readonly capacity: number = SLOW_STATEMENT_BUFFER_SIZE,
    private readonly nowFn: () => number = Date.now,
  ) {}

  record(sql: string, durationMs: number): void {
    if (durationMs < this.thresholdMs) return;
    this.buffer.push({
      sql: sql.replace(/\s+/g, ' ').trim().slice(0, SQL_MAX_CHARS),
      durationMs,
      endedAt: this.nowFn(),
    });
    if (this.buffer.length > this.capacity) this.buffer.shift();
  }

  /** Entries whose [endedAt - durationMs, endedAt] overlaps [fromMs, toMs]. */
  overlapping(fromMs: number, toMs: number): SlowStatement[] {
    return this.buffer.filter(
      (s) => s.endedAt >= fromMs && s.endedAt - s.durationMs <= toMs,
    );
  }

  size(): number {
    return this.buffer.length;
  }

  time<T>(sql: string, fn: () => T): T {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.record(sql, performance.now() - t0);
    }
  }
}

type AnyFn = (...args: unknown[]) => unknown;

/** Instruments the connection in place; statements are timed with one performance.now() pair each. */
export function instrumentDatabase(
  database: Database.Database,
  recorder: SlowStatementRecorder,
): void {
  const origPrepare = database.prepare.bind(database) as AnyFn;
  (database as unknown as { prepare: AnyFn }).prepare = (...args) => {
    const stmt = origPrepare(...args) as unknown as Record<string, unknown>;
    const sql = String(args[0]);
    for (const m of ['run', 'get', 'all', 'iterate']) {
      const orig = (stmt[m] as AnyFn).bind(stmt);
      stmt[m] = (...a: unknown[]) => recorder.time(sql, () => orig(...a));
    }
    return stmt;
  };

  const origExec = database.exec.bind(database);
  database.exec = (sql: string) => recorder.time(sql, () => origExec(sql));

  const origTransaction = database.transaction.bind(database) as AnyFn;
  (database as unknown as { transaction: AnyFn }).transaction = (...args) => {
    const wrapped = origTransaction(...args) as unknown as Record<
      string,
      unknown
    >;
    const label = 'TRANSACTION (incl. COMMIT)';
    const wrap = (f: AnyFn): AnyFn => {
      return (...a) => recorder.time(label, () => f(...a));
    };
    const out = wrap(wrapped as unknown as AnyFn) as unknown as Record<
      string,
      unknown
    >;
    for (const v of ['deferred', 'immediate', 'exclusive']) {
      if (typeof wrapped[v] === 'function') out[v] = wrap(wrapped[v] as AnyFn);
    }
    return out;
  };
}
