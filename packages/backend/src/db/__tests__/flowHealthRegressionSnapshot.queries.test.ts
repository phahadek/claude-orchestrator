/**
 * Tests for getStandardSessionWallClockSample (db/queries.ts) — the query
 * FlowHealthRegressionSnapshotJob samples from. Covers the AC that
 * archived+killed+no-reason "bookkeeping artifact" kills started before the
 * fixed cutoff are excluded from the sample set and counted separately,
 * while the same row shape started after the cutoff is not excluded, and
 * in-flight sessions (ended_at IS NULL) never enter the sample set.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import { getStandardSessionWallClockSample } from '../queries.js';

const CUTOFF = 1_000_000;
const WINDOW_START = 0;
const WINDOW_END = 10_000_000;

function insertSession(overrides: {
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  archived?: 0 | 1;
  status?: string;
  terminalReason?: string | null;
}): void {
  db.prepare(
    `INSERT INTO sessions
       (session_id, status, session_type, started_at, ended_at, archived, terminal_completion_reason)
     VALUES (@session_id, @status, 'standard', @started_at, @ended_at, @archived, @terminal_completion_reason)`,
  ).run({
    session_id: overrides.sessionId,
    status: overrides.status ?? 'done',
    started_at: overrides.startedAt,
    ended_at: overrides.endedAt,
    archived: overrides.archived ?? 0,
    terminal_completion_reason: overrides.terminalReason ?? null,
  });
}

beforeEach(() => {
  db.exec('DELETE FROM sessions');
});

describe('getStandardSessionWallClockSample', () => {
  it('excludes in-flight sessions (ended_at IS NULL) from the sample set', () => {
    insertSession({
      sessionId: 's-inflight',
      startedAt: 500_000,
      endedAt: null,
    });
    insertSession({
      sessionId: 's-done',
      startedAt: 500_000,
      endedAt: 500_000 + 60_000,
    });

    const result = getStandardSessionWallClockSample(
      WINDOW_START,
      WINDOW_END,
      CUTOFF,
    );

    expect(result.durationsMs).toEqual([60_000]);
    expect(result.excludedArtifactCount).toBe(0);
  });

  it('excludes archived+killed+no-reason sessions started before the fixed cutoff, counting them separately', () => {
    insertSession({
      sessionId: 's-artifact',
      startedAt: CUTOFF - 1,
      endedAt: CUTOFF - 1 + 45_000,
      archived: 1,
      status: 'killed',
      terminalReason: null,
    });
    insertSession({
      sessionId: 's-normal',
      startedAt: CUTOFF - 1,
      endedAt: CUTOFF - 1 + 90_000,
    });

    const result = getStandardSessionWallClockSample(
      WINDOW_START,
      WINDOW_END,
      CUTOFF,
    );

    expect(result.durationsMs).toEqual([90_000]);
    expect(result.excludedArtifactCount).toBe(1);
  });

  it('does not exclude the same archived+killed+no-reason shape when started after the cutoff', () => {
    insertSession({
      sessionId: 's-post-cutoff-artifact',
      startedAt: CUTOFF + 1,
      endedAt: CUTOFF + 1 + 45_000,
      archived: 1,
      status: 'killed',
      terminalReason: null,
    });

    const result = getStandardSessionWallClockSample(
      WINDOW_START,
      WINDOW_END,
      CUTOFF,
    );

    expect(result.durationsMs).toEqual([45_000]);
    expect(result.excludedArtifactCount).toBe(0);
  });

  it('does not exclude an archived+killed session before the cutoff when it carries a terminal_completion_reason', () => {
    insertSession({
      sessionId: 's-attributed-kill',
      startedAt: CUTOFF - 1,
      endedAt: CUTOFF - 1 + 30_000,
      archived: 1,
      status: 'killed',
      terminalReason: 'operator_abort',
    });

    const result = getStandardSessionWallClockSample(
      WINDOW_START,
      WINDOW_END,
      CUTOFF,
    );

    expect(result.durationsMs).toEqual([30_000]);
    expect(result.excludedArtifactCount).toBe(0);
  });
});
