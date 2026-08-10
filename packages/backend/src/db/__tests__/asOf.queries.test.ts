/**
 * Tests for the asOf-aware point-in-time reads (db/queries.ts) that back the
 * gate-verify read path: a claim about "was X true at T" must not silently
 * answer against whatever the row says now. Each test mutates a row after
 * the asOf cutoff and asserts the asOf-aware getter still returns the
 * pre-mutation value, while the plain current-state getter returns the new
 * one.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  getGateItemAsOf,
  getGateItem,
  getOpsJournalEntryAsOf,
  getOpsJournalEntry,
  getSessionAsOf,
  getSession,
  getPRAsOf,
  getPRByNotionTaskId,
  getDeployRunAsOf,
  getDeployRun,
  isUnreconstructable,
} from '../queries.js';

const T0 = Date.parse('2024-01-01T00:00:00.000Z');
const T1 = Date.parse('2024-01-02T00:00:00.000Z');
const T2 = Date.parse('2024-01-03T00:00:00.000Z');

function insertAuditRow(opts: {
  ts: number;
  eventType: string;
  taskId?: string | null;
  payload: unknown;
}): void {
  db.prepare(
    `INSERT INTO audit_log (ts, event_type, actor_type, actor_id, project_id, task_id, payload)
     VALUES (@ts, @event_type, 'system', NULL, NULL, @task_id, @payload)`,
  ).run({
    ts: opts.ts,
    event_type: opts.eventType,
    task_id: opts.taskId ?? null,
    payload: JSON.stringify(opts.payload),
  });
}

beforeEach(() => {
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM ops_journal').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM pull_requests').run();
  db.prepare('DELETE FROM deploy_run').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('getGateItemAsOf', () => {
  it('returns the state/classification as of the cutoff, not the current row', () => {
    const id = 'item-1';
    db.prepare(
      `INSERT INTO gate_item (id, project, milestone, text, classification, state, updated_at)
       VALUES (?, 'proj-1', 'M12', 'an item', 'Read-Only', 'open', ?)`,
    ).run(id, new Date(T0).toISOString());
    insertAuditRow({
      ts: T0,
      eventType: 'gate_item_created',
      payload: { gateItemId: id, milestone: 'M12' },
    });

    // Item resolves to 'resolved'/pass at T1, evidenced by a matching event row.
    db.prepare(
      `INSERT INTO gate_item_event (gate_item_id, disposition, at) VALUES (?, 'pass', ?)`,
    ).run(id, new Date(T1).toISOString());
    insertAuditRow({
      ts: T1,
      eventType: 'gate_item_state_changed',
      payload: { gateItemId: id, from: 'open', to: 'resolved' },
    });
    db.prepare(
      `UPDATE gate_item SET state = 'resolved', current_disposition = 'pass', updated_at = ? WHERE id = ?`,
    ).run(new Date(T1).toISOString(), id);

    const cutoff = new Date((T0 + T1) / 2).toISOString();

    // Row moves on again after the cutoff — mutate to simulate "since moved on".
    insertAuditRow({
      ts: T2,
      eventType: 'gate_item_reclassified',
      payload: { gateItemId: id, from: 'Read-Only', to: 'Human-Observation' },
    });
    db.prepare(
      `UPDATE gate_item SET classification = 'Human-Observation', state = 'open', current_disposition = NULL, updated_at = ? WHERE id = ?`,
    ).run(new Date(T2).toISOString(), id);
    insertAuditRow({
      ts: T2 + 1,
      eventType: 'gate_item_state_changed',
      payload: { gateItemId: id, from: 'resolved', to: 'open' },
    });

    const asOfResult = getGateItemAsOf(id, cutoff);
    expect(asOfResult?.state).toBe('open');
    expect(asOfResult?.classification).toBe('Read-Only');
    expect(asOfResult?.current_disposition).toBeNull();
    expect(isUnreconstructable(asOfResult?.min_deployed_commit)).toBe(true);

    const current = getGateItem(id);
    expect(current?.state).toBe('open');
    expect(current?.classification).toBe('Human-Observation');

    const asOfAfterResolve = getGateItemAsOf(
      id,
      new Date(T1 + 1).toISOString(),
    );
    expect(asOfAfterResolve?.state).toBe('resolved');
    expect(asOfAfterResolve?.current_disposition).toBe('pass');
    expect(asOfAfterResolve?.classification).toBe('Read-Only');
  });

  it('returns undefined when the item did not exist yet as of the cutoff', () => {
    const id = 'item-2';
    db.prepare(
      `INSERT INTO gate_item (id, project, milestone, text, classification, state, updated_at)
       VALUES (?, 'proj-1', 'M12', 'an item', 'Read-Only', 'open', ?)`,
    ).run(id, new Date(T1).toISOString());
    insertAuditRow({
      ts: T1,
      eventType: 'gate_item_created',
      payload: { gateItemId: id, milestone: 'M12' },
    });

    expect(getGateItemAsOf(id, new Date(T0).toISOString())).toBeUndefined();
  });
});

describe('getOpsJournalEntryAsOf', () => {
  it('returns the state as of the cutoff, not the current row', () => {
    const taskId = 'task-1';
    db.prepare(
      `INSERT INTO ops_journal (task_id, project, milestone, state, updated_at)
       VALUES (?, 'proj-1', 'M12', 'pending', ?)`,
    ).run(taskId, new Date(T0).toISOString());
    insertAuditRow({
      ts: T0,
      eventType: 'ops_journal_entry_seeded',
      taskId,
      payload: { milestone: 'M12' },
    });

    const cutoff = new Date((T0 + T1) / 2).toISOString();

    // Transitions after the cutoff — the row has since moved on.
    insertAuditRow({
      ts: T1,
      eventType: 'ops_journal_state_changed',
      taskId,
      payload: { from: 'pending', to: 'resolved', milestone: 'M12' },
    });
    db.prepare(
      `UPDATE ops_journal SET state = 'resolved', updated_at = ? WHERE task_id = ?`,
    ).run(new Date(T1).toISOString(), taskId);

    const asOfResult = getOpsJournalEntryAsOf(taskId, cutoff);
    expect(asOfResult?.state).toBe('pending');
    expect(isUnreconstructable(asOfResult?.disposition)).toBe(true);

    const current = getOpsJournalEntry(taskId);
    expect(current?.state).toBe('resolved');

    const asOfAfter = getOpsJournalEntryAsOf(
      taskId,
      new Date(T1 + 1).toISOString(),
    );
    expect(asOfAfter?.state).toBe('resolved');
  });

  it('returns undefined when the entry was dropped and not re-seeded by the cutoff', () => {
    const taskId = 'task-2';
    db.prepare(
      `INSERT INTO ops_journal (task_id, project, milestone, state, updated_at)
       VALUES (?, 'proj-1', 'M12', 'resolved', ?)`,
    ).run(taskId, new Date(T2).toISOString());
    insertAuditRow({
      ts: T0,
      eventType: 'ops_journal_entry_seeded',
      taskId,
      payload: { milestone: 'M12' },
    });
    insertAuditRow({
      ts: T1,
      eventType: 'ops_journal_entry_dropped',
      taskId,
      payload: { milestone: 'M12', state: 'pending' },
    });

    expect(
      getOpsJournalEntryAsOf(taskId, new Date((T1 + T2) / 2).toISOString()),
    ).toBeUndefined();
  });
});

describe('getSessionAsOf', () => {
  it('marks status unreconstructable but returns undefined before the session started', () => {
    const sessionId = 'session-1';
    db.prepare(
      `INSERT INTO sessions (session_id, status, started_at, session_type, task_name)
       VALUES (?, 'done', ?, 'standard', 't')`,
    ).run(sessionId, T1);

    const asOfResult = getSessionAsOf(sessionId, new Date(T2).toISOString());
    expect(asOfResult?.session_id).toBe(sessionId);
    expect(isUnreconstructable(asOfResult?.status)).toBe(true);

    expect(
      getSessionAsOf(sessionId, new Date(T0).toISOString()),
    ).toBeUndefined();
    expect(getSession(sessionId)?.status).toBe('done');
  });
});

describe('getPRAsOf', () => {
  it('keeps static fields, marks mutable fields unreconstructable', () => {
    const taskId = 'task-3';
    db.prepare(
      `INSERT INTO pull_requests
        (pr_number, pr_url, task_id, repo, state, draft, created_at, updated_at, synced_at)
       VALUES (1, 'https://github.com/o/r/pull/1', ?, 'o/r', 'open', 0, ?, ?, ?)`,
    ).run(
      taskId,
      new Date(T0).toISOString(),
      new Date(T1).toISOString(),
      new Date(T1).toISOString(),
    );

    const asOfResult = getPRAsOf(taskId, new Date(T2).toISOString());
    expect(asOfResult?.task_id).toBe(taskId);
    expect(asOfResult?.repo).toBe('o/r');
    expect(isUnreconstructable(asOfResult?.state)).toBe(true);

    expect(getPRByNotionTaskId(taskId)?.state).toBe('open');
    expect(getPRAsOf(taskId, new Date(T0 - 1).toISOString())).toBeUndefined();
  });
});

describe('getDeployRunAsOf', () => {
  it('keeps static fields, marks mutable fields unreconstructable', () => {
    const runId = 'run-1';
    db.prepare(
      `INSERT INTO deploy_run (run_id, project, target_sha, current_step, status, started_at)
       VALUES (?, 'proj-1', 'abc123', 'building', 'running', ?)`,
    ).run(runId, new Date(T0).toISOString());

    const asOfResult = getDeployRunAsOf(runId, new Date(T1).toISOString());
    expect(asOfResult?.run_id).toBe(runId);
    expect(asOfResult?.target_sha).toBe('abc123');
    expect(isUnreconstructable(asOfResult?.status)).toBe(true);
    expect(isUnreconstructable(asOfResult?.current_step)).toBe(true);

    db.prepare(
      `UPDATE deploy_run SET status = 'succeeded', completed_at = ? WHERE run_id = ?`,
    ).run(new Date(T1).toISOString(), runId);
    expect(getDeployRun(runId)?.status).toBe('succeeded');

    expect(
      getDeployRunAsOf(runId, new Date(T0 - 1).toISOString()),
    ).toBeUndefined();
  });
});
