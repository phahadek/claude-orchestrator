/**
 * GET /api/test-request-runs/project — the project-scope run-history feed
 * the 'tests' TopView destination (frontend follow-on task) consumes: every
 * test_request_runs row for a project, running/queued/finished alike,
 * newest-first, annotated with producer and per-outcome test counts where
 * extraction has already run.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import {
  insertTestRequestRun,
  completeTestRequestRun,
  ingestTestRunResultsTx,
} from '../../db/queries';
import {
  createStagedIntentsRouter,
  setStagedIntentBroadcast,
} from '../stagedIntents';

function makeApp() {
  const app = express();
  app.use(express.json());
  setStagedIntentBroadcast(() => {});
  app.use('/api', createStagedIntentsRouter());
  return app;
}

beforeEach(() => {
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_run_summaries').run();
  db.prepare('DELETE FROM test_request_runs').run();
});

describe('GET /api/test-request-runs/project', () => {
  it('rejects a request missing projectId', async () => {
    const agent = supertest(makeApp());
    const res = await agent.get('/api/test-request-runs/project');
    expect(res.status).toBe(400);
  });

  it('returns running, queued, and finished runs for a project, newest-first, with producer and outcome-count fields populated where available', async () => {
    // Queued: inserted at admission, before its permit was acquired.
    insertTestRequestRun(
      'run-queued',
      'proj-1',
      'hash-queued',
      null,
      1000,
      null,
      null,
      'session_request',
      'queued',
    );
    // Running: currently executing.
    insertTestRequestRun(
      'run-running',
      'proj-1',
      'hash-running',
      'session-1',
      2000,
      0,
      'pr_pipeline',
      'pr_gate',
    );
    // Finished: passed, with an extracted per-outcome breakdown.
    insertTestRequestRun(
      'run-finished',
      'proj-1',
      'hash-finished',
      null,
      3000,
      0,
      'base_health_probe',
      'base_health',
    );
    completeTestRequestRun('run-finished', 'passed', 'ok');
    ingestTestRunResultsTx(
      'run-finished',
      'proj-1',
      [
        { test_id: 't-1', name: 'test one', outcome: 'passed', duration_ms: 5 },
        { test_id: 't-2', name: 'test two', outcome: 'failed', duration_ms: 7 },
      ],
      0,
      false,
      false,
    );
    // A different project's run must never appear in proj-1's feed.
    insertTestRequestRun(
      'run-other-project',
      'proj-2',
      'hash-other',
      null,
      500,
    );

    const agent = supertest(makeApp());
    const res = await agent
      .get('/api/test-request-runs/project')
      .query({ projectId: 'proj-1' });

    expect(res.status).toBe(200);
    expect(res.body.runs.map((r: { id: string }) => r.id)).toEqual([
      'run-finished',
      'run-running',
      'run-queued',
    ]);

    const queued = res.body.runs.find(
      (r: { id: string }) => r.id === 'run-queued',
    );
    expect(queued).toMatchObject({
      state: 'queued',
      producer: 'session_request',
      outcome: 'queued',
      outcomeCounts: null,
    });

    const running = res.body.runs.find(
      (r: { id: string }) => r.id === 'run-running',
    );
    expect(running).toMatchObject({
      state: 'running',
      producer: 'pr_gate',
      runOrigin: 'pr_pipeline',
      outcome: 'running',
      outcomeCounts: null,
    });

    const finished = res.body.runs.find(
      (r: { id: string }) => r.id === 'run-finished',
    );
    expect(finished).toMatchObject({
      state: 'passed',
      producer: 'base_health',
      runOrigin: 'base_health_probe',
      outcome: 'passed',
      outcomeCounts: {
        passed: 1,
        failed: 1,
        skipped: 0,
        error: 0,
        other: 0,
        total: 2,
      },
    });
  });

  it('reports mergedDevSha and conflictOutcome for a run that took a pre-test merge', async () => {
    insertTestRequestRun('run-merged', 'proj-1', 'hash-merged', null, 1000);
    db.prepare(
      `UPDATE test_request_runs SET merged_dev_sha = ?, conflict_outcome = ? WHERE id = ?`,
    ).run('a0455af799f5b1235415c463556fb18be2431b26', 'merged', 'run-merged');

    const res = await supertest(makeApp())
      .get('/api/test-request-runs/project')
      .query({ projectId: 'proj-1' });

    expect(res.status).toBe(200);
    expect(res.body.runs[0]).toMatchObject({
      id: 'run-merged',
      mergedDevSha: 'a0455af799f5b1235415c463556fb18be2431b26',
      conflictOutcome: 'merged',
    });
  });

  it('returns commandStats parsed from command_stats, and null for a row without it', async () => {
    const stats = [
      { command: 'npm run lint', durationMs: 1200, peakRssMb: null },
      { command: 'npx vitest run', durationMs: 45000, peakRssMb: 2048.5 },
    ];
    insertTestRequestRun('run-stats', 'proj-1', 'hash-stats', null, 2000);
    completeTestRequestRun(
      'run-stats',
      'passed',
      'ok',
      null,
      null,
      false,
      undefined,
      null,
      JSON.stringify(stats),
    );
    insertTestRequestRun('run-legacy', 'proj-1', 'hash-legacy', null, 1000);
    completeTestRequestRun('run-legacy', 'passed', 'ok');

    const res = await supertest(makeApp())
      .get('/api/test-request-runs/project')
      .query({ projectId: 'proj-1' });

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(
      res.body.runs.map((r: { id: string }) => [r.id, r]),
    );
    expect(byId['run-stats'].commandStats).toEqual(stats);
    expect(byId['run-legacy'].commandStats).toBeNull();
  });

  it('adds the command_stats column to a populated table, leaving the existing row NULL', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { runMigrations } = await import('../../db/schema');
    const mem = new Database(':memory:');
    mem.exec(
      `CREATE TABLE test_request_runs (id TEXT PRIMARY KEY, project_id TEXT, structured_result TEXT)`,
    );
    mem
      .prepare(
        `INSERT INTO test_request_runs (id, project_id) VALUES ('old', 'p')`,
      )
      .run();
    runMigrations(mem);
    const row = mem
      .prepare(`SELECT command_stats FROM test_request_runs WHERE id = 'old'`)
      .get() as { command_stats: string | null };
    expect(row.command_stats).toBeNull();
  });
});
