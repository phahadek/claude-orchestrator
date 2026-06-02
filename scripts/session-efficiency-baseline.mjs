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
 *   - resume_count           = COUNT(audit_log session_launched where actor_id=session_id) - 1
 *                              null ("data gap") if no session_launched events recorded
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
const M8_START = Date.parse('2026-06-10T00:00:00Z'); // placeholder; update when M7 done-date is confirmed

function eraOf(startedAt) {
  if (startedAt < M4_START) return 'pre-M4';
  if (startedAt < M4_DONE) return 'M4';
  if (startedAt < M5_DONE) return 'M5';
  if (startedAt < M7_START) return 'M6';
  if (startedAt < M8_START) return 'M7';
  return 'M8';
}
const ERA_ORDER = ['pre-M4', 'M4', 'M5', 'M6', 'M7', 'M8'];

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
          AND a.actor_id = s.session_id
          AND a.actor_id IS NOT NULL
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
          AND a.actor_id = s.session_id
      ) AS launched_count,
      (
        SELECT MAX(p.review_iteration)
        FROM pull_requests p
        WHERE p.session_id = s.session_id OR p.task_id = s.task_id
      ) AS review_iteration,
      (
        SELECT COALESCE(SUM(
          COALESCE(pi.resumed_at, s.ended_at) - pi.paused_at
        ), 0)
        FROM session_pause_intervals pi
        WHERE pi.session_id = s.session_id
          AND (pi.resumed_at IS NOT NULL OR s.ended_at IS NOT NULL)
      ) AS total_paused_ms,
      sa.session_id AS audit_session_id,
      sa.pr_targets,
      sa.spec_mismatch AS audit_spec_mismatch,
      sa.violations
    FROM sessions s
    LEFT JOIN session_audits sa ON sa.session_id = s.session_id
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
  const total_paused_ms = r.total_paused_ms ?? 0;
  const active_wall_clock_ms =
    wall_clock_ms !== null
      ? Math.max(0, wall_clock_ms - total_paused_ms)
      : null;
  const time_to_pr_ms = r.pr_opened_ts ? r.pr_opened_ts - r.started_at : null;
  const tokens_total =
    (r.total_input_tokens ?? 0) + (r.total_output_tokens ?? 0);
  // null = no session_launched events found for this session (data gap for old sessions);
  // otherwise: launches minus 1 (the first launch is the original spawn, not a resume).
  const resume_count =
    r.launched_count > 0 ? Math.max(0, r.launched_count - 1) : null;
  const has_audit =
    r.audit_session_id !== null && r.audit_session_id !== undefined;
  const pr_wrong_base = has_audit
    ? r.pr_targets !== null && r.pr_targets !== undefined
      ? r.pr_targets !== 'dev'
        ? 1
        : 0
      : null
    : null;
  const spec_mismatch = has_audit
    ? r.audit_spec_mismatch !== null && r.audit_spec_mismatch !== undefined
      ? r.audit_spec_mismatch
        ? 1
        : 0
      : null
    : null;
  let violations_count = null;
  if (has_audit) {
    if (r.violations !== null && r.violations !== undefined) {
      try {
        violations_count = JSON.parse(r.violations).length;
      } catch {
        violations_count = 0;
      }
    } else {
      violations_count = 0;
    }
  }
  return {
    session_id: r.session_id,
    era: eraOf(r.started_at),
    task_name: r.task_name,
    status: r.status,
    model: r.model,
    started_at_iso: new Date(r.started_at).toISOString(),
    wall_clock_ms,
    active_wall_clock_ms,
    total_paused_ms,
    time_to_pr_ms,
    tokens_total,
    tool_call_proxy: r.tool_call_proxy,
    rate_limit_events: r.rate_limit_events,
    resume_count,
    review_iteration: r.review_iteration ?? null,
    pr_wrong_base,
    spec_mismatch,
    violations_count,
    pr_url: r.pr_url,
    project_id: r.project_id,
  };
});

// ── Per-pause-reason breakdown ─────────────────────────────────────────────
// Keyed by pause_reason, then era → { count, total_paused_ms }.
const pauseReasonBreakdown = {};
for (const era of [...ERA_ORDER, 'ALL']) {
  pauseReasonBreakdown[era] = {};
}
if (
  db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='session_pause_intervals'`,
    )
    .get()
) {
  const pauseRows = db
    .prepare(
      `SELECT pi.session_id, pi.pause_reason,
              COALESCE(pi.resumed_at, s.ended_at) - pi.paused_at AS duration_ms,
              s.started_at
       FROM session_pause_intervals pi
       JOIN sessions s ON s.session_id = pi.session_id
       WHERE (pi.resumed_at IS NOT NULL OR s.ended_at IS NOT NULL)
         AND (s.session_type != 'review' OR s.session_type IS NULL)`,
    )
    .all();
  for (const p of pauseRows) {
    const era = eraOf(p.started_at);
    for (const bucket of [era, 'ALL']) {
      if (!pauseReasonBreakdown[bucket][p.pause_reason]) {
        pauseReasonBreakdown[bucket][p.pause_reason] = {
          count: 0,
          total_paused_ms: 0,
        };
      }
      pauseReasonBreakdown[bucket][p.pause_reason].count += 1;
      pauseReasonBreakdown[bucket][p.pause_reason].total_paused_ms +=
        p.duration_ms ?? 0;
    }
  }
}

// ── Aggregates per (era, metric) ───────────────────────────────────────────
const METRICS = [
  'wall_clock_ms',
  'active_wall_clock_ms',
  'time_to_pr_ms',
  'tokens_total',
  'tool_call_proxy',
  'rate_limit_events',
  'resume_count',
  'review_iteration',
  'pr_wrong_base',
  'spec_mismatch',
  'violations_count',
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
  m === 'wall_clock_ms' ||
  m === 'active_wall_clock_ms' ||
  m === 'time_to_pr_ms';
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
    'active_wall_clock_ms',
    'total_paused_ms',
    'time_to_pr_ms',
    'tokens_total',
    'tool_call_proxy',
    'rate_limit_events',
    'resume_count',
    'review_iteration',
    'pr_wrong_base',
    'spec_mismatch',
    'violations_count',
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
      r.active_wall_clock_ms ?? '',
      r.total_paused_ms,
      r.time_to_pr_ms ?? '',
      r.tokens_total,
      r.tool_call_proxy,
      r.rate_limit_events,
      r.resume_count ?? '',
      r.review_iteration ?? '',
      r.pr_wrong_base ?? '',
      r.spec_mismatch ?? '',
      r.violations_count ?? '',
      r.project_id ?? '',
      JSON.stringify(r.task_name ?? '').replace(/^"|"$/g, ''),
    ].join(','),
  ),
].join('\n');

writeFileSync(join(outDir, 'per-session.csv'), perSessionCsv);
writeFileSync(
  join(outDir, 'aggregates.json'),
  JSON.stringify({ aggregates, topByMetric, pauseReasonBreakdown }, null, 2),
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
    if (metric === 'resume_count' && a.n === 0) {
      lines.push(
        `| ${era} | (data gap) | (data gap) | (data gap) | (data gap) |`,
      );
    } else {
      lines.push(
        `| ${era} | ${a.n} | ${fmtMetric(metric, a.p50)} | ${fmtMetric(metric, a.p95)} | ${fmtMetric(metric, a.max)} |`,
      );
    }
  }
  lines.push('');
}

lines.push(`## Pause-reason breakdown (ALL eras)\n`);
const allPauseBreakdown = pauseReasonBreakdown['ALL'] ?? {};
if (Object.keys(allPauseBreakdown).length === 0) {
  lines.push('No pause intervals recorded yet.\n');
} else {
  lines.push('| Reason | Events | Total paused |');
  lines.push('| --- | --- | --- |');
  for (const [reason, data] of Object.entries(allPauseBreakdown)) {
    lines.push(
      `| ${reason} | ${data.count} | ${fmtMs(data.total_paused_ms)} |`,
    );
  }
  lines.push('');
  lines.push('### Per-era pause breakdown\n');
  for (const era of ERA_ORDER) {
    const breakdown = pauseReasonBreakdown[era] ?? {};
    if (Object.keys(breakdown).length === 0) continue;
    lines.push(`**${era}**`);
    for (const [reason, data] of Object.entries(breakdown)) {
      lines.push(
        `  - ${reason}: ${data.count} events, ${fmtMs(data.total_paused_ms)} total`,
      );
    }
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
