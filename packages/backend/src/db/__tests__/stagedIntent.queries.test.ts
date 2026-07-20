/**
 * Tests for the durable staged_intent store (db/queries.ts): the per-intent
 * lifecycle state machine, content-idempotent dedup/supersede, and the
 * per-group route-back counter that back routes/stagedIntents.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  insertStagedIntent,
  getStagedIntent,
  findActiveStagedIntentForTask,
  transitionStagedIntent,
  supersedeStagedIntent,
  incrementRouteBackCount,
  getStagedIntentGroup,
  IllegalStagedIntentTransitionError,
  hashIntentPayload,
} from '../queries.js';
import type { StagedIntentRow } from '../types.js';

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

function makeRow(overrides: Partial<StagedIntentRow> = {}): StagedIntentRow {
  const payload = overrides.payload ?? JSON.stringify({ taskId: 't-1' });
  return {
    id: 'intent-1',
    kind: 'task.setStatus',
    payload,
    payload_hash: hashIntentPayload(JSON.parse(payload)),
    task_id: 't-1',
    project_id: 'proj-1',
    session_id: null,
    group_id: 'group-1',
    state: 'staged',
    supersedes: null,
    annotation: null,
    decision_proposal: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe('staged_intent lifecycle transitions', () => {
  it('allows staged -> approved -> committed', () => {
    insertStagedIntent(makeRow());
    transitionStagedIntent('intent-1', 'approved');
    expect(getStagedIntent('intent-1')!.state).toBe('approved');
    transitionStagedIntent('intent-1', 'committed');
    expect(getStagedIntent('intent-1')!.state).toBe('committed');
  });

  it('allows approved -> staged (reversible before commit)', () => {
    insertStagedIntent(makeRow());
    transitionStagedIntent('intent-1', 'approved');
    transitionStagedIntent('intent-1', 'staged');
    expect(getStagedIntent('intent-1')!.state).toBe('staged');
  });

  it('allows staged -> rejected and staged -> superseded directly', () => {
    insertStagedIntent(makeRow());
    transitionStagedIntent('intent-1', 'rejected');
    expect(getStagedIntent('intent-1')!.state).toBe('rejected');

    insertStagedIntent(makeRow({ id: 'intent-2' }));
    transitionStagedIntent('intent-2', 'superseded');
    expect(getStagedIntent('intent-2')!.state).toBe('superseded');
  });

  it('rejects an illegal transition (e.g. rejected -> approved)', () => {
    insertStagedIntent(makeRow());
    transitionStagedIntent('intent-1', 'rejected');
    expect(() => transitionStagedIntent('intent-1', 'approved')).toThrow(
      IllegalStagedIntentTransitionError,
    );
  });

  it('treats committed as immutable — no outgoing transition is legal', () => {
    insertStagedIntent(makeRow());
    transitionStagedIntent('intent-1', 'committed');
    for (const to of [
      'staged',
      'approved',
      'rejected',
      'superseded',
    ] as const) {
      expect(() => transitionStagedIntent('intent-1', to)).toThrow(
        IllegalStagedIntentTransitionError,
      );
    }
  });
});

describe('content-idempotent dedup', () => {
  it('findActiveStagedIntentForTask only matches staged/approved rows, not committed/rejected', () => {
    insertStagedIntent(makeRow());
    expect(
      findActiveStagedIntentForTask('proj-1', 'task.setStatus', 't-1'),
    ).toBeDefined();

    transitionStagedIntent('intent-1', 'committed');
    expect(
      findActiveStagedIntentForTask('proj-1', 'task.setStatus', 't-1'),
    ).toBeUndefined();
  });
});

describe('supersede', () => {
  it('tombstones the prior intent and points the new one back at it', () => {
    insertStagedIntent(makeRow());
    transitionStagedIntent('intent-1', 'approved');

    const replacement = makeRow({
      id: 'intent-2',
      payload: JSON.stringify({ taskId: 't-1', status: 'Backlog' }),
    });
    const result = supersedeStagedIntent('intent-1', replacement);

    expect(result.supersedes).toBe('intent-1');
    expect(getStagedIntent('intent-1')!.state).toBe('superseded');
    expect(getStagedIntent('intent-2')!.state).toBe('staged');
  });

  it('is per-intent — superseding one intent leaves a sibling in the same group untouched', () => {
    insertStagedIntent(
      makeRow({ id: 'sibling', task_id: 't-2', kind: 'task.setDependsOn' }),
    );
    transitionStagedIntent('sibling', 'approved');

    insertStagedIntent(makeRow());
    transitionStagedIntent('intent-1', 'approved');

    supersedeStagedIntent(
      'intent-1',
      makeRow({
        id: 'intent-1-v2',
        payload: JSON.stringify({ taskId: 't-1', status: 'Done' }),
      }),
    );

    expect(getStagedIntent('sibling')!.state).toBe('approved');
  });
});

describe('per-group route_back_count', () => {
  it('escalates the group once the count reaches the cap (default 3)', () => {
    incrementRouteBackCount('group-x');
    incrementRouteBackCount('group-x');
    expect(getStagedIntentGroup('group-x')!.escalated).toBe(0);

    const third = incrementRouteBackCount('group-x');
    expect(third.route_back_count).toBe(3);
    expect(third.escalated).toBe(1);
    expect(getStagedIntentGroup('group-x')!.escalated).toBe(1);
  });

  it('tracks separate groups independently', () => {
    incrementRouteBackCount('group-a');
    incrementRouteBackCount('group-b');
    incrementRouteBackCount('group-b');

    expect(getStagedIntentGroup('group-a')!.route_back_count).toBe(1);
    expect(getStagedIntentGroup('group-b')!.route_back_count).toBe(2);
  });
});
