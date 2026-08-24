import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { insertRows } from '../../test/helpers/seedRows.js';
import { parsePauseReasonSet } from '../db/pauseReason.js';

// Reproduces the pre-this-migration pull_requests shape (no reconcile_exhausted
// column) and seeds rows the way a live production database would already
// hold them — some escalated under the old stalled_reconcile_cap model
// (bare-string, single-struct, and concurrent-set-array storage shapes),
// some not — then runs the real runMigrations() so the guarded backfill is
// exercised against a populated database, not just a fresh empty one. See
// schema.migration.populatedDatabase.test.ts for why this pattern exists.

function preMigrationPullRequestsShape(db: Database.Database): void {
  db.exec(`
    CREATE TABLE pull_requests (
      id                           INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number                    INTEGER NOT NULL,
      pr_url                       TEXT    NOT NULL UNIQUE,
      task_id                      TEXT,
      session_id                   TEXT,
      repo                         TEXT    NOT NULL,
      title                        TEXT,
      body                         TEXT,
      head_branch                  TEXT,
      base_branch                  TEXT,
      state                        TEXT    NOT NULL DEFAULT 'open',
      draft                        INTEGER NOT NULL DEFAULT 0,
      review_result                TEXT,
      review_at                    TEXT,
      created_at                   TEXT    NOT NULL,
      updated_at                   TEXT    NOT NULL,
      synced_at                    TEXT    NOT NULL,
      review_session_id            TEXT,
      review_iteration             INTEGER NOT NULL DEFAULT 0,
      head_sha                     TEXT,
      last_reviewed_sha            TEXT,
      node_id                      TEXT,
      mergeable                    INTEGER,
      merge_state                  TEXT,
      merge_state_checked_at       TEXT,
      pending_push                 INTEGER NOT NULL DEFAULT 0,
      pause_reason                 TEXT,
      failing_checks               TEXT,
      ci_remediation_attempted_sha TEXT,
      pause_reason_set_at          INTEGER,
      conflict_nudge_sha           TEXT,
      session_initiated_close_at   INTEGER
    );
  `);
}

function getRow(db: Database.Database, prNumber: number) {
  return db
    .prepare(`SELECT * FROM pull_requests WHERE pr_number = ?`)
    .get(prNumber) as {
    pause_reason: string | null;
    reconcile_exhausted: number;
    reconcile_exhausted_set_at: number | null;
  };
}

describe('reconcile_exhausted backfill — populated database', () => {
  it('sets reconcile_exhausted=1 and strips the entry for a legacy bare-string escalation', () => {
    const db = new Database(':memory:');
    preMigrationPullRequestsShape(db);
    insertRows(db, 'pull_requests', [
      {
        pr_number: 1001,
        pr_url: 'https://github.com/owner/repo/pull/1001',
        repo: 'owner/repo',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        synced_at: '2026-01-01T00:00:00Z',
        pause_reason: 'stalled_reconcile_cap',
        pause_reason_set_at: 1_700_000_000_000,
      },
    ]);

    runMigrations(db);

    const row = getRow(db, 1001);
    expect(row.reconcile_exhausted).toBe(1);
    expect(row.reconcile_exhausted_set_at).toBe(1_700_000_000_000);
    // The retired reason no longer has anywhere valid to live — bare-string
    // storage collapses to null once its sole entry is stripped.
    expect(row.pause_reason).toBeNull();
  });

  it('strips only the stalled_reconcile_cap entry from a concurrent-set array, preserving a live sibling cause', () => {
    const db = new Database(':memory:');
    preMigrationPullRequestsShape(db);
    const concurrentSet = JSON.stringify([
      {
        reason: 'ci_failing',
        source: 'ci',
        severity: 'needs_attention',
        retry_strategy: 'automatic',
        blocks_merge: true,
      },
      {
        reason: 'stalled_reconcile_cap',
        source: 'review',
        severity: 'needs_attention',
        retry_strategy: 'manual_action',
        blocks_merge: true,
      },
    ]);
    insertRows(db, 'pull_requests', [
      {
        pr_number: 1002,
        pr_url: 'https://github.com/owner/repo/pull/1002',
        repo: 'owner/repo',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        synced_at: '2026-01-01T00:00:00Z',
        pause_reason: concurrentSet,
        pause_reason_set_at: 1_700_000_000_000,
      },
    ]);

    runMigrations(db);

    const row = getRow(db, 1002);
    expect(row.reconcile_exhausted).toBe(1);
    const remaining = parsePauseReasonSet(row.pause_reason);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].reason).toBe('ci_failing');
  });

  it('leaves a PR with no stalled_reconcile_cap entry untouched (reconcile_exhausted stays 0)', () => {
    const db = new Database(':memory:');
    preMigrationPullRequestsShape(db);
    insertRows(db, 'pull_requests', [
      {
        pr_number: 1003,
        pr_url: 'https://github.com/owner/repo/pull/1003',
        repo: 'owner/repo',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        synced_at: '2026-01-01T00:00:00Z',
        pause_reason: 'ci_failing',
        pause_reason_set_at: 1_700_000_000_000,
      },
    ]);

    runMigrations(db);

    const row = getRow(db, 1003);
    expect(row.reconcile_exhausted).toBe(0);
    expect(row.pause_reason).toBe('ci_failing');
  });

  it('is idempotent — running migrations twice does not re-toggle or duplicate the backfill', () => {
    const db = new Database(':memory:');
    preMigrationPullRequestsShape(db);
    insertRows(db, 'pull_requests', [
      {
        pr_number: 1004,
        pr_url: 'https://github.com/owner/repo/pull/1004',
        repo: 'owner/repo',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        synced_at: '2026-01-01T00:00:00Z',
        pause_reason: 'stalled_reconcile_cap',
        pause_reason_set_at: 1_700_000_000_000,
      },
    ]);

    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();

    const row = getRow(db, 1004);
    expect(row.reconcile_exhausted).toBe(1);
    expect(row.pause_reason).toBeNull();
  });
});
