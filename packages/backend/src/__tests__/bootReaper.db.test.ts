/**
 * DB-level regression tests for the boot reaper queries.
 *
 * Root cause: getStuckResultSessionRows() filtered event_type='result' but
 * production events are stored with event_type='system' and payload.type='result'.
 * The mismatch meant the query matched nothing in production — sessions were never
 * reaped on boot and got resumed as orphans instead.
 *
 * These tests use a real in-memory SQLite DB via setupTestDb() to verify that:
 * AC1: getStuckResultSessionRows() matches production-shaped events (event_type='system',
 *      payload.type='result'), NOT the old synthetic event_type='result'.
 * AC3: getRunningSessionsWithMergedOrClosedPR() finds running sessions with
 *      merged/closed PRs in pull_requests or local_branches tables.
 * AC5: A genuinely-incomplete orphan (no terminal event, PR open) is NOT matched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import {
  getStuckResultSessionRows,
  getRunningSessionsWithMergedOrClosedPR,
} from '../db/queries.js';

function insertSession(
  sessionId: string,
  status = 'running',
  prUrl: string | null = null,
): void {
  db.prepare(
    `INSERT INTO sessions
       (session_id, project_id, task_id, task_url, project_context_url,
        status, started_at, session_type, worktree_path, pr_url)
     VALUES (?, 'proj-1', 'task-1', 'https://notion.so/task', 'https://notion.so/ctx',
       ?, ?, 'standard', '/fake/wt', ?)`,
  ).run(sessionId, status, Date.now() - 10 * 60 * 1000, prUrl);
}

function insertEvent(
  sessionId: string,
  eventType: string,
  payload: string,
): void {
  db.prepare(
    `INSERT INTO session_events (session_id, event_type, payload, timestamp)
     VALUES (?, ?, ?, ?)`,
  ).run(sessionId, eventType, payload, Date.now() - 5 * 60 * 1000);
}

beforeEach(() => {
  db.prepare('DELETE FROM local_branches').run();
  db.prepare('DELETE FROM pull_requests').run();
  db.prepare('DELETE FROM session_events').run();
  db.prepare('DELETE FROM sessions').run();
});

// ── AC1: production-shaped event fixture ──────────────────────────────────────

describe('getStuckResultSessionRows() — production event shape', () => {
  it('matches a running session whose last event is event_type=system with payload.type=result', () => {
    insertSession('sess-prod');
    insertEvent('sess-prod', 'system', '{"type":"result","subtype":"success"}');

    const rows = getStuckResultSessionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe('sess-prod');
  });

  it('does NOT match a session whose last event has synthetic event_type=result (old test fixture shape)', () => {
    insertSession('sess-synthetic');
    insertEvent('sess-synthetic', 'result', '{}');

    const rows = getStuckResultSessionRows();
    expect(rows).toHaveLength(0);
  });

  it('does NOT match a running session whose last event is a non-result system event', () => {
    insertSession('sess-running');
    insertEvent(
      'sess-running',
      'system',
      '{"type":"assistant","content":"hello"}',
    );

    const rows = getStuckResultSessionRows();
    expect(rows).toHaveLength(0);
  });

  it('does NOT match a session that is already done', () => {
    insertSession('sess-done', 'done');
    insertEvent('sess-done', 'system', '{"type":"result"}');

    const rows = getStuckResultSessionRows();
    expect(rows).toHaveLength(0);
  });

  it('respects minAgeMs — excludes a session younger than the threshold', () => {
    // Insert a session started only 1 minute ago
    db.prepare(
      `INSERT INTO sessions
         (session_id, project_id, task_id, task_url, project_context_url,
          status, started_at, session_type, worktree_path)
       VALUES ('sess-young', 'proj-1', 'task-1', 'https://notion.so/task', 'https://notion.so/ctx',
         'running', ?, 'standard', '/fake/wt')`,
    ).run(Date.now() - 1 * 60 * 1000);
    insertEvent('sess-young', 'system', '{"type":"result"}');

    const rows = getStuckResultSessionRows(5 * 60 * 1000);
    expect(rows).toHaveLength(0);
  });

  it('respects minAgeMs — includes a session older than the threshold', () => {
    insertSession('sess-old');
    insertEvent('sess-old', 'system', '{"type":"result"}');

    const rows = getStuckResultSessionRows(5 * 60 * 1000);
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe('sess-old');
  });
});

// ── AC3: merged/closed PR reaping ────────────────────────────────────────────

describe('getRunningSessionsWithMergedOrClosedPR()', () => {
  it('finds a running session whose PR state is merged (pull_requests table)', () => {
    insertSession('sess-merged', 'running', 'https://github.com/o/r/pull/1');
    db.prepare(
      `INSERT INTO pull_requests
         (pr_number, pr_url, task_id, session_id, repo, state, draft, synced_at, created_at, updated_at)
       VALUES (1, 'https://github.com/o/r/pull/1', 'task-1', 'sess-merged',
         'o/r', 'merged', 0, datetime('now'), datetime('now'), datetime('now'))`,
    ).run();

    const rows = getRunningSessionsWithMergedOrClosedPR();
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe('sess-merged');
  });

  it('finds a running session whose PR state is closed (pull_requests table)', () => {
    insertSession('sess-closed', 'running', 'https://github.com/o/r/pull/2');
    db.prepare(
      `INSERT INTO pull_requests
         (pr_number, pr_url, task_id, session_id, repo, state, draft, synced_at, created_at, updated_at)
       VALUES (2, 'https://github.com/o/r/pull/2', 'task-1', 'sess-closed',
         'o/r', 'closed', 0, datetime('now'), datetime('now'), datetime('now'))`,
    ).run();

    const rows = getRunningSessionsWithMergedOrClosedPR();
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe('sess-closed');
  });

  it('finds a running session with a merged local branch (local-only case)', () => {
    insertSession('sess-local');
    db.prepare(
      `INSERT INTO local_branches
         (project_id, session_id, branch_name, base_branch, status, review_result, created_at, updated_at)
       VALUES ('proj-1', 'sess-local', 'feature/x', 'dev', 'merged', NULL,
         datetime('now'), datetime('now'))`,
    ).run();

    const rows = getRunningSessionsWithMergedOrClosedPR();
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe('sess-local');
  });

  it('does NOT include a running session with an open PR (AC5 — genuinely incomplete)', () => {
    insertSession('sess-open', 'running', 'https://github.com/o/r/pull/3');
    db.prepare(
      `INSERT INTO pull_requests
         (pr_number, pr_url, task_id, session_id, repo, state, draft, synced_at, created_at, updated_at)
       VALUES (3, 'https://github.com/o/r/pull/3', 'task-1', 'sess-open',
         'o/r', 'open', 1, datetime('now'), datetime('now'), datetime('now'))`,
    ).run();

    const rows = getRunningSessionsWithMergedOrClosedPR();
    expect(rows).toHaveLength(0);
  });

  it('does NOT include a session that is already done', () => {
    insertSession('sess-done', 'done', 'https://github.com/o/r/pull/4');
    db.prepare(
      `INSERT INTO pull_requests
         (pr_number, pr_url, task_id, session_id, repo, state, draft, synced_at, created_at, updated_at)
       VALUES (4, 'https://github.com/o/r/pull/4', 'task-1', 'sess-done',
         'o/r', 'merged', 0, datetime('now'), datetime('now'), datetime('now'))`,
    ).run();

    const rows = getRunningSessionsWithMergedOrClosedPR();
    expect(rows).toHaveLength(0);
  });

  it('does NOT include a running session with no PR at all', () => {
    insertSession('sess-no-pr');

    const rows = getRunningSessionsWithMergedOrClosedPR();
    expect(rows).toHaveLength(0);
  });
});
