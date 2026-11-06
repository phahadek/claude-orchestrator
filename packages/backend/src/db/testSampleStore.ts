// Shared, import-free-of-app-state helpers for test_sample/test_sample_history.
// Used by the main-thread digest writer (queries.ts), the ingestion worker
// thread (testRunIngestionWorker.ts, which cannot import queries.ts/db.ts) and
// the boot backfill (schema.ts). Every function takes the connection to use
// and never opens its own transaction — callers batch.
import type Database from 'better-sqlite3';

const TEST_SAMPLE_OUTCOME_RETENTION = 200;
const TEST_SAMPLE_DURATION_RETENTION = 32;

const MS_VS_US_THRESHOLD = 1e15;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Epoch is a Thursday; shift so buckets start on Monday 00:00 UTC.
const WEEK_OFFSET_MS = 4 * 24 * 60 * 60 * 1000;

/** Mirrors toDigestMicros in db/queries.ts. */
function sampleMicros(value: number): number {
  return value < MS_VS_US_THRESHOLD ? value * 1000 : value;
}

function weekStartMs(sequencedAt: number): number {
  const ms = Math.floor(sampleMicros(sequencedAt) / 1000);
  return (
    Math.floor((ms - WEEK_OFFSET_MS) / WEEK_MS) * WEEK_MS + WEEK_OFFSET_MS
  );
}

export interface TestSampleInput {
  testId: string;
  projectId: string;
  runId: string | null;
  sequencedAt: number;
  outcome: 'P' | 'F' | null;
  durationMs: number | null;
  contentHash: string | null;
}

interface Stmts {
  insert: Database.Statement;
  outcomeCutoff: Database.Statement;
  durationCutoff: Database.Statement;
  evictable: Database.Statement;
  deleteBelow: Database.Statement;
  chainTail: Database.Statement;
  bucket: Database.Statement;
  upsertBucket: Database.Statement;
}

const stmtCache = new WeakMap<Database.Database, Stmts>();

function stmts(database: Database.Database): Stmts {
  let s = stmtCache.get(database);
  if (!s) {
    s = {
      insert: database.prepare(
        `INSERT OR IGNORE INTO test_sample
           (test_id, project_id, run_id, sequenced_at, outcome, duration_ms, content_hash)
         VALUES (@test_id, @project_id, @run_id, @sequenced_at, @outcome, @duration_ms, @content_hash)`,
      ),
      outcomeCutoff: database.prepare(
        `SELECT sequenced_at FROM test_sample
         WHERE test_id = ? AND outcome IS NOT NULL
         ORDER BY sequenced_at DESC LIMIT 1 OFFSET ?`,
      ),
      durationCutoff: database.prepare(
        `SELECT sequenced_at FROM test_sample
         WHERE test_id = ? AND duration_ms IS NOT NULL
         ORDER BY sequenced_at DESC LIMIT 1 OFFSET ?`,
      ),
      evictable: database.prepare(
        `SELECT project_id, sequenced_at, outcome, duration_ms, content_hash
         FROM test_sample WHERE test_id = ? AND sequenced_at < ?
         ORDER BY sequenced_at ASC`,
      ),
      deleteBelow: database.prepare(
        `DELETE FROM test_sample WHERE test_id = ? AND sequenced_at < ?`,
      ),
      chainTail: database.prepare(
        `SELECT last_outcome, last_content_hash FROM test_sample_history
         WHERE test_id = ? ORDER BY week_start DESC LIMIT 1`,
      ),
      bucket: database.prepare(
        `SELECT * FROM test_sample_history WHERE test_id = ? AND week_start = ?`,
      ),
      upsertBucket: database.prepare(
        `INSERT INTO test_sample_history
           (test_id, project_id, week_start, pass_count, fail_count, transition_count,
            duration_count, duration_sum_ms, duration_min_ms, duration_max_ms,
            last_outcome, last_content_hash)
         VALUES
           (@test_id, @project_id, @week_start, @pass_count, @fail_count, @transition_count,
            @duration_count, @duration_sum_ms, @duration_min_ms, @duration_max_ms,
            @last_outcome, @last_content_hash)
         ON CONFLICT(test_id, week_start) DO UPDATE SET
           project_id = excluded.project_id,
           pass_count = excluded.pass_count,
           fail_count = excluded.fail_count,
           transition_count = excluded.transition_count,
           duration_count = excluded.duration_count,
           duration_sum_ms = excluded.duration_sum_ms,
           duration_min_ms = excluded.duration_min_ms,
           duration_max_ms = excluded.duration_max_ms,
           last_outcome = excluded.last_outcome,
           last_content_hash = excluded.last_content_hash`,
      ),
    };
    stmtCache.set(database, s);
  }
  return s;
}

export function insertTestSample(
  database: Database.Database,
  s: TestSampleInput,
): void {
  stmts(database).insert.run({
    test_id: s.testId,
    project_id: s.projectId,
    run_id: s.runId,
    sequenced_at: s.sequencedAt,
    outcome: s.outcome,
    duration_ms: s.durationMs,
    content_hash: s.contentHash,
  });
}

interface HistoryBucket {
  test_id: string;
  project_id: string;
  week_start: number;
  pass_count: number;
  fail_count: number;
  transition_count: number;
  duration_count: number;
  duration_sum_ms: number;
  duration_min_ms: number | null;
  duration_max_ms: number | null;
  last_outcome: string | null;
  last_content_hash: string | null;
}

/**
 * Evicts rows older than both the 200th-newest outcome-bearing row and the
 * 32nd-newest duration-bearing row (neither cutoff existing means nothing is
 * evictable), folding each into its week bucket before deleting. Rows are
 * folded oldest-first so transition_count follows the true outcome chain.
 */
export function pruneTestSamples(
  database: Database.Database,
  testId: string,
): void {
  const s = stmts(database);
  const o = s.outcomeCutoff.get(testId, TEST_SAMPLE_OUTCOME_RETENTION - 1) as
    | { sequenced_at: number }
    | undefined;
  if (!o) return;
  const d = s.durationCutoff.get(testId, TEST_SAMPLE_DURATION_RETENTION - 1) as
    | { sequenced_at: number }
    | undefined;
  if (!d) return;
  const cutoff = Math.min(o.sequenced_at, d.sequenced_at);

  const rows = s.evictable.all(testId, cutoff) as Array<{
    project_id: string;
    sequenced_at: number;
    outcome: string | null;
    duration_ms: number | null;
    content_hash: string | null;
  }>;
  if (rows.length === 0) return;

  const tail = s.chainTail.get(testId) as
    | { last_outcome: string | null; last_content_hash: string | null }
    | undefined;
  let chainOutcome = tail?.last_outcome ?? null;
  let chainHash = tail?.last_content_hash ?? null;
  const buckets = new Map<number, HistoryBucket>();

  for (const r of rows) {
    const week = weekStartMs(r.sequenced_at);
    let b = buckets.get(week);
    if (!b) {
      b =
        (s.bucket.get(testId, week) as HistoryBucket | undefined) ?? {
          test_id: testId,
          project_id: r.project_id,
          week_start: week,
          pass_count: 0,
          fail_count: 0,
          transition_count: 0,
          duration_count: 0,
          duration_sum_ms: 0,
          duration_min_ms: null,
          duration_max_ms: null,
          last_outcome: null,
          last_content_hash: null,
        };
      buckets.set(week, b);
    }
    if (r.outcome) {
      if (r.outcome === 'P') b.pass_count++;
      else b.fail_count++;
      if (
        chainOutcome !== null &&
        r.outcome !== chainOutcome &&
        r.content_hash !== null &&
        r.content_hash === chainHash
      ) {
        b.transition_count++;
      }
      chainOutcome = r.outcome;
      chainHash = r.content_hash;
      b.last_outcome = r.outcome;
      b.last_content_hash = r.content_hash;
    }
    if (r.duration_ms !== null) {
      b.duration_count++;
      b.duration_sum_ms += r.duration_ms;
      b.duration_min_ms =
        b.duration_min_ms === null
          ? r.duration_ms
          : Math.min(b.duration_min_ms, r.duration_ms);
      b.duration_max_ms =
        b.duration_max_ms === null
          ? r.duration_ms
          : Math.max(b.duration_max_ms, r.duration_ms);
    }
  }
  for (const b of buckets.values()) s.upsertBucket.run(b);
  s.deleteBelow.run(testId, cutoff);
}

// ─── boot backfill ──────────────────────────────────────────────────────────

export const TEST_SAMPLE_BACKFILL_MARKER = 'test_sample_backfill_v1';
const TEST_SAMPLE_BACKFILL_BATCH_SIZE = 500;

interface DigestOutcome {
  o: 'P' | 'F';
  t: number;
  h?: string;
}

function parseArray<T>(json: string): T[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Idempotent (INSERT OR IGNORE, deterministic synthetic timestamps); never deletes a source. */
export function backfillTestSamples(
  target: Database.Database,
  batchSize: number = TEST_SAMPLE_BACKFILL_BATCH_SIZE,
): void {
  const page = target.prepare(
    `SELECT test_id, project_id, recent_outcomes, recent_durations, updated_at
     FROM test_perf_baselines WHERE test_id > ? ORDER BY test_id LIMIT ?`,
  );
  const insert = stmts(target).insert;
  let after = '';
  for (;;) {
    const batch = page.all(after, batchSize) as Array<{
      test_id: string;
      project_id: string;
      recent_outcomes: string;
      recent_durations: string;
      updated_at: number;
    }>;
    if (batch.length === 0) break;
    target.transaction(() => {
      for (const row of batch) {
        const outcomes = parseArray<DigestOutcome>(row.recent_outcomes);
        const durations = parseArray<number>(row.recent_durations);
        let newest = 0;
        for (const smp of outcomes) {
          const t = sampleMicros(smp.t);
          if (t > newest) newest = t;
          insert.run({
            test_id: row.test_id,
            project_id: row.project_id,
            run_id: null,
            sequenced_at: t,
            outcome: smp.o,
            duration_ms: null,
            content_hash: smp.h ?? null,
          });
        }
        if (outcomes.length === 0) newest = sampleMicros(row.updated_at);
        durations.forEach((ms, i) => {
          insert.run({
            test_id: row.test_id,
            project_id: row.project_id,
            run_id: null,
            sequenced_at: newest + 1 + i,
            outcome: null,
            duration_ms: ms,
            content_hash: null,
          });
        });
      }
    })();
    after = batch[batch.length - 1].test_id;
    if (batch.length < batchSize) break;
  }
}

// ─── verification ───────────────────────────────────────────────────────────

export interface TestSampleVerificationRow {
  projectId: string;
  testsChecked: number;
  outcomeMismatches: number;
  durationMismatches: number;
}

/**
 * Per project, counts digest elements the test_sample projection fails to
 * reproduce: the newest N outcome-bearing rows must equal recent_outcomes on
 * (o, micros(t), h) and the newest M duration-bearing rows must equal
 * recent_durations, element by element, oldest-first. A missing or differing
 * element counts once.
 */
export function verifyTestSamples(
  database: Database.Database,
  batchSize: number = TEST_SAMPLE_BACKFILL_BATCH_SIZE,
): TestSampleVerificationRow[] {
  const page = database.prepare(
    `SELECT test_id, project_id, recent_outcomes, recent_durations
     FROM test_perf_baselines WHERE test_id > ? ORDER BY test_id LIMIT ?`,
  );
  const newestOutcomes = database.prepare(
    `SELECT outcome, sequenced_at, content_hash FROM test_sample
     WHERE test_id = ? AND outcome IS NOT NULL
     ORDER BY sequenced_at DESC LIMIT ?`,
  );
  const newestDurations = database.prepare(
    `SELECT duration_ms FROM test_sample
     WHERE test_id = ? AND duration_ms IS NOT NULL
     ORDER BY sequenced_at DESC LIMIT ?`,
  );
  const byProject = new Map<string, TestSampleVerificationRow>();
  let after = '';
  for (;;) {
    const batch = page.all(after, batchSize) as Array<{
      test_id: string;
      project_id: string;
      recent_outcomes: string;
      recent_durations: string;
    }>;
    if (batch.length === 0) break;
    for (const row of batch) {
      let acc = byProject.get(row.project_id);
      if (!acc) {
        acc = {
          projectId: row.project_id,
          testsChecked: 0,
          outcomeMismatches: 0,
          durationMismatches: 0,
        };
        byProject.set(row.project_id, acc);
      }
      acc.testsChecked++;
      const outcomes = parseArray<DigestOutcome>(row.recent_outcomes);
      const durations = parseArray<number>(row.recent_durations);
      const oRows = (
        newestOutcomes.all(row.test_id, outcomes.length) as Array<{
          outcome: string;
          sequenced_at: number;
          content_hash: string | null;
        }>
      ).reverse();
      const oOffset = outcomes.length - oRows.length;
      outcomes.forEach((smp, i) => {
        const r = i >= oOffset ? oRows[i - oOffset] : undefined;
        if (
          !r ||
          r.outcome !== smp.o ||
          r.sequenced_at !== sampleMicros(smp.t) ||
          r.content_hash !== (smp.h ?? null)
        ) {
          acc.outcomeMismatches++;
        }
      });
      const dRows = (
        newestDurations.all(row.test_id, durations.length) as Array<{
          duration_ms: number;
        }>
      ).reverse();
      const dOffset = durations.length - dRows.length;
      durations.forEach((ms, i) => {
        const r = i >= dOffset ? dRows[i - dOffset] : undefined;
        if (!r || r.duration_ms !== ms) acc.durationMismatches++;
      });
    }
    after = batch[batch.length - 1].test_id;
    if (batch.length < batchSize) break;
  }
  return [...byProject.values()];
}
