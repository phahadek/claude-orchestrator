/**
 * Capability-gated, read-only ad hoc query over the orchestrator's own DB.
 *
 * A gate-verify/ops session with a specific, already-formulated read-only
 * SQL need against a table with no dedicated MCP read tool requests the
 * exact query text as a tool-shaped `Bash(...)` capability via
 * `session.requestCapability` (see `isToolShapedCapability`,
 * packages/backend/src/session/orchestrator-config.ts) and gets it reviewed
 * by an operator, who runs this script with that literal query on approval.
 *
 * Two independent layers keep this read-only, deliberately not just one:
 *   1. `assertSingleReadOnlyStatement` rejects anything that isn't exactly
 *      one SELECT/WITH statement *before this process ever opens a
 *      connection* — a cheap, syntactic gate against an obviously wrong
 *      request (multi-statement chaining, a bare INSERT/UPDATE/DELETE).
 *   2. The connection itself is opened with better-sqlite3's `readonly:
 *      true`, enforced by the SQLite driver, not by this script's own text
 *      matching. Step 1's text check is bypassable (e.g. a write-capable
 *      CTE like `WITH x AS (INSERT ... RETURNING ...) SELECT * FROM x`
 *      still parses as "starts with WITH"); step 2 is what actually stops
 *      a write from taking effect.
 *
 * Run manually:
 *   npx ts-node packages/backend/scripts/adhoc-query.ts "SELECT id FROM sessions LIMIT 5"
 */
import Database from 'better-sqlite3';
import { getOrchestratorConfig } from '../src/config/appConfig';
import { getDataDir } from '../src/config/dataDir';
import { resolveDbPath } from '../src/config/resolveDbPath';

/** Row cap applied regardless of the query's own LIMIT (or lack of one). */
export const ADHOC_QUERY_ROW_CAP = 200;

/** Character cap on the formatted JSON output, independent of row count. */
export const ADHOC_QUERY_MAX_OUTPUT_CHARS = 200_000;

export class AdhocQueryValidationError extends Error {}

export interface AdhocQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

/**
 * Replaces the contents of every `'...'` string literal with placeholder
 * characters of the same length, leaving everything outside literals (in
 * particular, statement-separating semicolons) untouched and at the same
 * offset as the original — so a semicolon typed inside a string value is
 * never mistaken for a statement boundary.
 */
function maskStringLiterals(sql: string): string {
  let masked = '';
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      if (ch === "'" && sql[i + 1] === "'") {
        masked += 'xx';
        i++;
        continue;
      }
      if (ch === "'") {
        inString = false;
        masked += ' ';
        continue;
      }
      masked += 'x';
      continue;
    }
    if (ch === "'") {
      inString = true;
      masked += ' ';
      continue;
    }
    masked += ch;
  }
  return masked;
}

function splitStatements(sql: string): string[] {
  const masked = maskStringLiterals(sql);
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === ';') {
      parts.push(sql.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(sql.slice(start));
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Rejects anything but a single SELECT (optionally `WITH ... SELECT`)
 * statement, before any DB connection is opened. Returns the validated
 * statement text on success. This is a syntactic first gate, not the
 * enforcement mechanism — see the module doc comment.
 */
export function assertSingleReadOnlyStatement(sql: string): string {
  const trimmed = sql.trim();
  if (!trimmed) {
    throw new AdhocQueryValidationError('query is empty');
  }
  const statements = splitStatements(trimmed);
  if (statements.length !== 1) {
    throw new AdhocQueryValidationError(
      `expected exactly one statement, got ${statements.length} — ` +
        'ad hoc queries may not chain multiple statements',
    );
  }
  const statement = statements[0];
  if (!/^(select|with)\b/i.test(statement)) {
    throw new AdhocQueryValidationError(
      'only SELECT (or WITH ... SELECT) statements are allowed',
    );
  }
  return statement;
}

/** Opens the DB in driver-enforced read-only mode — see module doc comment. */
export function openReadOnlyDb(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

/**
 * Runs an already-validated statement against an already-open read-only
 * connection, capping rows read at `rowCap` regardless of the statement's
 * own LIMIT (or lack of one) — mirrors the row-cap precedent
 * `sessionEvents.query` needed for the same reason (see
 * packages/backend/src/mcp/tools/sessionEventsReadTools.ts).
 */
export function runReadOnlyQuery(
  db: Database.Database,
  statement: string,
  rowCap: number = ADHOC_QUERY_ROW_CAP,
): AdhocQueryResult {
  const stmt = db.prepare(statement);
  const rows: Record<string, unknown>[] = [];
  let truncated = false;
  for (const row of stmt.iterate()) {
    if (rows.length >= rowCap) {
      truncated = true;
      break;
    }
    rows.push(row as Record<string, unknown>);
  }
  return { rows, rowCount: rows.length, truncated };
}

/**
 * Validates, opens a read-only connection, runs the query, and closes the
 * connection — validation always happens before the connection is opened.
 */
export function executeAdhocQuery(
  sql: string,
  dbPath: string,
  rowCap: number = ADHOC_QUERY_ROW_CAP,
): AdhocQueryResult {
  const statement = assertSingleReadOnlyStatement(sql);
  const db = openReadOnlyDb(dbPath);
  try {
    return runReadOnlyQuery(db, statement, rowCap);
  } finally {
    db.close();
  }
}

/**
 * Formats the result as JSON, halving the row set until it fits within
 * `maxChars` if the full result would otherwise be oversized — the same
 * failure mode the doc comment on `sessionEventsReadTools.ts` records
 * (a naive `SELECT *` blew the tool-result size limit).
 */
export function formatAdhocQueryOutput(
  result: AdhocQueryResult,
  maxChars: number = ADHOC_QUERY_MAX_OUTPUT_CHARS,
): string {
  let rows = result.rows;
  let truncated = result.truncated;
  let json = JSON.stringify({ rows, rowCount: rows.length, truncated }, null, 2);
  while (json.length > maxChars && rows.length > 0) {
    rows = rows.slice(0, Math.ceil(rows.length / 2));
    truncated = true;
    json = JSON.stringify(
      { rows, rowCount: rows.length, truncated },
      null,
      2,
    );
  }
  return json;
}

function resolveConfiguredDbPath(): string {
  const configured = getOrchestratorConfig().db.path || './dashboard.db';
  return resolveDbPath(configured, getDataDir());
}

function main(): void {
  const sql = process.argv.slice(2).join(' ').trim();
  if (!sql) {
    // eslint-disable-next-line no-console
    console.error(
      'Usage: npx ts-node packages/backend/scripts/adhoc-query.ts "<SELECT ...>"',
    );
    process.exit(1);
    return;
  }
  try {
    const dbPath = resolveConfiguredDbPath();
    const result = executeAdhocQuery(sql, dbPath);
    // eslint-disable-next-line no-console
    console.log(formatAdhocQueryOutput(result));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[adhoc-query] ${(err as Error).message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
