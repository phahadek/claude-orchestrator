import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  SlowStatementRecorder,
  instrumentDatabase,
} from '../slowStatementRecorder';

function busyWait(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // spin
  }
}

describe('SlowStatementRecorder', () => {
  it('attributes a slow statement to an overlapping window, truncates SQL, drops fast ones', () => {
    const rec = new SlowStatementRecorder(20, 100, () => 5000);
    const db = new Database(':memory:');
    db.function('slow', () => {
      busyWait(40);
      return 1;
    });
    instrumentDatabase(db, rec);
    db.prepare('SELECT 1').get();
    expect(rec.size()).toBe(0);
    const long = `SELECT slow(), '${'x'.repeat(400)}' AS c WHERE ?`;
    db.prepare(long).get(1);
    expect(rec.size()).toBe(1);
    const hit = rec.overlapping(4000, 6000);
    expect(hit).toHaveLength(1);
    expect(hit[0].sql.length).toBe(200);
    expect(hit[0].durationMs).toBeGreaterThanOrEqual(20);
    expect(JSON.stringify(hit)).not.toContain('"1"');
    expect(rec.overlapping(0, 1000)).toHaveLength(0);
  });

  it('keeps a bounded ring buffer', () => {
    const rec = new SlowStatementRecorder(0, 3, () => 1);
    for (let i = 0; i < 10; i++) rec.record(`q${i}`, 1);
    expect(rec.size()).toBe(3);
    expect(rec.overlapping(0, 10).map((s) => s.sql)).toEqual([
      'q7',
      'q8',
      'q9',
    ]);
  });

  it('times exec and transactions and keeps results intact', () => {
    const rec = new SlowStatementRecorder(0, 100);
    const db = new Database(':memory:');
    instrumentDatabase(db, rec);
    db.exec('CREATE TABLE t (a INTEGER)');
    const insert = db.prepare('INSERT INTO t VALUES (?)');
    const tx = db.transaction((n: number) => {
      for (let i = 0; i < n; i++) insert.run(i);
      return n;
    });
    expect(tx(3)).toBe(3);
    expect(db.prepare('SELECT COUNT(*) AS c FROM t').get()).toEqual({ c: 3 });
    expect(db.prepare('SELECT a FROM t').all()).toHaveLength(3);
    expect(rec.size()).toBeGreaterThan(5);
  });
});
