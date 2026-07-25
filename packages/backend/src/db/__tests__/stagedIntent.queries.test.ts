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
  hasActiveCapabilityRequestForSession,
  IllegalStagedIntentTransitionError,
  hashIntentPayload,
  expireStagedIntentsForSession,
  sweepStagedIntentsForTerminalSessions,
  insertSession,
} from '../queries.js';
import type { StagedIntentRow } from '../types.js';

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM sessions').run();
});

function seedSession(
  sessionId: string,
  status: string,
): void {
  insertSession({
    session_id: sessionId,
    task_id: `task:${sessionId}`,
    task_url: null,
    project_context_url: null,
    status,
    started_at: 0,
    session_type: 'standard',
    task_name: null,
    metadata: null,
    review_result: null,
    pause_reason: null,
    last_error_detail: null,
    events_pruned_at: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    compaction_count: 0,
    context_occupancy_tokens: 0,
  } as never);
}

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
    groom_proposal: null,
    advisory: null,
    disposition_reason: null,
    answer: null,
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

describe('hasActiveCapabilityRequestForSession', () => {
  it('is false when the session has staged no capability request', () => {
    expect(hasActiveCapabilityRequestForSession('sess-1')).toBe(false);
  });

  it('is true for a staged, unresolved session.requestCapability intent', () => {
    insertStagedIntent(
      makeRow({
        id: 'cap-1',
        kind: 'session.requestCapability',
        session_id: 'sess-1',
        payload: JSON.stringify({
          capability: 'Bash(sqlite3 dashboard.db:*)',
          plan: 'read the operational record',
          evidence: 'gate item needs an audited DB read',
        }),
      }),
    );
    expect(hasActiveCapabilityRequestForSession('sess-1')).toBe(true);
  });

  it('is false once the request has been committed (resolved), not just staged/approved', () => {
    insertStagedIntent(
      makeRow({
        id: 'cap-2',
        kind: 'session.requestCapability',
        session_id: 'sess-2',
        payload: JSON.stringify({
          capability: 'Bash(sqlite3 dashboard.db:*)',
          plan: 'p',
          evidence: 'e',
        }),
      }),
    );
    transitionStagedIntent('cap-2', 'approved');
    transitionStagedIntent('cap-2', 'committed');
    expect(hasActiveCapabilityRequestForSession('sess-2')).toBe(false);
  });

  it('is scoped to session.requestCapability — an unrelated staged intent from the same session does not count', () => {
    insertStagedIntent(makeRow({ id: 'other-1', session_id: 'sess-3' }));
    expect(hasActiveCapabilityRequestForSession('sess-3')).toBe(false);
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

describe('expireStagedIntentsForSession (session-termination reaper)', () => {
  it('marks a terminated session\'s staged intents superseded and leaves other sessions\' intents untouched', () => {
    insertStagedIntent(
      makeRow({ id: 'dead-1', session_id: 'sess-dead', state: 'staged' }),
    );
    insertStagedIntent(
      makeRow({ id: 'dead-2', session_id: 'sess-dead', state: 'approved' }),
    );
    insertStagedIntent(
      makeRow({ id: 'live-1', session_id: 'sess-live', state: 'staged' }),
    );

    const reaped = expireStagedIntentsForSession(
      'sess-dead',
      'session_killed',
      100,
    );

    expect(reaped).toBe(2);
    expect(getStagedIntent('dead-1')!.state).toBe('superseded');
    expect(getStagedIntent('dead-1')!.disposition_reason).toBe(
      'session_killed',
    );
    expect(getStagedIntent('dead-1')!.updated_at).toBe(100);
    expect(getStagedIntent('dead-2')!.state).toBe('superseded');
    expect(getStagedIntent('live-1')!.state).toBe('staged');
  });

  it('never alters committed intents', () => {
    insertStagedIntent(
      makeRow({ id: 'committed-1', session_id: 'sess-dead', state: 'staged' }),
    );
    transitionStagedIntent('committed-1', 'committed');

    const reaped = expireStagedIntentsForSession(
      'sess-dead',
      'session_killed',
      100,
    );

    expect(reaped).toBe(0);
    expect(getStagedIntent('committed-1')!.state).toBe('committed');
  });

  it('never alters already-rejected intents', () => {
    insertStagedIntent(
      makeRow({ id: 'rejected-1', session_id: 'sess-dead', state: 'staged' }),
    );
    transitionStagedIntent('rejected-1', 'rejected');

    expireStagedIntentsForSession('sess-dead', 'session_killed', 100);

    expect(getStagedIntent('rejected-1')!.state).toBe('rejected');
  });
});

describe('sweepStagedIntentsForTerminalSessions (backstop sweep)', () => {
  it('reaps staged intents for sessions that reached a terminal status without a clean stop', () => {
    seedSession('sess-crashed', 'killed');
    seedSession('sess-running', 'running');
    insertStagedIntent(
      makeRow({
        id: 'crashed-1',
        session_id: 'sess-crashed',
        state: 'staged',
      }),
    );
    insertStagedIntent(
      makeRow({ id: 'running-1', session_id: 'sess-running', state: 'staged' }),
    );

    const reaped = sweepStagedIntentsForTerminalSessions(
      'session_terminal_backstop_sweep',
      200,
    );

    expect(reaped).toBe(1);
    expect(getStagedIntent('crashed-1')!.state).toBe('superseded');
    expect(getStagedIntent('crashed-1')!.disposition_reason).toBe(
      'session_terminal_backstop_sweep',
    );
    expect(getStagedIntent('running-1')!.state).toBe('staged');
  });

  it('is a no-op on a second pass (idempotent)', () => {
    seedSession('sess-crashed', 'error');
    insertStagedIntent(
      makeRow({
        id: 'crashed-1',
        session_id: 'sess-crashed',
        state: 'staged',
      }),
    );

    sweepStagedIntentsForTerminalSessions('sweep', 200);
    const secondPass = sweepStagedIntentsForTerminalSessions('sweep', 300);

    expect(secondPass).toBe(0);
  });
});
