#!/usr/bin/env node
/**
 * session-efficiency-baseline.mjs — Baseline coding-session efficiency.
 *
 * Reads dashboard.db (read-only) and emits per-session metrics + aggregate
 * statistics grouped by orchestrator "era" (pre-M4 / M4 / M5 / M6 / M7). Output
 * is local-only; do not commit the per-session CSV or the JSON report.
 *
 * Usage:
 *   node scripts/session-efficiency-baseline.mjs [db-path] [--out <dir>]
 *
 * Defaults:
 *   db-path = packages/backend/dashboard.db
 *   --out   = ./session-efficiency-baseline-output
 *
 * Metrics (per coding session only; review sessions excluded):
 *   - wall_clock_ms          = ended_at - started_at
 *   - time_to_pr_ms          = first pr_opened audit_log ts - started_at
 *   - tokens_total           = total_input_tokens + total_output_tokens
 *   - tool_call_proxy        = COUNT(session_events.event_type='system')
 *   - rate_limit_events      = COUNT(session_events.event_type='rate_limit')
 *   - resume_count           = COUNT(audit_log session_launched events with mode='resume')
 *                              fallback: count of distinct 'init' subtypes in payloads
 *   - review_iteration       = pull_requests.review_iteration for the session's PR
 *   - status                 = done|error|killed|running
 *
 * Aggregates:
 *   For each metric, group by era and report N, p50, p95, max.
 *
 * Drivers report:
 *   Top 10 most expensive sessions per metric (sorted desc).
 */

import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { argv } from 'node:process';

// ── Era boundaries (UTC milliseconds) ──────────────────────────────────────
// Based on milestone done-dates from .claude/local-context.md.
const M4_START = Date.parse('2026-04-03T00:00:00Z'); // right after M2a done
const M4_DONE = Date.parse('2026-05-22T00:00:00Z');
const M5_DONE = Date.parse('2026-05-26T00:00:00Z');
const M6_START = M5_DONE;
const M7_START = Date.parse('2026-05-30T00:00:00Z');

function eraOf(startedAt) {
  if (startedAt < M4_START) return 'pre-M4';
  if (startedAt < M4_DONE) return 'M4';
  if (startedAt < M5_DONE) return 'M5';
  if (startedAt < M7_START) return 'M6';
  return 'M7';
}
const ERA_ORDER = ['pre-M4', 'M4', 'M5', 'M6', 'M7'];

// ── Arg parsing ────────────────────────────────────────────────────────────
const args = argv.slice(2);
let dbPath = 'packages/backend/dashboard.db';
let outDir = './session-efficiency-baseline-output';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') {
    outDir = args[++i];
  } else if (!args[i].startsWith('--')) {
    dbPath = args[i];
  }
}
dbPath = resolve(dbPath);
outDir = resolve(outDir);

console.log(`[baseline] db=${dbPath}`);
console.log(`[baseline] out=${outDir}`);

const db = new Database(dbPath, { readonly: true });
mkdirSync(outDir, { recursive: true });

// ── Query: per-session metrics ─────────────────────────────────────────────
// Restrict to non-review sessions. Left-join audit_log for pr_opened. Left-join
// pull_requests via session_id for review_iteration. Aggregate event counts in
// correlated subqueries.
const rows = db
  .prepare(
    `
    SELECT
      s.session_id,
      s.task_id,
      s.task_name,
      s.project_id,
      s.status,
      s.started_at,
      s.ended_at,
      s.pr_url,
      s.total_input_tokens,
      s.total_output_tokens,
      s.model,
      (
        SELECT MIN(a.ts)
        FROM audit_log a
        WHERE a.event_type = 'pr_opened'
          AND a.task_id = s.task_id
          AND a.ts >= s.started_at
      ) AS pr_opened_ts,
      (
        SELECT COUNT(*)
        FROM session_events e
        WHERE e.session_id = s.session_id AND e.event_type = 'system'
      ) AS tool_call_proxy,
      (
        SELECT COUNT(*)
        FROM session_events e
        WHERE e.session_id = s.session_id AND e.event_type = 'rate_limit'
      ) AS rate_limit_events,
      (
        SELECT COUNT(*)
        FROM audit_log a
        WHERE a.event_type = 'session_launched'
          AND a.payload LIKE '%' || s.session_id || '%'
      ) AS launched_count,
      (
        SELECT MAX(p.review_iteration)
        FROM pull_requests p
        WHERE p.session_id = s.session_id OR p.task_id = s.task_id
      ) AS review_iteration
    FROM sessions s
    WHERE s.session_type != 'review' OR s.session_type IS NULL
    ORDER BY s.started_at ASC
  `,
  )
  .all();

console.log(`[baseline] loaded ${rows.length} coding sessions`);

// ── Compute derived metrics per session ────────────────────────────────────
const records = rows.map((r) => {
  const wall_clock_ms =
    r.ended_at && r.started_at ? r.ended_at - r.started_at : null;
  const time_to_pr_ms = r.pr_opened_ts ? r.pr_opened_ts - r.started_at : null;
  const tokens_total =
    (r.total_input_tokens ?? 0) + (r.total_output_tokens ?? 0);
  // resume_count is "launches minus 1" — first launch is the original spawn.
  const resume_count = Math.max(0, (r.launched_count ?? 1) - 1);
  return {
    session_id: r.session_id,
    era: eraOf(r.started_at),
    task_name: r.task_name,
    status: r.status,
    model: r.model,
    started_at_iso: new Date(r.started_at).toISOString(),
    wall_clock_ms,
    time_to_pr_ms,
    tokens_total,
    tool_call_proxy: r.tool_call_proxy,
    rate_limit_events: r.rate_limit_events,
    resume_count,
    review_iteration: r.review_iteration ?? null,
    pr_url: r.pr_url,
    project_id: r.project_id,
  };
});

// ── Aggregates per (era, metric) ───────────────────────────────────────────
const METRICS = [
  'wall_clock_ms',
  'time_to_pr_ms',
  'tokens_total',
  'tool_call_proxy',
  'rate_limit_events',
  'resume_count',
  'review_iteration',
];

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[idx];
}

function aggregate(values) {
  const filtered = values.filter((v) => v !== null && Number.isFinite(v));
  if (filtered.length === 0) return { n: 0, p50: null, p95: null, max: null };
  filtered.sort((a, b) => a - b);
  return {
    n: filtered.length,
    p50: percentile(filtered, 50),
    p95: percentile(filtered, 95),
    max: filtered[filtered.length - 1],
  };
}

const aggregates = {};
for (const era of [...ERA_ORDER, 'ALL']) {
  aggregates[era] = {};
  const eraRecords =
    era === 'ALL' ? records : records.filter((r) => r.era === era);
  for (const metric of METRICS) {
    aggregates[era][metric] = aggregate(eraRecords.map((r) => r[metric]));
  }
  aggregates[era]['session_count'] = eraRecords.length;
  aggregates[era]['status_breakdown'] = eraRecords.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
}

// ── Top 10 most expensive sessions per metric ──────────────────────────────
const topByMetric = {};
for (const metric of METRICS) {
  topByMetric[metric] = [...records]
    .filter((r) => r[metric] !== null && Number.isFinite(r[metric]))
    .sort((a, b) => b[metric] - a[metric])
    .slice(0, 10)
    .map((r) => ({
      session_id: r.session_id.slice(0, 8),
      era: r.era,
      task_name: r.task_name,
      [metric]: r[metric],
      status: r.status,
      project_id: r.project_id,
    }));
}

// ── Format helpers ─────────────────────────────────────────────────────────
const fmtMs = (ms) => {
  if (ms === null) return 'n/a';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(2)}h`;
};
const fmtInt = (n) =>
  n === null ? 'n/a' : Math.round(n).toLocaleString('en-US');
const isMsMetric = (m) =>
  m === 'wall_clock_ms' || m === 'time_to_pr_ms';
const fmtMetric = (m, v) => (isMsMetric(m) ? fmtMs(v) : fmtInt(v));

// ── Write outputs ──────────────────────────────────────────────────────────
const perSessionCsv = [
  [
    'session_id',
    'era',
    'status',
    'model',
    'started_at_iso',
    'wall_clock_ms',
    'time_to_pr_ms',
    'tokens_total',
    'tool_call_proxy',
    'rate_limit_events',
    'resume_count',
    'review_iteration',
    'project_id',
    'task_name',
  ].join(','),
  ...records.map((r) =>
    [
      r.session_id,
      r.era,
      r.status,
      r.model ?? '',
      r.started_at_iso,
      r.wall_clock_ms ?? '',
      r.time_to_pr_ms ?? '',
      r.tokens_total,
      r.tool_call_proxy,
      r.rate_limit_events,
      r.resume_count,
      r.review_iteration ?? '',
      r.project_id ?? '',
      JSON.stringify(r.task_name ?? '').replace(/^"|"$/g, ''),
    ].join(','),
  ),
].join('\n');

writeFileSync(join(outDir, 'per-session.csv'), perSessionCsv);
writeFileSync(
  join(outDir, 'aggregates.json'),
  JSON.stringify({ aggregates, topByMetric }, null, 2),
);

// ── Human-readable summary report ──────────────────────────────────────────
const lines = [];
lines.push(`# Session Efficiency Baseline\n`);
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push(`DB: ${dbPath}`);
lines.push(`Coding sessions analyzed: ${records.length}\n`);

lines.push(`## Sessions per era\n`);
for (const era of ERA_ORDER) {
  const agg = aggregates[era];
  const sb = agg.status_breakdown;
  const sbStr =
    Object.entries(sb)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ') || '(none)';
  lines.push(`- ${era}: ${agg.session_count} sessions (${sbStr})`);
}
lines.push('');

lines.push(`## Aggregates per metric per era\n`);
lines.push(`Format: N | p50 | p95 | max\n`);
for (const metric of METRICS) {
  lines.push(`### ${metric}`);
  lines.push('');
  lines.push('| Era | N | p50 | p95 | max |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const era of [...ERA_ORDER, 'ALL']) {
    const a = aggregates[era][metric];
    lines.push(
      `| ${era} | ${a.n} | ${fmtMetric(metric, a.p50)} | ${fmtMetric(metric, a.p95)} | ${fmtMetric(metric, a.max)} |`,
    );
  }
  lines.push('');
}

lines.push(`## Top 10 most expensive sessions per metric\n`);
for (const metric of METRICS) {
  lines.push(`### Top by ${metric}\n`);
  for (const s of topByMetric[metric]) {
    lines.push(
      `- ${s.session_id} [${s.era}] ${fmtMetric(metric, s[metric])} (${s.status}) ${s.task_name?.slice(0, 60) ?? '(no name)'}`,
    );
  }
  lines.push('');
}

const report = lines.join('\n');
writeFileSync(join(outDir, 'baseline-report.md'), report);

// Print summary to stdout for at-a-glance review.
console.log('\n' + report);
console.log(`\n[baseline] Output written to ${outDir}`);
console.log(
  `  - per-session.csv  (${records.length} rows)\n  - aggregates.json\n  - baseline-report.md`,
);

db.close();
