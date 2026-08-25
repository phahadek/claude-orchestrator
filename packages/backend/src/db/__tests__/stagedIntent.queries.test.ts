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
  sessionHasNeverStagedAnyIntent,
  reapStagedIntentsForNeverStagedSession,
  insertSession,
  listStagedIntentsByMilestone,
  UNATTRIBUTED_MILESTONE_BUCKET,
  backfillStagedIntentMilestones,
  isSessionComplete,
} from '../queries.js';
import type { StagedIntentRow } from '../types.js';

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM sessions').run();
});

function seedSession(sessionId: string, status: string): void {
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
    milestone: null,
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

describe('isSessionComplete — blocked-member leg', () => {
  it('reads false for a session with a needs_revision member, even with a staged sibling and no turn in flight', () => {
    insertStagedIntent(
      makeRow({
        id: 'blocked-1',
        session_id: 'sess-b',
        state: 'needs_revision',
      }),
    );
    insertStagedIntent(
      makeRow({ id: 'sibling-1', session_id: 'sess-b', task_id: 't-2' }),
    );
    expect(isSessionComplete('sess-b', false)).toBe(false);
  });

  it('reads false for a session with a pending_verification member', () => {
    insertStagedIntent(
      makeRow({
        id: 'blocked-2',
        session_id: 'sess-c',
        state: 'pending_verification',
      }),
    );
    expect(isSessionComplete('sess-c', false)).toBe(false);
  });

  it('is derived purely from persisted rows — no live session handle is consulted', () => {
    insertStagedIntent(
      makeRow({
        id: 'blocked-3',
        session_id: 'sess-d',
        state: 'needs_revision',
      }),
    );
    // No SessionManager/live handle exists anywhere in this test — the
    // false verdict comes entirely from the persisted staged_intent row.
    expect(isSessionComplete('sess-d', false)).toBe(false);
  });

  it('reads true once the blocked member is the only row and it is declined/superseded away, leaving a staged sibling', () => {
    insertStagedIntent(
      makeRow({ id: 'was-blocked', session_id: 'sess-e', state: 'rejected' }),
    );
    insertStagedIntent(
      makeRow({ id: 'sibling-2', session_id: 'sess-e', task_id: 't-3' }),
    );
    expect(isSessionComplete('sess-e', false)).toBe(true);
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
  it("marks a terminated session's staged intents superseded and leaves other sessions' intents untouched", () => {
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

describe('sweepStagedIntentsForTerminalSessions (backstop sweep — now a permanent no-op)', () => {
  it('does NOT reap a staged intent merely because its owning session sits at a terminal DB status', () => {
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

    expect(reaped).toEqual([]);
    expect(getStagedIntent('crashed-1')!.state).toBe('staged');
    expect(getStagedIntent('crashed-1')!.disposition_reason).toBeNull();
    expect(getStagedIntent('running-1')!.state).toBe('staged');
  });

  it('is a no-op even when called repeatedly (idempotent by construction)', () => {
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

    expect(secondPass).toEqual([]);
    expect(getStagedIntent('crashed-1')!.state).toBe('staged');
  });
});

describe('sessionHasNeverStagedAnyIntent / reapStagedIntentsForNeverStagedSession — the narrowed, content-based reap', () => {
  it('sessionHasNeverStagedAnyIntent keys on whether the session has ANY staged_intent row, in any state', () => {
    expect(sessionHasNeverStagedAnyIntent('sess-fresh')).toBe(true);

    insertStagedIntent(
      makeRow({ id: 'committed-only', session_id: 'sess-committed-history' }),
    );
    transitionStagedIntent('committed-only', 'committed');
    expect(sessionHasNeverStagedAnyIntent('sess-committed-history')).toBe(
      false,
    );
  });

  it('is a genuine no-op for a session that emitted a clean result and staged a task.create, even though the session is now killed', () => {
    seedSession('sess-clean-result', 'killed');
    insertStagedIntent(
      makeRow({
        id: 'finding-1',
        session_id: 'sess-clean-result',
        kind: 'task.create',
        state: 'staged',
      }),
    );

    const reaped = reapStagedIntentsForNeverStagedSession(
      'sess-clean-result',
      'session_killed_no_artifact',
      500,
    );

    expect(reaped).toBe(0);
    expect(getStagedIntent('finding-1')!.state).toBe('staged');
    expect(getStagedIntent('finding-1')!.disposition_reason).toBeNull();
  });

  it('is a no-op for the same finding once the operator has already approved it', () => {
    seedSession('sess-clean-result', 'killed');
    insertStagedIntent(
      makeRow({
        id: 'finding-1',
        session_id: 'sess-clean-result',
        kind: 'task.create',
        state: 'staged',
      }),
    );
    transitionStagedIntent('finding-1', 'approved');

    const reaped = reapStagedIntentsForNeverStagedSession(
      'sess-clean-result',
      'session_killed_no_artifact',
      500,
    );

    expect(reaped).toBe(0);
    expect(getStagedIntent('finding-1')!.state).toBe('approved');
  });

  it('the surviving intent stays on the active-intent read after its session is killed', () => {
    seedSession('sess-clean-result', 'killed');
    insertStagedIntent(
      makeRow({ id: 'finding-1', session_id: 'sess-clean-result' }),
    );

    reapStagedIntentsForNeverStagedSession(
      'sess-clean-result',
      'session_killed_no_artifact',
      500,
    );

    expect(
      findActiveStagedIntentForTask('proj-1', 'task.setStatus', 't-1'),
    ).toBeDefined();
  });

  it('does reap — as a documented, provably-inert no-op — a session that never staged anything at all', () => {
    seedSession('sess-never-staged', 'killed');

    const reaped = reapStagedIntentsForNeverStagedSession(
      'sess-never-staged',
      'session_killed_no_artifact',
      500,
    );

    expect(reaped).toBe(0);
  });

  it('a genuine content-based supersede (a newer intent replacing an older one) still marks the old one superseded', () => {
    insertStagedIntent(makeRow());
    transitionStagedIntent('intent-1', 'approved');

    const replacement = makeRow({
      id: 'intent-2',
      payload: JSON.stringify({ taskId: 't-1', status: 'Backlog' }),
    });
    supersedeStagedIntent('intent-1', replacement);

    expect(getStagedIntent('intent-1')!.state).toBe('superseded');
  });
});

describe('listStagedIntentsByMilestone', () => {
  it('returns only the requested milestone project intents, excluding other milestones and other projects', () => {
    insertStagedIntent(
      makeRow({ id: 'm12-1', group_id: null, milestone: 'M12' }),
    );
    insertStagedIntent(
      makeRow({ id: 'm13-1', group_id: null, milestone: 'M13' }),
    );
    insertStagedIntent(
      makeRow({
        id: 'other-project-1',
        group_id: null,
        milestone: 'M12',
        project_id: 'proj-2',
      }),
    );

    const rows = listStagedIntentsByMilestone('proj-1', 'M12');

    expect(rows.map((r) => r.id)).toEqual(['m12-1']);
  });

  it('resolves null-milestone rows to the "unattributed" bucket, and never mixes them into a real milestone', () => {
    insertStagedIntent(
      makeRow({ id: 'legacy-1', group_id: null, milestone: null }),
    );
    insertStagedIntent(
      makeRow({ id: 'legacy-2', group_id: null, milestone: null }),
    );
    insertStagedIntent(
      makeRow({ id: 'm12-1', group_id: null, milestone: 'M12' }),
    );

    const unattributed = listStagedIntentsByMilestone(
      'proj-1',
      UNATTRIBUTED_MILESTONE_BUCKET,
    );
    const m12 = listStagedIntentsByMilestone('proj-1', 'M12');

    expect(unattributed.map((r) => r.id).sort()).toEqual([
      'legacy-1',
      'legacy-2',
    ]);
    expect(m12.map((r) => r.id)).toEqual(['m12-1']);
  });

  it('excludes terminal-state rows (committed/rejected/superseded), same as the project/session lenses', () => {
    insertStagedIntent(
      makeRow({ id: 'm12-committed', group_id: null, milestone: 'M12' }),
    );
    transitionStagedIntent('m12-committed', 'approved');
    transitionStagedIntent('m12-committed', 'committed');
    insertStagedIntent(
      makeRow({ id: 'm12-staged', group_id: null, milestone: 'M12' }),
    );

    const rows = listStagedIntentsByMilestone('proj-1', 'M12');

    expect(rows.map((r) => r.id)).toEqual(['m12-staged']);
  });

  it('includes blocked (needs_revision/pending_verification) rows — a group with a blocked member must stay visible to the operator, not vanish off the inbox', () => {
    insertStagedIntent(
      makeRow({ id: 'm12-needs-revision', group_id: 'g-1', milestone: 'M12' }),
    );
    transitionStagedIntent('m12-needs-revision', 'needs_revision');
    insertStagedIntent(
      makeRow({
        id: 'm12-pending-verification',
        group_id: 'g-2',
        milestone: 'M12',
      }),
    );
    transitionStagedIntent('m12-pending-verification', 'pending_verification');

    const rows = listStagedIntentsByMilestone('proj-1', 'M12');

    expect(rows.map((r) => r.id).sort()).toEqual([
      'm12-needs-revision',
      'm12-pending-verification',
    ]);
  });
});

describe('backfillStagedIntentMilestones', () => {
  it('resolves and persists milestone for null-milestone rows with a task_id, via the injected resolver', () => {
    insertStagedIntent(
      makeRow({
        id: 'needs-backfill',
        group_id: null,
        milestone: null,
        task_id: 't-1',
      }),
    );

    const updated = backfillStagedIntentMilestones((projectId, taskId) =>
      projectId === 'proj-1' && taskId === 't-1' ? 'M12' : null,
    );

    expect(updated).toBe(1);
    expect(getStagedIntent('needs-backfill')!.milestone).toBe('M12');
  });

  it('leaves a row NULL (unattributed) when the resolver finds nothing', () => {
    insertStagedIntent(
      makeRow({
        id: 'unresolvable',
        group_id: null,
        milestone: null,
        task_id: 't-1',
      }),
    );

    const updated = backfillStagedIntentMilestones(() => null);

    expect(updated).toBe(0);
    expect(getStagedIntent('unresolvable')!.milestone).toBeNull();
  });

  it('never touches a row that already has a milestone', () => {
    insertStagedIntent(
      makeRow({
        id: 'already-set',
        group_id: null,
        milestone: 'M12',
        task_id: 't-1',
      }),
    );

    const resolve = vi.fn(() => 'M99');
    const updated = backfillStagedIntentMilestones(resolve);

    expect(updated).toBe(0);
    expect(resolve).not.toHaveBeenCalled();
    expect(getStagedIntent('already-set')!.milestone).toBe('M12');
  });
});
