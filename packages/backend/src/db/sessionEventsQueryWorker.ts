// Worker-thread entry point for the `sessionEvents.query` MCP tool's
// pattern-filtered reads (see mcp/tools/sessionEventsReadTools.ts).
//
// `payload LIKE '%...%'` can never be served from an index (leading
// wildcard), so a pattern-filtered call still has to evaluate every
// session_events row inside its since/until window — real, synchronous
// CPU/I/O — and better-sqlite3 is fully synchronous with no worker-thread or
// libuv-pool offload of its own, so issuing that scan on the shared
// main-thread `db` connection would block every Express route, WebSocket
// handler (including a concurrent `health` handshake), and other scheduled
// job on the process for the scan's full duration. This file runs on a
// separate worker thread and opens its OWN connection against the same
// on-disk database file, so the scan's CPU/I/O never occupies the main
// thread's event loop. It deliberately does not import db.ts or queries.ts:
// doing so would re-run db.ts's module side effects (opening the shared `db`
// singleton, schema assertions, migrations) on the worker thread, and
// queries.ts's prepared statements are bound to that singleton connection
// rather than this one. See walTruncateCheckpointWorker.ts and
// flakyTestRollupWorker.ts for the identical pattern applied elsewhere.
//
// buildFilterClauses/the two query shapes below are intentionally duplicated
// from db/queries.ts's querySessionEventsByProject{Aggregate,Rows} (same
// reason: this file can't import queries.ts) — keep them in sync with that
// module's buildSessionEventsFilterClauses if the filter semantics change.
import { parentPort, workerData } from 'worker_threads';
import Database from 'better-sqlite3';

interface SessionEventsQueryFilters {
  pattern?: string;
  since?: number;
  until?: number;
}

interface SessionEventsQueryWorkerData {
  dbPath: string;
  projectId: string;
  filters: SessionEventsQueryFilters;
  mode: 'aggregate' | 'rows';
  limit?: number;
}

interface SessionEventsAggregateRow {
  session_id: string;
  count: number;
  first_timestamp: number;
  last_timestamp: number;
}

interface SessionEventRow {
  id: number;
  session_id: string;
  event_type: string;
  payload: string;
  timestamp: number;
  message_id?: string | null;
}

type SessionEventsQueryWorkerResult =
  | { mode: 'aggregate'; sessions: SessionEventsAggregateRow[] }
  | { mode: 'rows'; rows: SessionEventRow[] };

function buildFilterClauses(filters: SessionEventsQueryFilters): {
  clauses: string[];
  params: (string | number)[];
} {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filters.pattern !== undefined) {
    clauses.push('session_events.payload LIKE ?');
    params.push(`%${filters.pattern}%`);
  }
  if (filters.since !== undefined) {
    clauses.push('session_events.timestamp >= ?');
    params.push(filters.since);
  }
  if (filters.until !== undefined) {
    clauses.push('session_events.timestamp <= ?');
    params.push(filters.until);
  }
  return { clauses, params };
}

function runAggregate(
  database: Database.Database,
  projectId: string,
  filters: SessionEventsQueryFilters,
): SessionEventsAggregateRow[] {
  const { clauses, params } = buildFilterClauses(filters);
  if (clauses.length === 0) {
    return database
      .prepare(
        `
        SELECT session_id AS session_id,
               event_count AS count,
               first_event_at AS first_timestamp,
               last_event_at AS last_timestamp
        FROM sessions
        WHERE project_id = ? AND event_count > 0
        ORDER BY last_event_at DESC
      `,
      )
      .all(projectId) as SessionEventsAggregateRow[];
  }
  const whereExtra = clauses.map((c) => `AND ${c}`).join(' ');
  return database
    .prepare(
      `
      SELECT session_events.session_id AS session_id,
             COUNT(*) AS count,
             MIN(session_events.timestamp) AS first_timestamp,
             MAX(session_events.timestamp) AS last_timestamp
      FROM sessions
      CROSS JOIN session_events ON session_events.session_id = sessions.session_id
      WHERE sessions.project_id = ? ${whereExtra}
      GROUP BY session_events.session_id
      ORDER BY last_timestamp DESC
    `,
    )
    .all(projectId, ...params) as SessionEventsAggregateRow[];
}

function runRows(
  database: Database.Database,
  projectId: string,
  filters: SessionEventsQueryFilters,
  limit: number,
): SessionEventRow[] {
  const { clauses, params } = buildFilterClauses(filters);
  const whereExtra = clauses.map((c) => `AND ${c}`).join(' ');
  return database
    .prepare(
      `
      SELECT session_events.*
      FROM sessions
      CROSS JOIN session_events ON session_events.session_id = sessions.session_id
      WHERE sessions.project_id = ? ${whereExtra}
      ORDER BY session_events.timestamp DESC
      LIMIT ?
    `,
    )
    .all(projectId, ...params, limit) as SessionEventRow[];
}

function run(): SessionEventsQueryWorkerResult {
  const { dbPath, projectId, filters, mode, limit } =
    workerData as SessionEventsQueryWorkerData;
  const database = new Database(dbPath, { readonly: true });
  // Mirrors flakyTestRollupWorker.ts's busy_timeout rationale: a read never
  // blocks on a concurrent writer under WAL mode, but setting this keeps the
  // connection resilient to the rare cross-mode contention window rather
  // than throwing immediately.
  database.pragma('busy_timeout = 5000');
  try {
    if (mode === 'aggregate') {
      return {
        mode: 'aggregate',
        sessions: runAggregate(database, projectId, filters),
      };
    }
    return {
      mode: 'rows',
      rows: runRows(database, projectId, filters, limit ?? 200),
    };
  } finally {
    database.close();
  }
}

if (!parentPort) {
  throw new Error(
    '[sessionEventsQueryWorker] must be run as a worker_threads Worker',
  );
}

try {
  parentPort.postMessage({ ok: true, result: run() });
} catch (err) {
  parentPort.postMessage({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  });
}
