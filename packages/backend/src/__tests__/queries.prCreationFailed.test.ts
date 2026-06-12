import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  const db = setupTestDb();
  db.prepare(
    `INSERT INTO projects (id, name, project_dir, github_repo, task_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('proj-1', 'Test Project', '/test', 'owner/repo', 'notion', 1000, 1000);
  return { db };
});

import {
  getActiveTaskAggregates,
  upsertTaskCache,
  insertSession,
  upsertPullRequest,
  setSessionPauseReason,
} from '../db/queries.js';

const TASK_ID = 'notion:33722f91-52f3-816b-967f-c7f230b215ca';
const NOW = '2024-01-01T00:00:00Z';

function makeSession(opts: {
  session_id: string;
  task_id: string;
  started_at?: number;
}) {
  return {
    session_id: opts.session_id,
    task_id: opts.task_id,
    task_url: `https://www.notion.so/${opts.task_id}`,
    project_context_url: 'https://www.notion.so/context',
    project_id: 'proj-1',
    status: 'done',
    started_at: opts.started_at ?? 1000,
    ended_at: null,
    pr_url: null,
    worktree_path: null,
    session_type: 'standard',
    task_name: null,
  };
}

function makePR(opts: { pr_number: number; task_id: string }) {
  return {
    pr_number: opts.pr_number,
    pr_url: `https://github.com/owner/repo/pull/${opts.pr_number}`,
    task_id: opts.task_id,
    session_id: null,
    repo: 'owner/repo',
    title: `PR ${opts.pr_number}`,
    body: null,
    head_branch: 'feature/x',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: null,
    review_at: null,
    created_at: NOW,
    updated_at: NOW,
    synced_at: NOW,
    review_iteration: 0,
    review_session_id: null,
    head_sha: null,
    last_reviewed_sha: null,
    node_id: null,
  };
}

beforeEach(async () => {
  const { db } = await import('../db/db.js');
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM task_cache').run();
  db.prepare('DELETE FROM pull_requests').run();
});

function setupTask() {
  upsertTaskCache(
    TASK_ID,
    JSON.stringify({
      id: TASK_ID,
      title: 'Test Task',
      status: '🔄 In Progress',
    }),
  );
}

// ── Gate (a) + Gate (b): exhausted failure, no PR → surfaces session reason ──

describe('getActiveTaskAggregates — pr_creation_failed two-gate surface', () => {
  it('surfaces session pause_reason when no PR and latest session has pr_creation_failed', () => {
    setupTask();
    insertSession(makeSession({ session_id: 'sess-1', task_id: TASK_ID }));
    setSessionPauseReason('sess-1', 'pr_creation_failed');

    const [row] = getActiveTaskAggregates([TASK_ID]);
    expect(row.session_pr_creation_failed_pause_reason).toBe(
      'pr_creation_failed',
    );
    expect(row.pr_pause_reason).toBeNull();
  });

  it('gate (a): does NOT surface when a PR row exists, even with session reason stored', () => {
    setupTask();
    insertSession(makeSession({ session_id: 'sess-1', task_id: TASK_ID }));
    setSessionPauseReason('sess-1', 'pr_creation_failed');
    upsertPullRequest(makePR({ pr_number: 42, task_id: TASK_ID }));

    const [row] = getActiveTaskAggregates([TASK_ID]);
    expect(row.session_pr_creation_failed_pause_reason).toBeNull();
    expect(row.pr_number).toBe(42);
  });

  it('gate (b): does NOT surface when latest session pause_reason is null', () => {
    setupTask();
    insertSession(makeSession({ session_id: 'sess-1', task_id: TASK_ID }));
    // No setSessionPauseReason call → pause_reason stays null

    const [row] = getActiveTaskAggregates([TASK_ID]);
    expect(row.session_pr_creation_failed_pause_reason).toBeNull();
  });

  it('gate (b): after relaunch, newer session with null reason clears the surface', () => {
    setupTask();
    // Older session failed
    insertSession(
      makeSession({ session_id: 'sess-1', task_id: TASK_ID, started_at: 1000 }),
    );
    setSessionPauseReason('sess-1', 'pr_creation_failed');
    // Newer session launched (no failure yet)
    insertSession(
      makeSession({ session_id: 'sess-2', task_id: TASK_ID, started_at: 2000 }),
    );

    const [row] = getActiveTaskAggregates([TASK_ID]);
    expect(row.session_pr_creation_failed_pause_reason).toBeNull();
    expect(row.code_session_id).toBe('sess-2');
  });

  it('gate (b): if newer session also fails terminally, surfaces again', () => {
    setupTask();
    insertSession(
      makeSession({ session_id: 'sess-1', task_id: TASK_ID, started_at: 1000 }),
    );
    setSessionPauseReason('sess-1', 'pr_creation_failed');
    insertSession(
      makeSession({ session_id: 'sess-2', task_id: TASK_ID, started_at: 2000 }),
    );
    setSessionPauseReason('sess-2', 'pr_creation_failed');

    const [row] = getActiveTaskAggregates([TASK_ID]);
    expect(row.session_pr_creation_failed_pause_reason).toBe(
      'pr_creation_failed',
    );
    expect(row.code_session_id).toBe('sess-2');
  });
});
