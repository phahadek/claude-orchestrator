import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../config.js', () => ({
  runtimeSettings: { session_hard_stop_window_seconds: 60 },
}));

vi.mock('../../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi.fn().mockReturnValue({}),
}));

vi.mock('../../session/sessionRecovery.js', () => ({
  recoverSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../localBranchHelpers.js', () => ({
  getCurrentBranch: vi.fn(),
  hasNonEmptyDiff: vi.fn(),
}));

vi.mock('../localBranchSubmission.js', () => ({
  submitLocalBranch: vi.fn(),
}));

import { db } from '../../db/db.js';
import { listCompletingSignalsForSession } from '../../db/queries.js';
import { StuckSessionMonitor } from '../StuckSessionMonitor.js';

function insertStuckSession(opts: {
  session_id: string;
  session_type: string;
  task_id: string;
}) {
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, status, started_at, session_type)
     VALUES (@session_id, @task_id, 'running', 0, @session_type)`,
  ).run(opts);
  db.prepare(
    `INSERT INTO session_events (session_id, event_type, payload, timestamp)
     VALUES (?, 'system', ?, 5000)`,
  ).run(opts.session_id, JSON.stringify({ type: 'result' }));
}

function makeMonitor(alive: boolean) {
  const sessionManager = {
    on: vi.fn(),
    send: vi.fn(),
    isAlive: vi.fn().mockReturnValue(alive),
  } as unknown as import('../../session/SessionManager').SessionManager;
  return new StuckSessionMonitor(sessionManager, vi.fn());
}

const reapRows = (id: string) =>
  listCompletingSignalsForSession(id).filter(
    (r) => r.signal_class === 'result_reap',
  );

const sessionRow = (id: string) =>
  db
    .prepare(
      'SELECT status, terminal_completion_reason FROM sessions WHERE session_id = ?',
    )
    .get(id) as { status: string; terminal_completion_reason: string | null };

beforeEach(() => {
  db.prepare('DELETE FROM pull_requests').run();
  db.prepare('DELETE FROM session_events').run();
  db.prepare('DELETE FROM completing_signal_ledger').run();
  db.prepare('DELETE FROM sessions').run();
});

describe('StuckSessionMonitor.scanForStuckSessions — result_reap signal', () => {
  it('records one result_reap row on the no-PR reap done write and leaves the legacy write unchanged', async () => {
    insertStuckSession({
      session_id: 'reap-1',
      session_type: 'review',
      task_id: 'task-1',
    });

    await makeMonitor(false).scanForStuckSessions();

    expect(sessionRow('reap-1')).toEqual({
      status: 'done',
      terminal_completion_reason: 'stuck_session_no_pr_periodic',
    });
    const rows = reapRows('reap-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_type: 'review',
      signal_value: 'stuck_session_no_pr_periodic',
    });
    const legacy = listCompletingSignalsForSession('reap-1').filter(
      (r) => r.signal_class === 'legacy_status_write',
    );
    expect(legacy.map((r) => r.signal_value)).toEqual(['done']);
  });

  it('records result_reap for a gate-verify ops session', async () => {
    insertStuckSession({
      session_id: 'reap-gate',
      session_type: 'ops',
      task_id: 'gate-item:abc',
    });

    await makeMonitor(false).scanForStuckSessions();

    expect(sessionRow('reap-gate').status).toBe('done');
    expect(reapRows('reap-gate')).toHaveLength(1);
  });

  it('writes no result_reap row on the open-PR idle site', async () => {
    insertStuckSession({
      session_id: 'idle-pr',
      session_type: 'standard',
      task_id: 'task-pr',
    });
    db.prepare(
      `INSERT INTO pull_requests (pr_number, pr_url, task_id, session_id, repo, state, created_at, updated_at, synced_at)
       VALUES (1, 'https://github.com/o/r/pull/1', 'task-pr', 'idle-pr', 'o/r', 'open', 'x', 'x', 'x')`,
    ).run();

    await makeMonitor(false).scanForStuckSessions();

    expect(sessionRow('idle-pr').status).toBe('idle');
    expect(reapRows('idle-pr')).toHaveLength(0);
  });

  it('writes no result_reap row on the alive-subprocess idle site', async () => {
    insertStuckSession({
      session_id: 'idle-alive',
      session_type: 'review',
      task_id: 'task-alive',
    });

    await makeMonitor(true).scanForStuckSessions();

    expect(sessionRow('idle-alive').status).toBe('idle');
    expect(reapRows('idle-alive')).toHaveLength(0);
  });

  it('writes no result_reap row on the awaiting-operator idle site', async () => {
    insertStuckSession({
      session_id: 'idle-op',
      session_type: 'standard',
      task_id: 'task-op',
    });

    await makeMonitor(false).scanForStuckSessions();

    expect(sessionRow('idle-op').status).toBe('idle');
    expect(reapRows('idle-op')).toHaveLength(0);
  });
});
