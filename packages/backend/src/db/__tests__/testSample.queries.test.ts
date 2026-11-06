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
import {
  DROP_TEST_PERF_DIGEST_MARKER,
  dropTestPerfDigestColumns,
  runMigrations,
  runTestSampleBackfill,
} from '../schema.js';
import { hasTestPerfDigestColumns } from '../testSampleStore.js';

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

function restoreDigestColumns() {
  db.prepare(`DELETE FROM schema_backfills WHERE name = ?`).run(
    DROP_TEST_PERF_DIGEST_MARKER,
  );
  if (!hasTestPerfDigestColumns(db)) {
    db.exec(
      `ALTER TABLE test_perf_baselines ADD COLUMN recent_outcomes TEXT NOT NULL DEFAULT '[]';
       ALTER TABLE test_perf_baselines ADD COLUMN recent_durations TEXT NOT NULL DEFAULT '[]';`,
    );
  }
}

function seedDigest() {
  restoreDigestColumns();
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

describe('test_perf_baselines digest column drop', () => {
  const cols = () => hasTestPerfDigestColumns(db);

  it('refuses to drop while the by-value check reports a mismatch, then drops at zero', () => {
    seedDigest();
    runTestSampleBackfill(db);
    db.prepare(`UPDATE test_sample SET outcome='F' WHERE sequenced_at=?`).run(
      BASE + 1,
    );
    dropTestPerfDigestColumns(db);
    expect(cols()).toBe(true);
    expect(
      db
        .prepare(`SELECT 1 FROM schema_backfills WHERE name = ?`)
        .get(DROP_TEST_PERF_DIGEST_MARKER),
    ).toBeUndefined();

    db.prepare(`UPDATE test_sample SET outcome='P' WHERE sequenced_at=?`).run(
      BASE + 1,
    );
    dropTestPerfDigestColumns(db);
    expect(cols()).toBe(false);
    expect(
      db
        .prepare(`SELECT 1 FROM schema_backfills WHERE name = ?`)
        .get(DROP_TEST_PERF_DIGEST_MARKER),
    ).toBeDefined();
  });

  it('keeps ingestion working and updated_at strictly increasing with the columns absent', () => {
    restoreDigestColumns();
    dropTestPerfDigestColumns(db);
    runMigrations(db);
    expect(cols()).toBe(false);
    const updatedAt = () =>
      (
        db
          .prepare(
            `SELECT updated_at FROM test_perf_baselines WHERE test_id='d1'`,
          )
          .get() as { updated_at: number }
      ).updated_at;
    record('d1', 1, 'passed', 'h');
    const first = updatedAt();
    record('d1', 2, 'failed', 'h');
    expect(updatedAt()).toBeGreaterThan(first);
    expect(updatedAt()).toBe(BASE + 2);
  });
});

describe('test_sample backfill and verification', () => {
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
    upd(
      `UPDATE test_sample SET content_hash='b' WHERE sequenced_at=${BASE + 3}`,
    );
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
