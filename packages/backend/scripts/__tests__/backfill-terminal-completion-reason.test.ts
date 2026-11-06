import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../src/db/db.js';
import { recordEvent } from '../../src/audit/AuditLog';
import {
  backfillTerminalCompletionReason,
  getKilledSessionsMissingTerminalCompletionReason,
  getLatestSessionErroredReason,
} from '../backfill-terminal-completion-reason';

function insertSession(
  sessionId: string,
  status: string,
  terminalCompletionReason: string | null = null,
): void {
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, task_url, project_context_url,
       status, started_at, session_type, terminal_completion_reason)
     VALUES (?, 'task-1', 'https://notion.so/task', 'https://notion.so/ctx', ?, ?, 'standard', ?)`,
  ).run(
    sessionId,
    status,
    Date.now() - 10 * 60 * 1000,
    terminalCompletionReason,
  );
}

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('backfillTerminalCompletionReason', () => {
  it('sets terminal_completion_reason from the session_errored audit payload for a killed session with NULL reason', () => {
    insertSession('sess-killed', 'killed');
    recordEvent({
      event_type: 'session_errored',
      actor_type: 'system',
      actor_id: 'sess-killed',
      payload: {
        sessionId: 'sess-killed',
        status: 'killed',
        reason: 'user_kill',
      },
    });

    const summary = backfillTerminalCompletionReason();

    expect(summary).toEqual({ backfilled: 1, skippedNoAuditRow: 0 });
    const row = db
      .prepare(
        'SELECT terminal_completion_reason FROM sessions WHERE session_id = ?',
      )
      .get('sess-killed') as { terminal_completion_reason: string | null };
    expect(row.terminal_completion_reason).toBe('user_kill');
  });

  it('skips a killed session with no session_errored audit row', () => {
    insertSession('sess-no-audit', 'killed');

    const summary = backfillTerminalCompletionReason();

    expect(summary).toEqual({ backfilled: 0, skippedNoAuditRow: 1 });
    const row = db
      .prepare(
        'SELECT terminal_completion_reason FROM sessions WHERE session_id = ?',
      )
      .get('sess-no-audit') as { terminal_completion_reason: string | null };
    expect(row.terminal_completion_reason).toBeNull();
  });

  it('leaves a killed session with an existing terminal_completion_reason untouched', () => {
    insertSession('sess-already-set', 'killed', 'operator_abort');
    recordEvent({
      event_type: 'session_errored',
      actor_type: 'system',
      actor_id: 'sess-already-set',
      payload: {
        sessionId: 'sess-already-set',
        status: 'killed',
        reason: 'user_kill',
      },
    });

    expect(getKilledSessionsMissingTerminalCompletionReason()).toHaveLength(0);
    backfillTerminalCompletionReason();

    const row = db
      .prepare(
        'SELECT terminal_completion_reason FROM sessions WHERE session_id = ?',
      )
      .get('sess-already-set') as { terminal_completion_reason: string | null };
    expect(row.terminal_completion_reason).toBe('operator_abort');
  });

  it('does not touch a non-killed session even if missing a reason', () => {
    insertSession('sess-done', 'done');
    recordEvent({
      event_type: 'session_errored',
      actor_type: 'system',
      actor_id: 'sess-done',
      payload: { sessionId: 'sess-done', status: 'error', reason: 'run_error' },
    });

    expect(getKilledSessionsMissingTerminalCompletionReason()).toHaveLength(0);
  });

  it('getLatestSessionErroredReason returns the most recent reason when multiple rows exist', () => {
    recordEvent({
      event_type: 'session_errored',
      actor_type: 'system',
      actor_id: 'sess-multi',
      payload: { sessionId: 'sess-multi', status: 'error', reason: 'first' },
    });
    recordEvent({
      event_type: 'session_errored',
      actor_type: 'system',
      actor_id: 'sess-multi',
      payload: { sessionId: 'sess-multi', status: 'killed', reason: 'second' },
    });

    expect(getLatestSessionErroredReason('sess-multi')).toBe('second');
  });

  it('getLatestSessionErroredReason returns undefined when no row exists', () => {
    expect(getLatestSessionErroredReason('sess-none')).toBeUndefined();
  });
});
