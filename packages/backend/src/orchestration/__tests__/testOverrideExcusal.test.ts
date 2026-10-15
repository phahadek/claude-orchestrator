/**
 * An approved test.override excuses its named tests for runs of its owning
 * task only, and stops at the first of: owning task terminal, linked fix task
 * Done, or the task's own tree passing the test.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import {
  getActiveTestOverrideTestIds,
  getTestRequestRunById,
  insertSession,
  resolveBreadthOwnTree,
} from '../../db/queries';
import { normalizeTaskId } from '../../tasks/taskId';
import { filterBaseAttributableFailuresForF2Gate } from '../baseAttributableFilter';
import type { ProjectConfig } from '../../config';

const PROJECT = { id: 'proj-1', projectDir: '/tmp/x' } as ProjectConfig;
const TEST_ID = 'tests.broken.test_not_mine';
const TASK_A = '11111111222233334444555555555555';
const TASK_B = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';
const FIX_TASK = '99999999888877776666555555555555';
const NOW = Date.now();
const MIN = 60_000;
let seq = 0;

function addSession(id: string, taskId: string, worktree: string): void {
  insertSession({
    session_id: id,
    task_id: taskId,
    task_url: 'https://notion.so/x',
    project_context_url: 'https://notion.so/p',
    project_id: 'proj-1',
    status: 'running',
    started_at: NOW - 60 * MIN,
    worktree_path: worktree,
  } as never);
}

function setTaskStatus(taskId: string, status: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO task_cache (task_id, fetched_at, raw_json) VALUES (?, ?, ?)`,
  ).run(normalizeTaskId(taskId), NOW, JSON.stringify({ status }));
}

function addOverride(
  taskId: string,
  extra: { linkedFixTaskId?: string; approvedAt?: number } = {},
): void {
  seq += 1;
  db.prepare(
    `INSERT INTO staged_intent
       (id, kind, payload, payload_hash, task_id, project_id, state, created_at, updated_at)
     VALUES (?, 'test.override', ?, ?, ?, 'proj-1', 'committed', ?, ?)`,
  ).run(
    `ov-${seq}`,
    JSON.stringify({
      taskId,
      testIds: [TEST_ID],
      linkedFixTaskId: extra.linkedFixTaskId,
      evidence: {
        traceReads: 'x',
        targetedRunIds: ['r'],
        investigationNote: 'n',
      },
    }),
    `h-${seq}`,
    taskId,
    NOW - 30 * MIN,
    extra.approvedAt ?? NOW - 30 * MIN,
  );
}

function addRun(
  sessionId: string,
  worktree: string,
  outcome: 'failed' | 'passed',
  at: number,
): string {
  seq += 1;
  const id = `run-${seq}`;
  db.prepare(
    `INSERT INTO test_request_runs
       (id, project_id, content_hash, session_id, state, output, requested_at, started_at, finished_at, worktree_path, structured_result)
     VALUES (@id, 'proj-1', @hash, @session_id, @state, '', 0, @at, @at, @worktree, @sr)`,
  ).run({
    id,
    hash: `hash-${seq}`,
    session_id: sessionId,
    state: outcome,
    at,
    worktree,
    sr: JSON.stringify({
      format: 'junit-xml',
      suites: [
        {
          name: 's',
          tests: [{ id: TEST_ID, name: 'n', outcome, durationMs: 1 }],
        },
      ],
      totals: {
        passed: outcome === 'passed' ? 1 : 0,
        failed: outcome === 'failed' ? 1 : 0,
        skipped: 0,
        errors: 0,
      },
      durationMsTotal: 1,
    }),
  });
  db.prepare(
    `INSERT INTO test_run_results
       (test_request_run_id, project_id, test_id, name, outcome, duration_ms, concurrent_run_count, oom_killed, created_at)
     VALUES (?, 'proj-1', ?, 'n', ?, 1, 0, 0, ?)`,
  ).run(id, TEST_ID, outcome, at);
  return id;
}

const active = (sessionId: string) =>
  getActiveTestOverrideTestIds(
    'proj-1',
    resolveBreadthOwnTree('proj-1', { sessionId }),
  );

beforeEach(() => {
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_request_runs').run();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM task_cache').run();
  db.prepare('DELETE FROM sessions').run();
  seq = 0;
  addSession('SA', TASK_A, '/wt/A');
  addSession('SB', TASK_B, '/wt/B');
  setTaskStatus(TASK_A, '🔨 In Progress');
  setTaskStatus(TASK_B, '🔨 In Progress');
});

describe('test.override excusal', () => {
  it("excuses the named test for the owning task's runs, never another task's", async () => {
    addOverride(TASK_A);
    expect([...active('SA')]).toEqual([TEST_ID]);
    expect([...active('SB')]).toEqual([]);

    const runA = addRun('SA', '/wt/A', 'failed', NOW - MIN);
    const { result } = await filterBaseAttributableFailuresForF2Gate(
      PROJECT,
      getTestRequestRunById(runA)!,
      null,
    );
    expect(result.outcome).toBe('filtered_pass');
    expect(result.overrideExcludedTests?.map((t) => t.test_id)).toEqual([
      TEST_ID,
    ]);
    const marker = db
      .prepare(
        `SELECT excused_reason FROM test_run_results WHERE test_request_run_id = ?`,
      )
      .get(runA) as { excused_reason: string };
    expect(marker.excused_reason).toBe('operator_override');

    const runB = addRun('SB', '/wt/B', 'failed', NOW - MIN);
    const { result: resultB } = await filterBaseAttributableFailuresForF2Gate(
      PROJECT,
      getTestRequestRunById(runB)!,
      null,
    );
    expect(resultB.outcome).toBe('unfiltered');
  });

  describe('mass-breakage guard', () => {
    const manyIds = (n: number) =>
      Array.from({ length: n }, (_, i) => `tests.many.t${i}`);

    function addManyFailingRun(
      sessionId: string,
      worktree: string,
      ids: string[],
    ) {
      seq += 1;
      const id = `run-${seq}`;
      db.prepare(
        `INSERT INTO test_request_runs
           (id, project_id, content_hash, session_id, state, output, requested_at, started_at, finished_at, worktree_path, structured_result)
         VALUES (@id, 'proj-1', @hash, @session_id, 'failed', '', 0, @at, @at, @worktree, @sr)`,
      ).run({
        id,
        hash: `hash-${seq}`,
        session_id: sessionId,
        at: NOW - MIN,
        worktree,
        sr: JSON.stringify({
          format: 'junit-xml',
          suites: [
            {
              name: 's',
              tests: ids.map((t) => ({
                id: t,
                name: t,
                outcome: 'failed',
                durationMs: 1,
              })),
            },
          ],
          totals: { passed: 0, failed: ids.length, skipped: 0, errors: 0 },
          durationMsTotal: 1,
        }),
      });
      const ins = db.prepare(
        `INSERT INTO test_run_results
           (test_request_run_id, project_id, test_id, name, outcome, duration_ms, concurrent_run_count, oom_killed, created_at)
         VALUES (?, 'proj-1', ?, 'n', 'failed', 1, 0, 0, ?)`,
      );
      for (const t of ids) ins.run(id, t, NOW - MIN);
      return id;
    }

    function addOverrideFor(taskId: string, ids: string[]) {
      seq += 1;
      db.prepare(
        `INSERT INTO staged_intent
           (id, kind, payload, payload_hash, task_id, project_id, state, created_at, updated_at)
         VALUES (?, 'test.override', ?, ?, ?, 'proj-1', 'committed', ?, ?)`,
      ).run(
        `ov-${seq}`,
        JSON.stringify({ taskId, testIds: ids }),
        `h-${seq}`,
        taskId,
        NOW - 30 * MIN,
        NOW - 30 * MIN,
      );
    }

    it('flips when overrides cover every failure and the count is within the threshold', async () => {
      const ids = manyIds(20);
      addOverrideFor(TASK_A, ids);
      const run = addManyFailingRun('SA', '/wt/A', ids);
      const { result } = await filterBaseAttributableFailuresForF2Gate(
        PROJECT,
        getTestRequestRunById(run)!,
        null,
      );
      expect(result.outcome).toBe('filtered_pass');
    });

    it('never flips a mass-broken run even when overrides cover every failure', async () => {
      const ids = manyIds(21);
      addOverrideFor(TASK_A, ids);
      const run = addManyFailingRun('SA', '/wt/A', ids);
      const { result } = await filterBaseAttributableFailuresForF2Gate(
        PROJECT,
        getTestRequestRunById(run)!,
        null,
      );
      expect(result.outcome).not.toBe('filtered_pass');
      expect(result.passed).toBe(false);
      expect(result.overrideExcludedTests ?? []).toEqual([]);
    });

    it("does not excuse another task's or an expired override on replay", async () => {
      const ids = manyIds(3);
      addOverrideFor(TASK_B, ids);
      const runA = addManyFailingRun('SA', '/wt/A', ids);
      const { result } = await filterBaseAttributableFailuresForF2Gate(
        PROJECT,
        getTestRequestRunById(runA)!,
        null,
      );
      expect(result.outcome).toBe('unfiltered');

      addOverrideFor(TASK_A, ids);
      setTaskStatus(TASK_A, '✅ Done');
      const runA2 = addManyFailingRun('SA', '/wt/A', ids);
      const { result: expired } = await filterBaseAttributableFailuresForF2Gate(
        PROJECT,
        getTestRequestRunById(runA2)!,
        null,
      );
      expect(expired.outcome).toBe('unfiltered');
    });
  });

  it('is not active before it is approved (staged rows excuse nothing)', () => {
    addOverride(TASK_A);
    db.prepare(`UPDATE staged_intent SET state = 'staged'`).run();
    expect(active('SA').size).toBe(0);
  });

  it('stops once the owning task reaches a terminal state', () => {
    addOverride(TASK_A);
    expect(active('SA').size).toBe(1);
    setTaskStatus(TASK_A, '✅ Done');
    expect(active('SA').size).toBe(0);
  });

  it('stops once the linked fix task reaches Done', () => {
    addOverride(TASK_A, { linkedFixTaskId: FIX_TASK });
    setTaskStatus(FIX_TASK, '🔨 In Progress');
    expect(active('SA').size).toBe(1);
    setTaskStatus(FIX_TASK, '✅ Done');
    expect(active('SA').size).toBe(0);
  });

  it("stops once the task's own tree passes the test after approval", () => {
    addOverride(TASK_A);
    addRun('SA', '/wt/A', 'passed', NOW - 40 * MIN); // before approval: ignored
    expect(active('SA').size).toBe(1);
    addRun('SB', '/wt/B', 'passed', NOW - MIN); // another task's pass: ignored
    expect(active('SA').size).toBe(1);
    addRun('SA', '/wt/A', 'passed', NOW - MIN);
    expect(active('SA').size).toBe(0);
  });
});
