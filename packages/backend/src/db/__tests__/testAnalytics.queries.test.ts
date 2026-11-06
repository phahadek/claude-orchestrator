import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  classifyTestRequestRun,
  clampAnalyticsWindowDays,
  getLaneHealthRollup,
  getPassRateTrend,
  getQueueWaitDistribution,
  getSlowestAndRegressedTests,
  queueWaitSampleOf,
  TEST_RUN_RESULTS_RETENTION_MS,
  type TestRunClassifierInput,
} from '../queries.js';

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function input(
  over: Partial<TestRunClassifierInput> = {},
): TestRunClassifierInput {
  return {
    state: 'passed',
    failure_reason: null,
    oom_killed: 0,
    coverage_source_run_id: null,
    nothing_exercised: 0,
    finished_at: NOW - 1000,
    unexcused_failures: 0,
    excused_failures: 0,
    ...over,
  };
}

describe('classifyTestRequestRun', () => {
  const band = (over: Partial<TestRunClassifierInput>) =>
    classifyTestRequestRun(input(over), NOW).band;

  it('assigns one band per fixture run', () => {
    expect(band({})).toBe('executed_passed');
    expect(band({ state: 'failed', unexcused_failures: 1 })).toBe(
      'executed_failed',
    );
    expect(
      band({ state: 'failed', unexcused_failures: 1, excused_failures: 2 }),
    ).toBe('executed_failed');
    expect(band({ state: 'failed', excused_failures: 2 })).toBe(
      'executed_failed_all_excused',
    );
    expect(band({ state: 'failed', failure_reason: 'timeout' })).toBe(
      'oom_or_timeout',
    );
    expect(band({ state: 'failed', oom_killed: 1 })).toBe('oom_or_timeout');
    for (const r of ['cancelled', 'interrupted_queued', 'interrupted_running'])
      expect(band({ state: 'failed', failure_reason: r })).toBe('no_verdict');
    expect(band({ nothing_exercised: 1 })).toBe('nothing_exercised');
    expect(band({ coverage_source_run_id: 'src' })).toBe('reused');
  });

  it('classifies a reused run as reused even when its source passed', () => {
    expect(band({ state: 'passed', coverage_source_run_id: 'src' })).toBe(
      'reused',
    );
  });

  it('flags excusal as not retained for failed runs older than the retention horizon', () => {
    const old = classifyTestRequestRun(
      input({
        state: 'failed',
        finished_at: NOW - TEST_RUN_RESULTS_RETENTION_MS - 1,
      }),
      NOW,
    );
    expect(old).toEqual({ band: 'executed_failed', excusalRetained: false });
    const fresh = classifyTestRequestRun(input({ state: 'failed' }), NOW);
    expect(fresh.excusalRetained).toBe(true);
  });
});

describe('clampAnalyticsWindowDays', () => {
  it('defaults to 30 and clamps to 90', () => {
    expect(clampAnalyticsWindowDays(undefined)).toBe(30);
    expect(clampAnalyticsWindowDays(NaN)).toBe(30);
    expect(clampAnalyticsWindowDays(500)).toBe(90);
    expect(clampAnalyticsWindowDays(7)).toBe(7);
  });
});

let seq = 0;
function insertRun(o: {
  state: 'passed' | 'failed';
  requestedAt?: number | null;
  startedAt?: number | null;
  finishedAt: number;
  failureReason?: string | null;
  coverageSource?: string | null;
  nothingExercised?: number;
  runKind?: string;
}): string {
  seq += 1;
  const id = `ta-run-${seq}`;
  db.prepare(
    `INSERT INTO test_request_runs
       (id, project_id, content_hash, session_id, state, output, requested_at, started_at, finished_at, failure_reason, coverage_source_run_id, nothing_exercised, run_kind)
     VALUES (@id, 'p1', @hash, NULL, @state, '', @requested_at, @started_at, @finished_at, @failure_reason, @cov, @ne, @kind)`,
  ).run({
    id,
    hash: `h-${seq}`,
    state: o.state,
    requested_at: o.requestedAt ?? null,
    started_at: o.startedAt === undefined ? o.finishedAt - 1000 : o.startedAt,
    finished_at: o.finishedAt,
    failure_reason: o.failureReason ?? null,
    cov: o.coverageSource ?? null,
    ne: o.nothingExercised ?? 0,
    kind: o.runKind ?? 'full',
  });
  return id;
}

function insertFailedResult(runId: string, excusedReason: string | null) {
  seq += 1;
  db.prepare(
    `INSERT INTO test_run_results
       (test_request_run_id, project_id, test_id, name, outcome, duration_ms, oom_killed, excused_at, excused_reason, created_at)
     VALUES (@run, 'p1', @tid, 'n', 'failed', 1, 0, @ea, @er, 1)`,
  ).run({
    run: runId,
    tid: `t-${seq}`,
    ea: excusedReason ? 1 : null,
    er: excusedReason,
  });
}

beforeEach(() => {
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_request_runs').run();
  db.prepare('DELETE FROM test_perf_baselines').run();
});

describe('pass rate (trend + lane-health rollup)', () => {
  function seedMix() {
    const t = Date.now() - 1000;
    insertRun({ state: 'passed', finishedAt: t });
    insertRun({ state: 'passed', finishedAt: t, coverageSource: 'x' });
    insertRun({ state: 'passed', finishedAt: t, nothingExercised: 1 });
    insertRun({ state: 'failed', finishedAt: t, failureReason: 'cancelled' });
    const excused = insertRun({ state: 'failed', finishedAt: t });
    insertFailedResult(excused, 'flaky_confirm');
    return t;
  }

  it('excludes reused/no_verdict/nothing_exercised and never counts all-excused in the numerator', () => {
    seedMix();
    const trend = getPassRateTrend('p1');
    const days = trend.runKinds.full;
    const total = days.reduce((a, d) => a + d.bands.executed_passed, 0);
    expect(total).toBe(1);
    const rate = days.map((d) => d.passRate).filter((r) => r !== null);
    expect(rate).toEqual([0.5]);
    expect(getLaneHealthRollup('p1').passRate).toBe(0.5);
    expect(days[0].excusedBySource).toEqual({ flaky_confirm: 1 });
  });

  it('reports aged-out failed runs as excusal not retained', () => {
    insertRun({ state: 'failed', finishedAt: Date.now() - 20 * DAY });
    const trend = getPassRateTrend('p1');
    expect(trend.runKinds.full[0].failedExcusalNotRetained).toBe(1);
  });

  it('buckets by UTC day and clamps the window to 90 days', () => {
    insertRun({ state: 'passed', finishedAt: NOW - 1000 });
    insertRun({ state: 'passed', finishedAt: NOW - DAY });
    insertRun({ state: 'passed', finishedAt: NOW - 100 * DAY });
    const trend = getPassRateTrend('p1', 500, NOW);
    expect(trend.windowDays).toBe(90);
    expect(trend.runKinds.full.map((d) => d.day)).toEqual([
      '2026-06-14',
      '2026-06-15',
    ]);
  });
});

describe('queue-wait distribution', () => {
  it('excludes reused runs and runs with no recorded queue time', () => {
    insertRun({
      state: 'passed',
      requestedAt: NOW - 5000,
      startedAt: NOW - 4000,
      finishedAt: NOW - 1000,
    });
    insertRun({
      state: 'passed',
      requestedAt: NOW - 9000,
      startedAt: NOW - 1000,
      finishedAt: NOW - 500,
      coverageSource: 'x',
    });
    insertRun({
      state: 'failed',
      requestedAt: null,
      finishedAt: NOW - 500,
    });
    const { days } = getQueueWaitDistribution('p1', 30, NOW);
    expect(days).toHaveLength(1);
    expect(days[0].sampleCount).toBe(1);
    expect(days[0].p50).toBe(1000);
  });
});

describe('queueWaitSampleOf', () => {
  it('excludes null started_at, null requested_at and reused runs', () => {
    const base = { ...input(), requested_at: 1000, started_at: 3000 };
    expect(queueWaitSampleOf(base, NOW)?.waitMs).toBe(2000);
    expect(queueWaitSampleOf({ ...base, started_at: null }, NOW)).toBeNull();
    expect(queueWaitSampleOf({ ...base, requested_at: null }, NOW)).toBeNull();
    expect(
      queueWaitSampleOf({ ...base, coverage_source_run_id: 'src' }, NOW),
    ).toBeNull();
  });
});

describe('all-excused runs and passRate', () => {
  it('a run whose failures are all excused is in the denominator only', () => {
    const t = Date.now() - 1000;
    const r = insertRun({ state: 'failed', finishedAt: t });
    insertFailedResult(r, 'flaky_confirm');
    const day = getPassRateTrend('p1').runKinds.full[0];
    expect(day.bands.executed_failed_all_excused).toBe(1);
    expect(day.bands.executed_passed).toBe(0);
    expect(day.passRate).toBe(0);
    expect(getLaneHealthRollup('p1').passRate).toBe(0);
  });
});

describe('slowest and regressed tests', () => {
  it('reads baseline scalars without touching recent_* columns', () => {
    const insert = db.prepare(
      `INSERT INTO test_perf_baselines
         (test_id, project_id, name, median_duration_ms, mad_duration_ms, sample_count, last_duration_ms, is_regressed, updated_at)
       VALUES (@id, 'p1', @id, @median, 1, 5, @median, @reg, 1)`,
    );
    insert.run({ id: 'a', median: 100, reg: 0 });
    insert.run({ id: 'b', median: 900, reg: 1 });
    const prepare = vi.spyOn(db, 'prepare');
    const res = getSlowestAndRegressedTests('p1');
    const sql = prepare.mock.calls.map((c) => String(c[0])).join(' ');
    prepare.mockRestore();
    expect(sql).not.toMatch(/recent_outcomes|recent_durations/);
    expect(res.slowest.map((t) => t.testId)).toEqual(['b', 'a']);
    expect(res.regressed.map((t) => t.testId)).toEqual(['b']);
  });
});
