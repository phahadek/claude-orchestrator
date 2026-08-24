/**
 * Point-in-time reconstruction instrumentation: every UPDATE-in-place write
 * path on sessions/pull_requests/gate_item/deploy_run must leave an
 * audit_log row carrying old value, new value, and a timestamp — otherwise
 * a past-T read of that column is unrecoverable. This does not test the
 * reconstruction API itself (that's a separate follow-on task) — only that
 * the audit trail exists for every write path enumerated in the task spec.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  insertSession,
  updateSessionStatus,
  markSessionDone,
  markSessionIdle,
  markSessionSuperseded,
  updatePRState,
  updateMergeState,
  setPauseReason,
  setPRReviewResult,
  insertGateItem,
  updateGateItemMinDeployedCommit,
  updateGateItemPendingSchedule,
  insertDeployRun,
  updateDeployRunStatus,
} from '../queries.js';

function auditEvents(
  eventType: string,
): Array<{ payload: string; task_id: string | null }> {
  return db
    .prepare(`SELECT payload, task_id FROM audit_log WHERE event_type = ?`)
    .all(eventType) as Array<{ payload: string; task_id: string | null }>;
}

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM pull_requests').run();
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM deploy_run').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('sessions.status instrumentation', () => {
  const SESSION_ID = 'sess-1';

  function seedSession(status: string): void {
    insertSession({
      session_id: SESSION_ID,
      task_id: 'task-1',
      task_url: 'https://example.com/task-1',
      project_context_url: null,
      status,
      started_at: Date.now(),
    });
  }

  it('records session_status_changed on updateSessionStatus', () => {
    seedSession('starting');
    updateSessionStatus(SESSION_ID, 'running');
    const events = auditEvents('session_status_changed');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      from: 'starting',
      to: 'running',
    });
    expect(events[0].task_id).toBe('task-1');
  });

  it('does not record an event when the status is unchanged', () => {
    seedSession('running');
    updateSessionStatus(SESSION_ID, 'running');
    expect(auditEvents('session_status_changed')).toHaveLength(0);
  });

  it('records session_status_changed on markSessionDone', () => {
    seedSession('idle');
    markSessionDone(SESSION_ID, Date.now(), null, 'test');
    const events = auditEvents('session_status_changed');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      from: 'idle',
      to: 'done',
    });
  });

  it('records session_status_changed on markSessionIdle', () => {
    seedSession('running');
    markSessionIdle(SESSION_ID, Date.now(), null);
    const events = auditEvents('session_status_changed');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      from: 'running',
      to: 'idle',
    });
  });

  it('records session_status_changed on markSessionSuperseded', () => {
    seedSession('running');
    markSessionSuperseded(SESSION_ID, Date.now());
    const events = auditEvents('session_status_changed');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      from: 'running',
      to: 'superseded',
    });
  });
});

describe('pull_requests field instrumentation', () => {
  const REPO = 'owner/repo';
  const PR_NUMBER = 42;

  function seedPR(overrides: Record<string, unknown> = {}): void {
    db.prepare(
      `
      INSERT INTO pull_requests
        (pr_number, pr_url, task_id, repo, state, draft, review_result, review_at,
         created_at, updated_at, synced_at, mergeable, merge_state, pause_reason)
      VALUES
        (@pr_number, @pr_url, @task_id, @repo, @state, 0, @review_result, NULL,
         '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z',
         @mergeable, @merge_state, @pause_reason)
    `,
    ).run({
      pr_number: PR_NUMBER,
      pr_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
      task_id: 'task-pr-1',
      repo: REPO,
      state: 'open',
      review_result: null,
      mergeable: null,
      merge_state: null,
      pause_reason: null,
      ...overrides,
    });
  }

  it('records pr_state_changed on updatePRState', () => {
    seedPR();
    updatePRState(PR_NUMBER, REPO, 'merged');
    const events = auditEvents('pr_state_changed');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      from: 'open',
      to: 'merged',
    });
  });

  it('records pr_merge_state_changed on updateMergeState', () => {
    seedPR();
    updateMergeState(PR_NUMBER, REPO, 1, 'clean');
    const events = auditEvents('pr_merge_state_changed');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      from_mergeable: null,
      to_mergeable: 1,
      from_merge_state: null,
      to_merge_state: 'clean',
    });
  });

  it('records pr_pause_reason_changed on setPauseReason', () => {
    seedPR();
    setPauseReason(PR_NUMBER, REPO, 'merge_conflict');
    const events = auditEvents('pr_pause_reason_changed');
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].payload);
    expect(payload.from).toBeNull();
    expect(payload.to).toContain('merge_conflict');
  });

  it('records pr_review_result_changed on setPRReviewResult', () => {
    seedPR();
    setPRReviewResult(PR_NUMBER, REPO, JSON.stringify({ verdict: 'approved' }));
    const events = auditEvents('pr_review_result_changed');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({ from: null });
  });
});

describe('gate_item schedule/min_deployed_commit instrumentation', () => {
  const GATE_ITEM_ID = 'gate-1';

  function seedGateItem(): void {
    insertGateItem({
      id: GATE_ITEM_ID,
      project: 'proj-1',
      milestone: 'm1',
      text: 'some gate item',
      classification: 'Human-Observation',
      min_deployed_commit: null,
      state: 'pending',
      current_disposition: null,
      latest_disposition: null,
      next_attempt_at: null,
      pending_attempt_count: 0,
      updated_at: '2024-01-01T00:00:00Z',
    });
  }

  it('records gate_item_min_deployed_commit_changed', () => {
    seedGateItem();
    updateGateItemMinDeployedCommit(
      GATE_ITEM_ID,
      'abc123',
      '2024-01-02T00:00:00Z',
    );
    const events = auditEvents('gate_item_min_deployed_commit_changed');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      gate_item_id: GATE_ITEM_ID,
      from: null,
      to: 'abc123',
    });
  });

  it('records gate_item_schedule_changed', () => {
    seedGateItem();
    updateGateItemPendingSchedule(
      GATE_ITEM_ID,
      '2024-01-02T00:00:00Z',
      1,
      '2024-01-02T00:00:00Z',
    );
    const events = auditEvents('gate_item_schedule_changed');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      gate_item_id: GATE_ITEM_ID,
      from_next_attempt_at: null,
      to_next_attempt_at: '2024-01-02T00:00:00Z',
      from_pending_attempt_count: 0,
      to_pending_attempt_count: 1,
    });
  });
});

describe('deploy_run.status instrumentation', () => {
  const RUN_ID = 'run-1';

  function seedDeployRun(): void {
    insertDeployRun({
      run_id: RUN_ID,
      project: 'proj-1',
      kind: 'deploy',
      target_sha: 'sha-1',
      current_step: null,
      status: 'running',
      started_at: '2024-01-01T00:00:00Z',
      completed_at: null,
    });
  }

  it('records deploy_run_status_changed on failure completion', () => {
    seedDeployRun();
    updateDeployRunStatus(RUN_ID, 'failed', '2024-01-02T00:00:00Z');
    const events = auditEvents('deploy_run_status_changed');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      run_id: RUN_ID,
      from: 'running',
      to: 'failed',
    });
  });

  it('records deploy_run_status_changed on succeeded completion', () => {
    seedDeployRun();
    updateDeployRunStatus(RUN_ID, 'succeeded', '2024-01-02T00:00:00Z');
    const events = auditEvents('deploy_run_status_changed');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      run_id: RUN_ID,
      from: 'running',
      to: 'succeeded',
    });
  });
});
