import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  recordTestPerfDigestSample,
  verifyTestSampleDigestParity,
} from '../queries.js';
import { runTestSampleBackfill } from '../schema.js';

const BASE = 1_700_000_000_000 * 1000;

function record(
  testId: string,
  i: number,
  outcome: 'passed' | 'failed',
  hash: string | null,
  durationMs = 10 + i,
) {
  recordTestPerfDigestSample(
    testId,
    'p1',
    testId,
    outcome,
    durationMs,
    0,
    false,
    BASE + i,
    undefined,
    0,
    hash,
    false,
    'run-1',
  );
}

function total() {
  return verifyTestSampleDigestParity().reduce(
    (n, r) => n + r.outcomeMismatches + r.durationMismatches,
    0,
  );
}

beforeEach(() => {
  db.exec(
    `DELETE FROM test_sample; DELETE FROM test_sample_history; DELETE FROM test_perf_baselines;`,
  );
  db.prepare(`DELETE FROM schema_backfills WHERE name = ?`).run(
    'test_sample_backfill_v1',
  );
});

describe('test_sample dual-write', () => {
  it('projection equals the digest and pruning keeps retention floors', () => {
    for (let i = 0; i < 260; i++)
      record('t1', i, i % 2 ? 'passed' : 'failed', 'h');
    expect(total()).toBe(0);
    const o = db
      .prepare(`SELECT COUNT(*) c FROM test_sample WHERE outcome IS NOT NULL`)
      .get() as { c: number };
    expect(o.c).toBeGreaterThanOrEqual(200);
    const hist = db
      .prepare(
        `SELECT SUM(pass_count + fail_count) n, SUM(duration_count) d, SUM(transition_count) t FROM test_sample_history`,
      )
      .get() as { n: number; d: number; t: number };
    expect(hist.n + o.c).toBe(260);
    // alternating outcomes on one hash: every evicted row after the first is a transition
    expect(hist.t).toBe(hist.n - 1);
  });

  it('counts each evicted row exactly once', () => {
    for (let i = 0; i < 300; i++) record('t2', i, 'passed', null);
    const live = db.prepare(`SELECT COUNT(*) c FROM test_sample`).get() as {
      c: number;
    };
    const hist = db
      .prepare(
        `SELECT SUM(pass_count) n, SUM(transition_count) t FROM test_sample_history`,
      )
      .get() as { n: number; t: number };
    expect(live.c + hist.n).toBe(300);
    expect(hist.t).toBe(0);
  });
});

describe('test_sample backfill and verification', () => {
  function seedDigest() {
    const outcomes = [
      { o: 'P', t: BASE + 1, h: 'a' },
      { o: 'F', t: BASE + 2 },
      { o: 'P', t: BASE + 3, h: 'b' },
    ];
    db.prepare(
      `INSERT INTO test_perf_baselines
        (test_id, project_id, name, median_duration_ms, mad_duration_ms, sample_count, last_duration_ms, is_regressed, recent_outcomes, recent_durations, updated_at)
       VALUES ('b1','p1','b1',0,0,0,0,0,?,?,?)`,
    ).run(JSON.stringify(outcomes), JSON.stringify([5, 6, 7]), BASE + 3);
  }
  const count = () =>
    (db.prepare(`SELECT COUNT(*) c FROM test_sample`).get() as { c: number }).c;

  it('is idempotent, resumes after a crash, and verifies clean', () => {
    seedDigest();
    runTestSampleBackfill(db, 1);
    expect(count()).toBe(6);
    expect(total()).toBe(0);

    db.prepare(`DELETE FROM schema_backfills WHERE name = ?`).run(
      'test_sample_backfill_v1',
    );
    db.prepare(`DELETE FROM test_sample WHERE sequenced_at > ?`).run(BASE + 3);
    runTestSampleBackfill(db, 1);
    expect(count()).toBe(6);
    runTestSampleBackfill(db, 1);
    expect(count()).toBe(6);
    expect(total()).toBe(0);
  });

  it('detects injected mismatches in o, t, h, order and duration', () => {
    seedDigest();
    runTestSampleBackfill(db);
    expect(total()).toBe(0);
    const upd = (sql: string) => db.prepare(sql).run();
    upd(`UPDATE test_sample SET outcome='F' WHERE sequenced_at=${BASE + 1}`);
    expect(total()).toBe(1);
    upd(`UPDATE test_sample SET outcome='P' WHERE sequenced_at=${BASE + 1}`);
    upd(
      `UPDATE test_sample SET content_hash='zz' WHERE sequenced_at=${BASE + 3}`,
    );
    expect(total()).toBe(1);
    upd(`UPDATE test_sample SET content_hash='b' WHERE sequenced_at=${BASE + 3}`);
    upd(
      `UPDATE test_sample SET sequenced_at=${BASE + 99} WHERE sequenced_at=${BASE + 2}`,
    );
    expect(total()).toBeGreaterThan(0);
    upd(
      `UPDATE test_sample SET sequenced_at=${BASE + 2} WHERE sequenced_at=${BASE + 99}`,
    );
    expect(total()).toBe(0);
    upd(`UPDATE test_sample SET duration_ms=999 WHERE duration_ms=6`);
    expect(total()).toBe(1);
  });
});
