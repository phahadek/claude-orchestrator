/**
 * getLatestTestRequestRunForSession() intentionally prefers a running/queued
 * row over the latest finished one (status-display precedence, see its doc
 * comment). getLatestFinishedTestRequestRunForSession() is the fallback
 * callers like PRReviewService must use so a finished run's evidence isn't
 * silently dropped behind a newer in-flight row.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  insertTestRequestRun,
  completeTestRequestRun,
  getLatestTestRequestRunForSession,
  getLatestFinishedTestRequestRunForSession,
  getAuthoritativeTestRunForPr,
  listTestRequestRunsForPrSession,
} from '../queries.js';

const PROJECT_ID = 'proj-1';
const SESSION_ID = 'session-1';
const WORKTREE_PATH = '/srv/worktrees/session-1';

beforeEach(() => {
  db.prepare('DELETE FROM test_request_runs').run();
});

describe('getLatestFinishedTestRequestRunForSession', () => {
  it('returns the finished run even when a newer running run exists for the session', () => {
    insertTestRequestRun(
      'run-finished',
      PROJECT_ID,
      'hash-1',
      SESSION_ID,
      1000,
    );
    completeTestRequestRun(
      'run-finished',
      'passed',
      'ok',
      null,
      JSON.stringify({
        suites: [{ name: 'npm test' }],
        totals: { passed: 5, failed: 0, skipped: 0, errors: 0 },
      }),
    );

    insertTestRequestRun(
      'run-running',
      PROJECT_ID,
      'hash-2',
      SESSION_ID,
      2000,
      null,
      undefined,
      undefined,
      'running',
    );

    // The status-display lens still prefers the in-flight row.
    const latest = getLatestTestRequestRunForSession(PROJECT_ID, SESSION_ID);
    expect(latest?.id).toBe('run-running');
    expect(latest?.state).toBe('running');

    // The finished-evidence lens must still expose the finished run.
    const finished = getLatestFinishedTestRequestRunForSession(
      PROJECT_ID,
      SESSION_ID,
    );
    expect(finished?.id).toBe('run-finished');
    expect(finished?.state).toBe('passed');
  });

  it('returns undefined when no finished run exists for the session', () => {
    insertTestRequestRun(
      'run-running-only',
      PROJECT_ID,
      'hash-1',
      SESSION_ID,
      1000,
      null,
      undefined,
      undefined,
      'running',
    );

    const finished = getLatestFinishedTestRequestRunForSession(
      PROJECT_ID,
      SESSION_ID,
    );
    expect(finished).toBeUndefined();
  });

  it('skips a withdrawn (superseded) run and returns the earlier passed run', () => {
    insertTestRequestRun('run-passed', PROJECT_ID, 'hash-1', SESSION_ID, 1000);
    completeTestRequestRun('run-passed', 'passed', 'ok');

    insertTestRequestRun(
      'run-superseded',
      PROJECT_ID,
      'hash-2',
      SESSION_ID,
      2000,
    );
    completeTestRequestRun('run-superseded', 'failed', '', 'superseded');

    const finished = getLatestFinishedTestRequestRunForSession(
      PROJECT_ID,
      SESSION_ID,
    );
    expect(finished?.id).toBe('run-passed');
  });

  it('returns undefined when the only finished run is superseded', () => {
    insertTestRequestRun(
      'run-superseded-only',
      PROJECT_ID,
      'hash-1',
      SESSION_ID,
      1000,
    );
    completeTestRequestRun('run-superseded-only', 'failed', '', 'superseded');

    const finished = getLatestFinishedTestRequestRunForSession(
      PROJECT_ID,
      SESSION_ID,
    );
    expect(finished).toBeUndefined();
  });

  it('still returns a genuinely failed run even when it is newer than a passed run', () => {
    insertTestRequestRun(
      'run-passed-2',
      PROJECT_ID,
      'hash-1',
      SESSION_ID,
      1000,
    );
    completeTestRequestRun('run-passed-2', 'passed', 'ok');

    insertTestRequestRun(
      'run-failed-generic',
      PROJECT_ID,
      'hash-2',
      SESSION_ID,
      2000,
    );
    completeTestRequestRun('run-failed-generic', 'failed', '', 'generic');

    const finished = getLatestFinishedTestRequestRunForSession(
      PROJECT_ID,
      SESSION_ID,
    );
    expect(finished?.id).toBe('run-failed-generic');
  });
});

describe('getAuthoritativeTestRunForPr', () => {
  it('prefers a pr_pipeline full/passed run over a session-attributed scoped/failed run in the same worktree', () => {
    insertTestRequestRun(
      'run-scoped-failed',
      PROJECT_ID,
      'hash-1',
      SESSION_ID,
      1000,
      null,
      undefined,
      undefined,
      'running',
      'scoped',
      null,
      WORKTREE_PATH,
    );
    completeTestRequestRun('run-scoped-failed', 'failed', '', 'generic');

    insertTestRequestRun(
      'run-pr-pipeline-full',
      PROJECT_ID,
      'hash-1',
      null,
      2000,
      null,
      'pr_pipeline',
      undefined,
      'running',
      'full',
      null,
      WORKTREE_PATH,
    );
    completeTestRequestRun('run-pr-pipeline-full', 'passed', 'ok');

    const authoritative = getAuthoritativeTestRunForPr(
      PROJECT_ID,
      SESSION_ID,
      WORKTREE_PATH,
    );
    expect(authoritative?.id).toBe('run-pr-pipeline-full');
    expect(authoritative?.run_kind).toBe('full');
    expect(authoritative?.session_id).toBeNull();
  });

  it('falls back to the session own newest finished run when no full run exists', () => {
    insertTestRequestRun(
      'run-scoped-passed',
      PROJECT_ID,
      'hash-1',
      SESSION_ID,
      1000,
      null,
      undefined,
      undefined,
      'running',
      'scoped',
      null,
      WORKTREE_PATH,
    );
    completeTestRequestRun('run-scoped-passed', 'passed', 'ok');

    const authoritative = getAuthoritativeTestRunForPr(
      PROJECT_ID,
      SESSION_ID,
      WORKTREE_PATH,
    );
    expect(authoritative?.id).toBe('run-scoped-passed');
  });

  it('never selects a running/queued or superseded full run for the worktree', () => {
    insertTestRequestRun(
      'run-full-running',
      PROJECT_ID,
      'hash-1',
      null,
      1000,
      null,
      'pr_pipeline',
      undefined,
      'running',
      'full',
      null,
      WORKTREE_PATH,
    );

    insertTestRequestRun(
      'run-full-superseded',
      PROJECT_ID,
      'hash-1',
      null,
      2000,
      null,
      'pr_pipeline',
      undefined,
      'running',
      'full',
      null,
      WORKTREE_PATH,
    );
    completeTestRequestRun('run-full-superseded', 'failed', '', 'superseded');

    insertTestRequestRun(
      'run-scoped-own',
      PROJECT_ID,
      'hash-1',
      SESSION_ID,
      500,
      null,
      undefined,
      undefined,
      'running',
      'scoped',
      null,
      WORKTREE_PATH,
    );
    completeTestRequestRun('run-scoped-own', 'passed', 'ok');

    const authoritative = getAuthoritativeTestRunForPr(
      PROJECT_ID,
      SESSION_ID,
      WORKTREE_PATH,
    );
    expect(authoritative?.id).toBe('run-scoped-own');
  });

  it('never matches the session_id IS NULL arm when the run has a NULL worktree_path, for any session', () => {
    insertTestRequestRun(
      'run-full-no-worktree',
      PROJECT_ID,
      'hash-1',
      null,
      1000,
      null,
      'pr_pipeline',
      undefined,
      'running',
      'full',
      null,
      null,
    );
    completeTestRequestRun('run-full-no-worktree', 'passed', 'ok');

    const authoritative = getAuthoritativeTestRunForPr(
      PROJECT_ID,
      SESSION_ID,
      WORKTREE_PATH,
    );
    expect(authoritative?.id).not.toBe('run-full-no-worktree');
    expect(authoritative).toBeUndefined();
  });

  it('never matches when the caller worktree_path is null, even if a full run shares that worktree', () => {
    insertTestRequestRun(
      'run-full-shared-null',
      PROJECT_ID,
      'hash-1',
      null,
      1000,
      null,
      'pr_pipeline',
      undefined,
      'running',
      'full',
      null,
      null,
    );
    completeTestRequestRun('run-full-shared-null', 'passed', 'ok');

    const authoritative = getAuthoritativeTestRunForPr(
      PROJECT_ID,
      SESSION_ID,
      null,
    );
    expect(authoritative).toBeUndefined();
  });
});

describe('listTestRequestRunsForPrSession', () => {
  it('returns pr_pipeline rows for the session worktree alongside the session own rows, newest first', () => {
    insertTestRequestRun(
      'run-own',
      PROJECT_ID,
      'hash-1',
      SESSION_ID,
      1000,
      null,
      undefined,
      undefined,
      'running',
      'scoped',
      null,
      WORKTREE_PATH,
    );
    completeTestRequestRun('run-own', 'failed', '', 'generic');

    insertTestRequestRun(
      'run-pipeline',
      PROJECT_ID,
      'hash-1',
      null,
      2000,
      null,
      'pr_pipeline',
      undefined,
      'running',
      'full',
      null,
      WORKTREE_PATH,
    );
    completeTestRequestRun('run-pipeline', 'passed', 'ok');

    insertTestRequestRun(
      'run-other-worktree',
      PROJECT_ID,
      'hash-1',
      null,
      3000,
      null,
      'pr_pipeline',
      undefined,
      'running',
      'full',
      null,
      '/some/other/worktree',
    );
    completeTestRequestRun('run-other-worktree', 'passed', 'ok');

    const rows = listTestRequestRunsForPrSession(
      PROJECT_ID,
      SESSION_ID,
      WORKTREE_PATH,
    );
    expect(rows.map((r) => r.id)).toEqual(['run-pipeline', 'run-own']);
  });
});
