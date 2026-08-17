import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  assertSingleReadOnlyStatement,
  AdhocQueryValidationError,
  openReadOnlyDb,
  runReadOnlyQuery,
  executeAdhocQuery,
  formatAdhocQueryOutput,
  ADHOC_QUERY_ROW_CAP,
} from '../../scripts/adhoc-query';

describe('adhoc-query — statement validation', () => {
  it('accepts a single SELECT statement', () => {
    expect(assertSingleReadOnlyStatement('SELECT id FROM sessions')).toBe(
      'SELECT id FROM sessions',
    );
  });

  it('accepts a single WITH ... SELECT statement', () => {
    const sql = 'WITH x AS (SELECT 1) SELECT * FROM x';
    expect(assertSingleReadOnlyStatement(sql)).toBe(sql);
  });

  it('rejects a non-SELECT statement', () => {
    expect(() =>
      assertSingleReadOnlyStatement("DELETE FROM sessions WHERE id = 'x'"),
    ).toThrow(AdhocQueryValidationError);
  });

  it('rejects a multi-statement input chaining a SELECT with a write', () => {
    expect(() =>
      assertSingleReadOnlyStatement(
        "SELECT * FROM sessions; DELETE FROM sessions WHERE id = 'x';",
      ),
    ).toThrow(/exactly one statement/);
  });

  it('does not mistake a semicolon inside a string literal for a statement boundary', () => {
    const sql = "SELECT * FROM sessions WHERE task_id = 'a;b'";
    expect(assertSingleReadOnlyStatement(sql)).toBe(sql);
  });

  it('rejects an empty query', () => {
    expect(() => assertSingleReadOnlyStatement('   ')).toThrow(
      AdhocQueryValidationError,
    );
  });
});

describe('adhoc-query — read-only enforcement and execution', () => {
  let dbFile: string;

  afterEach(() => {
    if (dbFile && fs.existsSync(dbFile)) fs.rmSync(dbFile);
  });

  let fixtureCounter = 0;

  function makeFixtureDb(rowCount: number): string {
    fixtureCounter++;
    const file = path.join(
      os.tmpdir(),
      `adhoc-query-test-${process.pid}-${fixtureCounter}.sqlite`,
    );
    if (fs.existsSync(file)) fs.rmSync(file);
    const setup = new Database(file);
    setup.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
    const insert = setup.prepare('INSERT INTO items (name) VALUES (?)');
    const insertMany = setup.transaction((n: number) => {
      for (let i = 0; i < n; i++) insert.run(`item-${i}`);
    });
    insertMany(rowCount);
    setup.close();
    return file;
  }

  it('rejects a multi-statement input via executeAdhocQuery before opening a connection', () => {
    // A nonexistent DB path proves the connection was never opened: if
    // executeAdhocQuery opened the connection before validating, this would
    // fail with a "file does not exist" driver error instead of a
    // validation error.
    expect(() =>
      executeAdhocQuery(
        'SELECT 1; DROP TABLE sessions;',
        '/nonexistent/path/does-not-exist.sqlite',
      ),
    ).toThrow(AdhocQueryValidationError);
  });

  it('opens the connection read-only and fails a write attempt at the driver level', () => {
    dbFile = makeFixtureDb(1);
    const db = openReadOnlyDb(dbFile);
    try {
      expect(() =>
        db.prepare("INSERT INTO items (name) VALUES ('nope')").run(),
      ).toThrow(/readonly/i);
    } finally {
      db.close();
    }
  });

  it('runs a valid SELECT end to end via executeAdhocQuery', () => {
    dbFile = makeFixtureDb(3);
    const result = executeAdhocQuery('SELECT id, name FROM items', dbFile);
    expect(result.rowCount).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.rows).toHaveLength(3);
  });

  it('caps and marks truncated output for a query that would otherwise return an oversized result', () => {
    dbFile = makeFixtureDb(ADHOC_QUERY_ROW_CAP + 50);
    const db = openReadOnlyDb(dbFile);
    try {
      const result = runReadOnlyQuery(db, 'SELECT id, name FROM items');
      expect(result.rowCount).toBe(ADHOC_QUERY_ROW_CAP);
      expect(result.truncated).toBe(true);

      const json = formatAdhocQueryOutput(result, 500);
      const parsed = JSON.parse(json);
      expect(parsed.truncated).toBe(true);
      expect(parsed.rows.length).toBeLessThan(ADHOC_QUERY_ROW_CAP);
      expect(json.length).toBeLessThanOrEqual(500 * 4);
    } finally {
      db.close();
    }
  });
});
