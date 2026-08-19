import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  extractStatements,
  buildDummyParams,
  findTableScans,
  planStatement,
  runCheck,
  assertValidAcceptedScans,
  baselineKey,
  isExcludedFile,
  buildSchemaDb,
  SRC_DIR,
} from '../check-query-plans.mjs';

function buildFixtureDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE wide (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE indexed (id INTEGER PRIMARY KEY, name TEXT);
    CREATE INDEX idx_indexed_name ON indexed(name);
  `);
  return db;
}

describe('extractStatements', () => {
  it('extracts a static SQL template literal with its line number', () => {
    const content = [
      'const a = 1;',
      'db.prepare(`',
      '  SELECT * FROM wide WHERE name = @name',
      '`);',
    ].join('\n');
    const { statements, dynamicSkips } = extractStatements(content);
    assert.equal(statements.length, 1);
    assert.equal(statements[0].line, 2);
    assert.match(statements[0].sql, /SELECT \* FROM wide/);
    assert.equal(dynamicSkips.length, 0);
  });

  it('skips a template literal containing interpolation as dynamic SQL', () => {
    const content = 'db.prepare(`SELECT * FROM ${table} WHERE id = ?`);';
    const { statements, dynamicSkips } = extractStatements(content);
    assert.equal(statements.length, 0);
    assert.equal(dynamicSkips.length, 1);
  });

  it('ignores template literals that are not SQL', () => {
    const content = 'const msg = `hello ${name}`;';
    const { statements, dynamicSkips } = extractStatements(content);
    assert.equal(statements.length, 0);
    assert.equal(dynamicSkips.length, 0);
  });
});

describe('buildDummyParams', () => {
  it('binds named @-placeholders to an object of 1s', () => {
    const params = buildDummyParams(
      'SELECT * FROM wide WHERE a = @a AND b = @b',
    );
    assert.deepEqual(params, { a: 1, b: 1 });
  });

  it('binds positional ? placeholders to an array of 1s', () => {
    const params = buildDummyParams('SELECT * FROM wide WHERE a = ? AND b = ?');
    assert.deepEqual(params, [1, 1]);
  });

  it('returns an empty array for a statement with no placeholders', () => {
    const params = buildDummyParams('SELECT * FROM wide');
    assert.deepEqual(params, []);
  });
});

describe('findTableScans', () => {
  it('flags a bare SCAN step as a table scan', () => {
    const scans = findTableScans([{ detail: 'SCAN wide' }]);
    assert.deepEqual(scans, ['SCAN wide']);
  });

  it('does not flag an index-assisted scan (SCAN ... USING INDEX)', () => {
    const scans = findTableScans([
      { detail: 'SCAN wide USING INDEX idx_wide_name' },
    ]);
    assert.deepEqual(scans, []);
  });

  it('does not flag a SEARCH step', () => {
    const scans = findTableScans([
      { detail: 'SEARCH indexed USING INDEX idx_indexed_name (name=?)' },
    ]);
    assert.deepEqual(scans, []);
  });
});

describe('planStatement', () => {
  const db = buildFixtureDb();
  after(() => db.close());

  it('reports a table scan on an unindexed column', () => {
    const result = planStatement(db, 'SELECT * FROM wide WHERE name = @name');
    assert.deepEqual(result.scans, ['SCAN wide']);
  });

  it('reports no scans for an index-assisted lookup', () => {
    const result = planStatement(
      db,
      'SELECT * FROM indexed WHERE name = @name',
    );
    assert.deepEqual(result.scans, []);
  });

  it('reports unplannable for a statement referencing a nonexistent column', () => {
    const result = planStatement(
      db,
      'SELECT * FROM wide WHERE nonexistent_column = @x',
    );
    assert.equal(result.unplannable, true);
  });
});

describe('assertValidAcceptedScans', () => {
  it('passes when every entry carries a reason', () => {
    assert.doesNotThrow(() =>
      assertValidAcceptedScans(
        new Map([['file.ts:1', { reason: 'small bounded table' }]]),
      ),
    );
  });

  it('throws when an entry is missing a reason', () => {
    assert.throws(() => assertValidAcceptedScans(new Map([['file.ts:1', {}]])));
  });

  it('throws when an entry has an empty reason', () => {
    assert.throws(() =>
      assertValidAcceptedScans(new Map([['file.ts:1', { reason: '  ' }]])),
    );
  });
});

describe('runCheck', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'check-query-plans-test-'));
    writeFileSync(
      join(tmpDir, 'queries.ts'),
      [
        'export function getWide() {',
        '  return db.prepare(`SELECT * FROM wide WHERE name = @name`).all({ name: 1 });',
        '}',
        '',
        'export function getIndexed() {',
        '  return db.prepare(`SELECT * FROM indexed WHERE name = @name`).all({ name: 1 });',
        '}',
        '',
        'export function getDynamic() {',
        '  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).all(1);',
        '}',
        '',
        'export function getUnplannable() {',
        '  return db.prepare(`SELECT * FROM wide WHERE nonexistent_column = @x`).all({ x: 1 });',
        '}',
      ].join('\n'),
    );
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fails on a new scan against a table with no covering index', () => {
    const db = buildFixtureDb();
    const result = runCheck(
      db,
      [join(tmpDir, 'queries.ts')],
      new Map(),
      tmpDir,
    );
    db.close();
    assert.equal(result.newScans.length, 1);
    assert.equal(result.newScans[0].key, `${baselineKey('queries.ts', 2)}`);
  });

  it('passes a scan that is already in the accepted set', () => {
    const db = buildFixtureDb();
    const accepted = new Map([
      [
        baselineKey('queries.ts', 2),
        { reason: 'baseline debt, tracked separately' },
      ],
    ]);
    const result = runCheck(db, [join(tmpDir, 'queries.ts')], accepted, tmpDir);
    db.close();
    assert.equal(result.newScans.length, 0);
    assert.equal(result.acceptedHits.has(baselineKey('queries.ts', 2)), true);
  });

  it('does not flag an index-assisted scan as a new table scan', () => {
    const db = buildFixtureDb();
    const result = runCheck(
      db,
      [join(tmpDir, 'queries.ts')],
      new Map(),
      tmpDir,
    );
    db.close();
    const flaggedIndexed = result.newScans.some(
      (s) => s.key === baselineKey('queries.ts', 6),
    );
    assert.equal(flaggedIndexed, false);
  });

  it('surfaces a non-zero skip count for dynamic and unplannable statements', () => {
    const db = buildFixtureDb();
    const result = runCheck(
      db,
      [join(tmpDir, 'queries.ts')],
      new Map(),
      tmpDir,
    );
    db.close();
    assert.equal(result.dynamicSkipCount, 1);
    assert.equal(result.unplannableSkipCount, 1);
  });

  it('excludes a scan in a migration file via the file allowlist', () => {
    // db/schema.ts is the production FILE_ALLOWLIST entry for migration SQL —
    // isExcludedFile() is what walk() uses to leave it out of the scanned
    // file set entirely, so any scan inside it can never reach runCheck().
    assert.equal(isExcludedFile(join(SRC_DIR, 'db', 'schema.ts')), true);
  });

  it('excludes files under a __tests__ directory and *.test.ts files', () => {
    assert.equal(
      isExcludedFile(join(tmpDir, '__tests__', 'queries.test.ts')),
      true,
    );
    assert.equal(isExcludedFile(join(tmpDir, 'queries.test.ts')), true);
    assert.equal(isExcludedFile(join(tmpDir, 'queries.ts')), false);
  });

  it('removing an index from the schema makes the check fail on that statement, restoring it makes it pass again', () => {
    const withIndex = buildFixtureDb();
    const passResult = runCheck(
      withIndex,
      [join(tmpDir, 'queries.ts')],
      new Map(),
      tmpDir,
    );
    withIndex.close();
    assert.equal(
      passResult.newScans.some((s) => s.key === baselineKey('queries.ts', 6)),
      false,
    );

    const withoutIndex = new Database(':memory:');
    withoutIndex.exec(`
      CREATE TABLE wide (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE indexed (id INTEGER PRIMARY KEY, name TEXT);
    `);
    const failResult = runCheck(
      withoutIndex,
      [join(tmpDir, 'queries.ts')],
      new Map(),
      tmpDir,
    );
    withoutIndex.close();
    const regressed = failResult.newScans.find(
      (s) => s.key === baselineKey('queries.ts', 6),
    );
    assert.ok(
      regressed,
      'expected getIndexed() statement to be flagged once its index is gone',
    );
    assert.deepEqual(regressed.scans, ['SCAN indexed']);
  });
});

// Regression coverage for the F2 breadth-of-trees masking signal
// (computeTestFailureBreadthFlag, db/queries.ts) added alongside the
// existing flip-rate guard: it joins test_run_results to test_request_runs
// to count distinct content_hash values a test failed under. Per the Query-
// plan constraint that motivated this CI guard, that join must stay
// index-assisted (idx_test_run_results_test_id_created_at + the
// test_request_runs primary key) rather than silently degrading into a full
// table scan as the schema evolves — planned here against the real deployed
// schema (via buildSchemaDb, the same real migration chain
// scripts/check-query-plans.mjs's own `main()` plans every statement
// against), not a hand-rolled fixture.
describe('computeTestFailureBreadthFlag query plan (regression)', () => {
  it('the breadth-of-trees join stays index-assisted against the real deployed schema', () => {
    const content = readFileSync(join(SRC_DIR, 'db', 'queries.ts'), 'utf-8');
    const { statements } = extractStatements(content);
    const target = statements.find((s) =>
      s.sql.includes('COUNT(DISTINCT r.content_hash)'),
    );
    assert.ok(
      target,
      'expected to find the breadth-of-trees query in db/queries.ts — did it move or get rewritten as dynamic SQL?',
    );

    const db = buildSchemaDb();
    const result = planStatement(db, target.sql);
    db.close();

    assert.deepEqual(
      result.scans,
      [],
      'breadth-of-trees query regressed into a full table scan — either restore ' +
        'index-assisted access or add a deliberate, reasoned ACCEPTED_SCANS entry',
    );
  });
});
