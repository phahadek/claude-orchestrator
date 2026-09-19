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
} from '../queries.js';

const PROJECT_ID = 'proj-1';
const SESSION_ID = 'session-1';

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
    insertTestRequestRun(
      'run-passed',
      PROJECT_ID,
      'hash-1',
      SESSION_ID,
      1000,
    );
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
