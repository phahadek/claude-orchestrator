import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import {
  markSessionDone,
  markSessionIdle,
  insertStagedIntent,
  getSessionsWithUnappliedPendingDone,
} from '../db/queries';
import type { StagedIntentRow } from '../db/types';

function insertSession(
  sessionId: string,
  status: string,
  opts: {
    taskId?: string;
    endedAt?: number | null;
    prUrl?: string | null;
  } = {},
): void {
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, task_url, project_context_url,
       status, started_at, ended_at, pr_url, session_type)
     VALUES (?, ?, 'https://notion.so/task', 'https://notion.so/ctx', ?, ?, ?, ?, 'standard')`,
  ).run(
    sessionId,
    opts.taskId ?? 'task-1',
    status,
    Date.now() - 10 * 60 * 1000,
    opts.endedAt ?? null,
    opts.prUrl ?? null,
  );
}

function getRow(
  sessionId: string,
):
  | { status: string; ended_at: number | null; pr_url: string | null }
  | undefined {
  return db
    .prepare(
      'SELECT status, ended_at, pr_url FROM sessions WHERE session_id = ?',
    )
    .get(sessionId) as
    | { status: string; ended_at: number | null; pr_url: string | null }
    | undefined;
}

function getAuditRows(
  eventType: string,
): Array<{ event_type: string; actor_id: string; payload: string }> {
  return db
    .prepare(
      'SELECT event_type, actor_id, payload FROM audit_log WHERE event_type = ?',
    )
    .all(eventType) as Array<{
    event_type: string;
    actor_id: string;
    payload: string;
  }>;
}

function stageIntent(
  sessionId: string,
  overrides: Partial<StagedIntentRow> = {},
): StagedIntentRow {
  const now = Date.now();
  const row: StagedIntentRow = {
    id: `intent-${sessionId}`,
    kind: 'task.setStatus',
    payload: JSON.stringify({ taskId: `task-${sessionId}`, status: 'Ready' }),
    payload_hash: `hash-${sessionId}`,
    task_id: `task-${sessionId}`,
    project_id: 'proj-1',
    session_id: sessionId,
    group_id: null,
    milestone: null,
    state: 'staged',
    supersedes: null,
    annotation: null,
    decision_proposal: null,
    groom_proposal: null,
    advisory: null,
    disposition_reason: null,
    answer: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  insertStagedIntent(row);
  return row;
}

beforeEach(() => {
  db.prepare('DELETE FROM session_events').run();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('markSessionIdle terminal guard', () => {
  it('leaves a done session done and does not change ended_at', () => {
    const doneAt = Date.now() - 60_000;
    insertSession('sess-done', 'done', { endedAt: doneAt });

    const result = markSessionIdle('sess-done', Date.now(), null);

    const row = getRow('sess-done');
    expect(row?.status).toBe('done');
    expect(row?.ended_at).toBe(doneAt);
    expect(result).toBe('done');
  });

  it('still transitions a running session to idle (StuckSessionMonitor path unregressed)', () => {
    insertSession('sess-running', 'running');

    const endedAt = Date.now();
    const result = markSessionIdle('sess-running', endedAt, null);

    const row = getRow('sess-running');
    expect(row?.status).toBe('idle');
    expect(row?.ended_at).toBe(endedAt);
    expect(result).toBe('idle');
  });

  it('reports the pre-existing status for each terminal value (error, killed)', () => {
    insertSession('sess-err', 'error');
    insertSession('sess-killed-2', 'killed');

    expect(markSessionIdle('sess-err', Date.now(), null)).toBe('error');
    expect(markSessionIdle('sess-killed-2', Date.now(), null)).toBe('killed');
  });

  it('records a session_idle_write_skipped_terminal audit event carrying status_before', () => {
    insertSession('sess-error', 'error', { taskId: 'task-xyz' });

    markSessionIdle('sess-error', Date.now(), null);

    const rows = getAuditRows('session_idle_write_skipped_terminal');
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe('sess-error');
    expect(JSON.parse(rows[0].payload)).toMatchObject({
      status_before: 'error',
    });
  });

  it('still persists the scraped pr_url when the guard fires and pr_url was null', () => {
    insertSession('sess-killed', 'killed', { prUrl: null });

    markSessionIdle('sess-killed', Date.now(), 'https://github.com/o/r/pull/1');

    const row = getRow('sess-killed');
    expect(row?.status).toBe('killed');
    expect(row?.pr_url).toBe('https://github.com/o/r/pull/1');
  });

  it("mirrors PlanningOrchestrator.markTerminal's ordering: a markSessionDone call made while the turn is still in flight defers, and the running-to-idle transition drains it directly instead of parking at idle first", () => {
    insertSession('sess-planning', 'running', { taskId: 'task-plan' });

    // Turn still in flight (status='running') — markSessionDone must not
    // write 'done' here; it stashes the transition instead.
    markSessionDone(
      'sess-planning',
      Date.now(),
      null,
      'planning_no_pending_dispositions',
    );
    expect(getRow('sess-planning')?.status).toBe('running');

    // Ending the session's subprocess drives a clean exit; AgentSession's
    // clean-exit chain calls markSessionIdle for a planning session — the
    // pending done is now drained right here rather than parking at idle
    // and waiting on a later run()-settle/boot-sweep backstop.
    const effective = markSessionIdle('sess-planning', Date.now(), null);
    expect(effective).toBe('done');
    const row = getRow('sess-planning');
    expect(row?.status).toBe('done');
  });

  it('drains a pending_done directly to done when a running session transitions off running to idle', () => {
    insertSession('sess-review', 'running', { taskId: 'task-review' });

    markSessionDone(
      'sess-review',
      1000,
      'https://github.com/o/r/pull/9',
      'auto_merger',
    );
    expect(getRow('sess-review')?.status).toBe('running');

    const effective = markSessionIdle('sess-review', 2000, null);

    expect(effective).toBe('done');
    const row = getRow('sess-review');
    expect(row?.status).toBe('done');
  });

  it('preserves the pending pr_url and ended_at over the idle call’s own values when draining', () => {
    insertSession('sess-pending-pr', 'running');

    markSessionDone(
      'sess-pending-pr',
      1000,
      'https://github.com/o/r/pull/42',
      'auto_merger',
    );

    markSessionIdle(
      'sess-pending-pr',
      9999,
      'https://github.com/o/r/pull/should-not-win',
    );

    const row = getRow('sess-pending-pr');
    expect(row?.status).toBe('done');
    expect(row?.ended_at).toBe(1000);
    expect(row?.pr_url).toBe('https://github.com/o/r/pull/42');
  });

  it('still transitions to idle, leaving the pending_done intact, when the session holds an undispositioned staged intent', () => {
    insertSession('sess-staged', 'running', { taskId: 'task-staged' });

    markSessionDone('sess-staged', 1000, null, 'auto_merger');
    stageIntent('sess-staged', { state: 'staged' });

    const effective = markSessionIdle('sess-staged', 2000, null);

    expect(effective).toBe('idle');
    const row = getRow('sess-staged');
    expect(row?.status).toBe('idle');

    // The pending row is left intact for a later drain.
    const pending = getSessionsWithUnappliedPendingDone();
    expect(pending.map((s) => s.session_id)).toContain('sess-staged');
  });

  it('still transitions to idle when the session holds an approved (not yet staged-only) staged intent', () => {
    insertSession('sess-approved', 'running', { taskId: 'task-approved' });

    markSessionDone('sess-approved', 1000, null, 'auto_merger');
    stageIntent('sess-approved', { state: 'approved' });

    const effective = markSessionIdle('sess-approved', 2000, null);

    expect(effective).toBe('idle');
    expect(getRow('sess-approved')?.status).toBe('idle');
  });

  it('does not overwrite an existing pr_url when the guard fires', () => {
    insertSession('sess-done-pr', 'done', {
      prUrl: 'https://github.com/o/r/pull/1',
    });

    markSessionIdle(
      'sess-done-pr',
      Date.now(),
      'https://github.com/o/r/pull/2',
    );

    const row = getRow('sess-done-pr');
    expect(row?.pr_url).toBe('https://github.com/o/r/pull/1');
  });
});
