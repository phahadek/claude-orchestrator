/**
 * Tests for the five indexes filed to close the remaining gaps from the
 * index audit (audit_log.actor_id, staged_intent.task_id,
 * permission_denials.session_id, pull_requests.pr_intent_id,
 * session_audits.session_id): five unindexed lookups plus two FK-cascade
 * scans that fire on every `deleteSession` (session_audits and
 * permission_denials both carry an ON DELETE CASCADE FK to sessions but no
 * index on the child session_id column, so SQLite scans each end to end to
 * enforce the cascade).
 *
 * These assert the access path via EXPLAIN QUERY PLAN, not timing, so a
 * regression shows up as a plan change rather than a flaky benchmark. The
 * cascade scan itself isn't directly observable via EXPLAIN QUERY PLAN on
 * the DELETE statement, so it's asserted indirectly: the FK child tables
 * carry a session_id index.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  insertSession,
  deleteSession,
  insertStagedIntent,
  hasStagedIntentForTask,
  insertPermissionDenial,
  getDenialsBySession,
  linkPRToPRIntent,
  getPRIntentForPR,
  insertSessionAudit,
  hashIntentPayload,
} from '../queries.js';
import { recordEvent, getAuditLogByActorId } from '../../audit/AuditLog.js';
import { runMigrations } from '../schema.js';
import type { StagedIntentRow } from '../types.js';

/** Plan text for a statement, joined so it can be asserted as a whole. */
function planFor(sql: string, params: Record<string, unknown>): string {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as {
      detail: string;
    }[]
  )
    .map((r) => r.detail)
    .join(' | ');
}

function indexNames(table: string): string[] {
  return (
    db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]
  ).map((i) => i.name);
}

const NOW = '2024-01-01T00:00:00Z';

function seedSession(sessionId: string): void {
  insertSession({
    session_id: sessionId,
    task_id: `task:${sessionId}`,
    task_url: null,
    project_context_url: null,
    status: 'idle',
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

function insertPR(prNumber: number, repo = 'owner/repo'): void {
  db.prepare(
    `
    INSERT INTO pull_requests
      (pr_number, pr_url, task_id, repo, state, created_at, updated_at, synced_at)
    VALUES
      (@pr_number, @pr_url, 'task-1', @repo, 'open', @created_at, @updated_at, @synced_at)
  `,
  ).run({
    pr_number: prNumber,
    pr_url: `https://github.com/${repo}/pull/${prNumber}`,
    repo,
    created_at: NOW,
    updated_at: NOW,
    synced_at: NOW,
  });
}

function insertOpsPrIntent(id: string): StagedIntentRow {
  const now = Date.now();
  const payload = { taskId: 'task-1', note: id };
  const row: StagedIntentRow = {
    id,
    kind: 'ops.prIntent',
    payload: JSON.stringify(payload),
    payload_hash: hashIntentPayload(payload),
    task_id: 'task-1',
    project_id: 'proj-1',
    session_id: 'session-1',
    group_id: null,
    milestone: null,
    state: 'committed',
    supersedes: null,
    annotation: null,
    decision_proposal: null,
    groom_proposal: null,
    advisory: null,
    disposition_reason: null,
    answer: null,
    created_at: now,
    updated_at: now,
  } as StagedIntentRow;
  insertStagedIntent(row);
  return row;
}

beforeEach(() => {
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM permission_denials').run();
  db.prepare('DELETE FROM pull_requests').run();
  db.prepare('DELETE FROM session_audits').run();
  db.prepare('DELETE FROM sessions').run();
});

describe('index audit gap closures', () => {
  it('creates all five indexes', () => {
    expect(indexNames('audit_log')).toContain('idx_audit_log_actor_id');
    expect(indexNames('staged_intent')).toContain('idx_staged_intent_task_id');
    expect(indexNames('permission_denials')).toContain(
      'idx_permission_denials_session_id',
    );
    expect(indexNames('pull_requests')).toContain(
      'idx_pull_requests_pr_intent_id',
    );
    expect(indexNames('session_audits')).toContain(
      'idx_session_audits_session_id',
    );
  });

  it('is idempotent on re-run', () => {
    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();
    expect(indexNames('audit_log')).toContain('idx_audit_log_actor_id');
  });

  it('resolves getAuditLogByActorId by actor_id without scanning audit_log', () => {
    const plan = planFor(
      `SELECT * FROM audit_log WHERE actor_id = @actor_id ORDER BY id ASC`,
      { actor_id: 'sess-1' },
    );
    expect(plan).toContain('idx_audit_log_actor_id');
    expect(plan).not.toMatch(/SCAN audit_log(?! USING)/);
  });

  it('returns byte-identical results for getAuditLogByActorId, including an actor with no rows', () => {
    recordEvent({
      event_type: 'session_launched',
      actor_type: 'ai',
      actor_id: 'sess-1',
      project_id: 'proj-1',
      task_id: 'task-1',
      payload: { foo: 'bar' },
    });
    recordEvent({
      event_type: 'session_errored',
      actor_type: 'ai',
      actor_id: 'sess-2',
      payload: {},
    });

    const events = getAuditLogByActorId('sess-1');
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('session_launched');
    expect(events[0].actorId).toBe('sess-1');

    expect(getAuditLogByActorId('sess-none')).toEqual([]);
  });

  it('resolves hasStagedIntentForTask by task_id without scanning staged_intent', () => {
    const plan = planFor(
      `SELECT 1 FROM staged_intent WHERE task_id = @task_id LIMIT 1`,
      { task_id: 'task-1' },
    );
    expect(plan).toContain('idx_staged_intent_task_id');
    expect(plan).not.toMatch(/SCAN staged_intent(?! USING)/);
  });

  it('returns byte-identical results for hasStagedIntentForTask, including a task with no rows', () => {
    insertOpsPrIntent('intent-1');
    expect(hasStagedIntentForTask('task-1')).toBe(true);
    expect(hasStagedIntentForTask('task-none')).toBe(false);
  });

  it('resolves getDenialsBySession by session_id without scanning permission_denials', () => {
    const plan = planFor(
      `SELECT * FROM permission_denials WHERE session_id = @session_id ORDER BY id ASC`,
      { session_id: 'sess-1' },
    );
    expect(plan).toContain('idx_permission_denials_session_id');
    expect(plan).not.toMatch(/SCAN permission_denials(?! USING)/);
  });

  it('returns byte-identical results for getDenialsBySession, including a session with no rows', () => {
    seedSession('sess-1');
    insertPermissionDenial({
      session_id: 'sess-1',
      tool_name: 'Bash',
      tool_use_id: 'tu-1',
      tool_input: '{}',
      timestamp: 1,
    });

    expect(getDenialsBySession('sess-1')).toHaveLength(1);
    expect(getDenialsBySession('sess-none')).toEqual([]);
  });

  it('resolves the pr_intent_id lookup without scanning pull_requests', () => {
    const plan = planFor(
      `SELECT pr_number, repo FROM pull_requests WHERE pr_intent_id = @intent_id`,
      { intent_id: 'intent-1' },
    );
    expect(plan).toContain('idx_pull_requests_pr_intent_id');
    expect(plan).not.toMatch(/SCAN pull_requests(?! USING)/);
  });

  it('returns byte-identical results for linkPRToPRIntent / getPRIntentForPR, including a PR with no linked intent', () => {
    insertPR(1);
    const intent = insertOpsPrIntent('intent-1');
    linkPRToPRIntent(1, 'owner/repo', intent.id);

    expect(getPRIntentForPR(1, 'owner/repo')?.id).toBe('intent-1');

    insertPR(2);
    expect(getPRIntentForPR(2, 'owner/repo')).toBeNull();
  });

  it('session_audits and permission_denials carry a session_id index for the sessions ON DELETE CASCADE', () => {
    // The DELETE FROM sessions statement itself resolves via sessions' own
    // primary key; SQLite then walks every ON DELETE CASCADE child table to
    // enforce the cascade, which is not visible via EXPLAIN QUERY PLAN on
    // the DELETE. Asserting the child index is the closest direct proxy.
    expect(indexNames('session_audits')).toContain(
      'idx_session_audits_session_id',
    );
    expect(indexNames('permission_denials')).toContain(
      'idx_permission_denials_session_id',
    );
  });

  it('deleteSession still cascades session_audits and permission_denials rows', () => {
    seedSession('sess-1');
    insertPermissionDenial({
      session_id: 'sess-1',
      tool_name: 'Bash',
      tool_use_id: 'tu-1',
      tool_input: '{}',
      timestamp: 1,
    });
    insertSessionAudit({
      session_id: 'sess-1',
      pr_opened: 0,
      pr_targets: null,
      task_status: null,
      violations: '[]',
      spec_mismatch: null,
      audited_at: NOW,
    });

    expect(deleteSession('sess-1')).toBe(true);

    expect(getDenialsBySession('sess-1')).toEqual([]);
    expect(
      db
        .prepare(`SELECT * FROM session_audits WHERE session_id = ?`)
        .all('sess-1'),
    ).toEqual([]);
  });
});
