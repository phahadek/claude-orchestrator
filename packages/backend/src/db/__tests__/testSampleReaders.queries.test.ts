import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  recordTestPerfDigestSample,
  computeTestFlipRateFlag,
  listRecentValidTestDurations,
} from '../queries.js';

const BASE = 1_700_000_000_000 * 1000;

function record(
  i: number,
  outcome: 'passed' | 'failed',
  hash: string | null,
  concurrent: number,
  t = BASE + i,
) {
  recordTestPerfDigestSample(
    't1',
    'p1',
    't1',
    outcome,
    100 + i,
    concurrent,
    false,
    t,
    undefined,
    0,
    hash,
    false,
    'run-1',
  );
}

interface DigestRow {
  recent_outcomes: string;
  recent_durations: string;
}

function digest(): {
  outcomes: Array<{ o: string; t: number; h?: string }>;
  durations: number[];
} {
  const row = db
    .prepare(
      `SELECT recent_outcomes, recent_durations FROM test_perf_baselines WHERE test_id = 't1'`,
    )
    .get() as DigestRow;
  return {
    outcomes: JSON.parse(row.recent_outcomes),
    durations: JSON.parse(row.recent_durations),
  };
}

function digestFlip(windowN: number, k: number, beforeMs?: number) {
  const m = (v: number) => (v < 1e15 ? v * 1000 : v);
  let all = digest().outcomes;
  if (beforeMs !== undefined) all = all.filter((s) => m(s.t) < m(beforeMs));
  const w = all.slice(-windowN);
  let n = 0;
  for (let i = 1; i < w.length; i++) {
    if (w[i].o !== w[i - 1].o && w[i - 1].h && w[i].h && w[i - 1].h === w[i].h)
      n++;
  }
  return { sampleCount: w.length, transitionCount: n, flagged: n >= k };
}

beforeEach(() => {
  db.exec(
    `DELETE FROM test_sample; DELETE FROM test_sample_history; DELETE FROM test_perf_baselines;`,
  );
});

describe('test_sample readers match the digest', () => {
  it('flip-rate and durations over mixed concurrent/solo and hash-less samples', () => {
    for (let i = 0; i < 60; i++) {
      const hash = i % 7 === 0 ? null : i < 30 ? 'a' : 'b';
      record(i, i % 2 ? 'passed' : 'failed', hash, i % 3 === 0 ? 1 : 0);
    }
    for (const [n, k] of [
      [5, 2],
      [20, 3],
      [200, 3],
    ]) {
      const got = computeTestFlipRateFlag('t1', n, k);
      const want = digestFlip(n, k);
      expect(got).toMatchObject(want);
    }
    const cutoffMs = Math.floor((BASE + 25) / 1000);
    // cutoff in ms (legacy unit) and in micros both reproduce the digest filter
    expect(computeTestFlipRateFlag('t1', 20, 3, BASE + 25)).toMatchObject(
      digestFlip(20, 3, BASE + 25),
    );
    expect(computeTestFlipRateFlag('t1', 20, 3, cutoffMs + 1)).toMatchObject(
      digestFlip(20, 3, cutoffMs + 1),
    );
    const durs = digest().durations;
    expect(listRecentValidTestDurations('t1', 32)).toEqual([...durs].reverse());
    expect(listRecentValidTestDurations('t1', 5)).toEqual(
      durs.slice(-5).reverse(),
    );
  });

  it('only the dual-write digest writers and the verifier read the digest blobs', () => {
    const root = path.resolve(__dirname, '..', '..');
    const allowed = new Set([
      'db/queries.ts',
      'db/testRunIngestionWorker.ts',
      'db/testSampleStore.ts',
      'db/schema.ts',
      'db/types.ts',
    ]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== '__tests__' && e.name !== 'node_modules') walk(full);
        } else if (e.name.endsWith('.ts')) {
          const rel = path.relative(root, full).split(path.sep).join('/');
          if (
            !allowed.has(rel) &&
            /recent_outcomes|recent_durations/.test(
              fs.readFileSync(full, 'utf8'),
            )
          ) {
            offenders.push(rel);
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
