/**
 * Regression test for the 2026-08-11 outage: db/queries.ts prepared 22
 * statements at module load, so any statement referencing a column added by
 * a migration in the same release threw during import — before
 * runMigrations had run — making the backend permanently un-bootable
 * against a database that release was supposed to upgrade (see
 * server.ts -> config/settings.ts -> db/queries.ts import chain).
 *
 * Every db.prepare() call in queries.ts must be deferred to first use
 * (`_stmtX ??= db.prepare(...)`) rather than executed at module evaluation
 * time, so importing the module never depends on the schema already being
 * up to date.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import path from 'path';

const QUERIES_SOURCE = readFileSync(
  path.join(__dirname, '../queries.ts'),
  'utf8',
);

describe('queries.ts prepares every statement lazily', () => {
  it('contains zero top-level `const stmtX = db.prepare(...)` declarations', () => {
    const offenders = QUERIES_SOURCE
      .split('\n')
      .filter((line) => /^const\s+\w*[Ss]tmt\w*\s*=\s*db\.prepare/.test(line));
    expect(offenders).toEqual([]);
  });

  it('importing the module graph against a completely bare (unmigrated) database does not throw', async () => {
    vi.resetModules();
    const bareDb = new Database(':memory:');
    bareDb.pragma('foreign_keys = ON');
    // Deliberately no CREATE TABLE / runMigrations at all — this is stricter
    // than "migrations not yet run" and proves import touches the db
    // connection only to hold a handle, never to prepare a statement.
    vi.doMock('../db.js', () => ({ db: bareDb }));

    await expect(import('../../config/settings.js')).resolves.toBeDefined();

    vi.doUnmock('../db.js');
    vi.resetModules();
  });
});

describe('lazily-prepared statements are cached, not re-prepared', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reuses the same Statement instance across repeated calls (stmtUpdateSessionStatus)', async () => {
    vi.resetModules();
    const { setupTestDb } = await import(
      '../../../test/helpers/setupTestDb.js'
    );
    const testDb = setupTestDb();
    vi.doMock('../db.js', () => ({ db: testDb }));

    const prepareSpy = vi.spyOn(testDb, 'prepare');
    const queries = await import('../queries.js');

    queries.insertSession({
      session_id: 'lazy-cache-session',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: 0,
    } as never);

    // Warm-up call: prepares (and caches) every statement updateSessionStatus
    // transitively depends on, including whatever recordEvent needs.
    queries.updateSessionStatus('lazy-cache-session', 'idle');

    prepareSpy.mockClear();
    queries.updateSessionStatus('lazy-cache-session', 'running');
    queries.updateSessionStatus('lazy-cache-session', 'idle');

    // recordEvent (audit/AuditLog.ts) re-prepares its own statements on every
    // call by design — out of scope here. Only the two statements
    // updateSessionStatus itself owns (the sessions SELECT and UPDATE) are
    // asserted: they must never reappear once the warm-up call cached them.
    const ownStatementCalls = prepareSpy.mock.calls.filter(([sql]) =>
      /SELECT \* FROM sessions WHERE session_id = @session_id|UPDATE sessions\s+SET status = @status/.test(
        sql as string,
      ),
    );
    expect(ownStatementCalls).toEqual([]);

    vi.doUnmock('../db.js');
    vi.resetModules();
  });
});
