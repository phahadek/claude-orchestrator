/**
 * GET /api/test-request-runs/history must surface the PR pipeline's own
 * finished full-suite runs (session_id NULL, run_origin='pr_pipeline')
 * alongside a session's own runs, for the same worktree — otherwise an
 * operator's Tests tab shows nothing for a full gate the PR pipeline
 * actually ran (see Polimarket PR #1671).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { createStagedIntentsRouter } from '../stagedIntents';
import { insertSession, insertTestRequestRun, completeTestRequestRun } from '../../db/queries';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

const PROJECT_ID = 'proj-pr-pipeline';
const SESSION_ID = 'session-pr-pipeline';
const WORKTREE_PATH = '/srv/worktrees/session-pr-pipeline';

beforeEach(() => {
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_request_runs').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM session_test_request_cycles').run();

  insertSession({
    session_id: SESSION_ID,
    task_id: 'task-1',
    task_url: null,
    project_context_url: null,
    project_id: PROJECT_ID,
    status: 'running',
    started_at: Date.now(),
    worktree_path: WORKTREE_PATH,
  });
});

describe('GET /api/test-request-runs/history — pr_pipeline visibility', () => {
  it("returns pr_pipeline rows for the session's worktree alongside the session's own rows, newest first", async () => {
    insertTestRequestRun(
      'run-own',
      PROJECT_ID,
      'hash-1',
      SESSION_ID,
      1000,
      null,
      undefined,
      undefined,
      'running',
      'scoped',
      null,
      WORKTREE_PATH,
    );
    completeTestRequestRun('run-own', 'failed', '', 'generic');

    insertTestRequestRun(
      'run-pipeline',
      PROJECT_ID,
      'hash-1',
      null,
      2000,
      null,
      'pr_pipeline',
      undefined,
      'running',
      'full',
      null,
      WORKTREE_PATH,
    );
    completeTestRequestRun('run-pipeline', 'passed', 'ok');

    const app = buildApp();
    const res = await supertest(app)
      .get('/api/test-request-runs/history')
      .query({ projectId: PROJECT_ID, sessionId: SESSION_ID });

    expect(res.status).toBe(200);
    expect(res.body.runs.map((r: { id: string }) => r.id)).toEqual([
      'run-pipeline',
      'run-own',
    ]);
    const pipelineRun = res.body.runs.find(
      (r: { id: string }) => r.id === 'run-pipeline',
    );
    expect(pipelineRun.sessionId).toBeNull();
    expect(pipelineRun.isPrPipelineRun).toBe(true);
    expect(pipelineRun.runKind).toBe('full');

    const ownRun = res.body.runs.find((r: { id: string }) => r.id === 'run-own');
    expect(ownRun.isPrPipelineRun).toBe(false);
  });

  it('does not return a pr_pipeline row from a different worktree', async () => {
    insertTestRequestRun(
      'run-other-worktree',
      PROJECT_ID,
      'hash-1',
      null,
      1000,
      null,
      'pr_pipeline',
      undefined,
      'running',
      'full',
      null,
      '/some/other/worktree',
    );
    completeTestRequestRun('run-other-worktree', 'passed', 'ok');

    const app = buildApp();
    const res = await supertest(app)
      .get('/api/test-request-runs/history')
      .query({ projectId: PROJECT_ID, sessionId: SESSION_ID });

    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(0);
  });
});
