import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import { markSessionDone } from '../db/queries';

function insertSession(
  sessionId: string,
  status: string,
  opts: {
    taskId?: string;
    endedAt?: number | null;
    terminalCompletionReason?: string | null;
  } = {},
): void {
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, task_url, project_context_url,
       status, started_at, ended_at, session_type, terminal_completion_reason)
     VALUES (?, ?, 'https://notion.so/task', 'https://notion.so/ctx', ?, ?, ?, 'standard', ?)`,
  ).run(
    sessionId,
    opts.taskId ?? 'task-1',
    status,
    Date.now() - 10 * 60 * 1000,
    opts.endedAt ?? null,
    opts.terminalCompletionReason ?? null,
  );
}

function getRow(sessionId: string):
  | {
      status: string;
      ended_at: number | null;
      terminal_completion_reason: string | null;
    }
  | undefined {
  return db
    .prepare(
      'SELECT status, ended_at, terminal_completion_reason FROM sessions WHERE session_id = ?',
    )
    .get(sessionId) as
    | {
        status: string;
        ended_at: number | null;
        terminal_completion_reason: string | null;
      }
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

describe('markSessionDone terminal guard', () => {
  it('does not overwrite an already-killed session with done', () => {
    const killedAt = Date.now() - 60_000;
    insertSession('sess-killed', 'killed', {
      endedAt: killedAt,
      terminalCompletionReason: 'operator_abort',
    });

    markSessionDone(
      'sess-killed',
      Date.now(),
      null,
      'planning_no_pending_dispositions',
    );

    const row = getRow('sess-killed');
    expect(row?.status).toBe('killed');
    expect(row?.ended_at).toBe(killedAt);
    expect(row?.terminal_completion_reason).toBe('operator_abort');
  });

  it('does not overwrite an already-errored session with done', () => {
    insertSession('sess-error', 'error', {
      terminalCompletionReason: 'crash',
    });

    markSessionDone('sess-error', Date.now(), null, 'some_call_site');

    const row = getRow('sess-error');
    expect(row?.status).toBe('error');
    expect(row?.terminal_completion_reason).toBe('crash');
  });

  it('does not overwrite an already-superseded session with done', () => {
    insertSession('sess-superseded', 'superseded', {
      terminalCompletionReason: 'sendOrResume_supersede',
    });

    markSessionDone('sess-superseded', Date.now(), null, 'some_call_site');

    const row = getRow('sess-superseded');
    expect(row?.status).toBe('superseded');
    expect(row?.terminal_completion_reason).toBe('sendOrResume_supersede');
  });

  it('records a session_done_write_skipped_terminal audit event carrying status_before', () => {
    insertSession('sess-killed-2', 'killed', { taskId: 'task-xyz' });

    markSessionDone(
      'sess-killed-2',
      Date.now(),
      null,
      'planning_no_pending_dispositions',
    );

    const rows = getAuditRows('session_done_write_skipped_terminal');
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe('sess-killed-2');
    expect(JSON.parse(rows[0].payload)).toMatchObject({
      status_before: 'killed',
      call_site: 'planning_no_pending_dispositions',
    });
  });

  it('still transitions a non-terminal session to done', () => {
    insertSession('sess-idle', 'idle');

    markSessionDone('sess-idle', Date.now(), null, 'clean_exit');

    const row = getRow('sess-idle');
    expect(row?.status).toBe('done');
    expect(row?.terminal_completion_reason).toBe('clean_exit');
  });
});
