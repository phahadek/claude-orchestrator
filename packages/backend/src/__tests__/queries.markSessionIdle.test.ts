import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import { markSessionDone, markSessionIdle, applyPendingDone } from '../db/queries';

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

beforeEach(() => {
  db.prepare('DELETE FROM session_events').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('markSessionIdle terminal guard', () => {
  it('leaves a done session done and does not change ended_at', () => {
    const doneAt = Date.now() - 60_000;
    insertSession('sess-done', 'done', { endedAt: doneAt });

    markSessionIdle('sess-done', Date.now(), null);

    const row = getRow('sess-done');
    expect(row?.status).toBe('done');
    expect(row?.ended_at).toBe(doneAt);
  });

  it('still transitions a running session to idle (StuckSessionMonitor path unregressed)', () => {
    insertSession('sess-running', 'running');

    const endedAt = Date.now();
    markSessionIdle('sess-running', endedAt, null);

    const row = getRow('sess-running');
    expect(row?.status).toBe('idle');
    expect(row?.ended_at).toBe(endedAt);
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

  it("mirrors PlanningOrchestrator.markTerminal's ordering: a markSessionDone call made while the turn is still in flight defers instead of racing the clean-exit chain's markSessionIdle, and the deferred done still wins once applied", () => {
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
    // clean-exit chain calls markSessionIdle for a planning session
    // regardless of the deferred mark above.
    markSessionIdle('sess-planning', Date.now(), null);
    expect(getRow('sess-planning')?.status).toBe('idle');

    // SessionManager applies the deferred transition once the turn has
    // genuinely completed (its run() promise settles) — the deferred 'done'
    // wins over the idle write that preceded it.
    expect(applyPendingDone('sess-planning')).toBe(true);
    const row = getRow('sess-planning');
    expect(row?.status).toBe('done');
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
