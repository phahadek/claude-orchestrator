/**
 * Tests for the Tier-3 classifier chronic-error-rate signal
 * (db/queries.ts's getTier3ClassifierErrorRates): per (project, kind), the
 * rolling-window rate of readiness_override / tier3_semantic_advisory
 * classify calls resolving 'errored' or 'usage_limited' — see
 * classifyReadyProposal, tasks/deferralClassifier.ts, for the event this
 * reads.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import { getTier3ClassifierErrorRates } from '../queries.js';
import { recordEvent } from '../../audit/AuditLog.js';

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  db.prepare('DELETE FROM audit_log').run();
});

function recordClassify(
  projectId: string,
  status: 'clean' | 'flagged' | 'errored' | 'usage_limited',
  ts: number,
): void {
  recordEvent({
    event_type: 'readiness_override',
    actor_type: 'system',
    actor_id: null,
    project_id: projectId,
    task_id: 'task-1',
    payload: {
      reason: 'tier3_semantic_advisory',
      status,
      confidence: null,
      findings: [],
      model: 'test-model',
      groupId: 'group-1',
    },
  });
  db.prepare('UPDATE audit_log SET ts = ? WHERE id = last_insert_rowid()').run(
    ts,
  );
}

describe('getTier3ClassifierErrorRates', () => {
  it('returns a null rate for both kinds when there is no data (zero-total)', () => {
    const result = getTier3ClassifierErrorRates('proj-1', 7 * 24 * 60 * 60, NOW);
    expect(result).toEqual([
      {
        project: 'proj-1',
        kind: 'errored',
        windowSeconds: 7 * 24 * 60 * 60,
        total: 0,
        matched: 0,
        rate: null,
      },
      {
        project: 'proj-1',
        kind: 'usage_limited',
        windowSeconds: 7 * 24 * 60 * 60,
        total: 0,
        matched: 0,
        rate: null,
      },
    ]);
  });

  it('splits errored and usage_limited into independent rates over the same total', () => {
    recordClassify('proj-1', 'errored', NOW);
    recordClassify('proj-1', 'errored', NOW);
    recordClassify('proj-1', 'errored', NOW);
    recordClassify('proj-1', 'usage_limited', NOW);
    recordClassify('proj-1', 'clean', NOW);
    recordClassify('proj-1', 'flagged', NOW);

    const result = getTier3ClassifierErrorRates('proj-1', 7 * 24 * 60 * 60, NOW);
    const errored = result.find((r) => r.kind === 'errored');
    const usageLimited = result.find((r) => r.kind === 'usage_limited');

    expect(errored).toEqual({
      project: 'proj-1',
      kind: 'errored',
      windowSeconds: 7 * 24 * 60 * 60,
      total: 6,
      matched: 3,
      rate: 0.5,
    });
    expect(usageLimited).toEqual({
      project: 'proj-1',
      kind: 'usage_limited',
      windowSeconds: 7 * 24 * 60 * 60,
      total: 6,
      matched: 1,
      rate: 1 / 6,
    });
  });

  it('includes an event exactly at the window lower boundary', () => {
    const windowSeconds = 7 * 24 * 60 * 60;
    recordClassify('proj-1', 'errored', NOW - windowSeconds * 1000);

    const result = getTier3ClassifierErrorRates('proj-1', windowSeconds, NOW);
    expect(result.find((r) => r.kind === 'errored')).toMatchObject({
      total: 1,
      matched: 1,
      rate: 1,
    });
  });

  it('excludes an event one millisecond before the window lower boundary', () => {
    const windowSeconds = 7 * 24 * 60 * 60;
    recordClassify('proj-1', 'errored', NOW - windowSeconds * 1000 - 1);

    const result = getTier3ClassifierErrorRates('proj-1', windowSeconds, NOW);
    expect(result.find((r) => r.kind === 'errored')).toMatchObject({
      total: 0,
      matched: 0,
      rate: null,
    });
  });

  it('excludes events outside the rolling window', () => {
    recordClassify('proj-1', 'errored', NOW - 30 * DAY_MS);
    recordClassify('proj-1', 'errored', NOW - 1 * DAY_MS);

    const result = getTier3ClassifierErrorRates('proj-1', 7 * 24 * 60 * 60, NOW);
    expect(result.find((r) => r.kind === 'errored')).toMatchObject({
      total: 1,
      matched: 1,
      rate: 1,
    });
  });

  it('scopes to the given project only', () => {
    recordClassify('proj-1', 'errored', NOW);
    recordClassify('proj-2', 'errored', NOW);
    recordClassify('proj-2', 'errored', NOW);

    const result = getTier3ClassifierErrorRates('proj-1', 7 * 24 * 60 * 60, NOW);
    expect(result.find((r) => r.kind === 'errored')).toMatchObject({
      total: 1,
      matched: 1,
    });
  });

  it('ignores readiness_override events from other reasons', () => {
    recordEvent({
      event_type: 'readiness_override',
      actor_type: 'human',
      actor_id: null,
      project_id: 'proj-1',
      task_id: 'task-1',
      payload: { reason: 'operator_override' },
    });

    const result = getTier3ClassifierErrorRates('proj-1', 7 * 24 * 60 * 60, NOW);
    expect(result.every((r) => r.total === 0)).toBe(true);
  });
});
