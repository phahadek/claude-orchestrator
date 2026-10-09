/**
 * The breadth corpus excludes the subject's own tree by identity and is
 * evaluated at call time — never by a frozen "first run" cutoff, and never
 * counting a PR-gate run's own earlier history (pr_gate rows carry
 * session_id NULL and the coding session's worktree_path).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import {
  computeTestFailureBreadthFlag,
  evaluateTestFlakinessCorpus,
  getTestRequestRunById,
  insertSession,
  resolveBreadthOwnTree,
} from '../../db/queries';
import { filterBaseAttributableFailuresForF2Gate } from '../baseAttributableFilter';
import type { ProjectConfig } from '../../config';

const PROJECT = { id: 'proj-1', projectDir: '/tmp/x' } as ProjectConfig;
const TEST_ID = 'tests.analysis.test_shared.test_broken_everywhere';
const NOW = Date.now();
const MIN = 60_000;

let seq = 0;

function addSession(opts: {
  id: string;
  taskId: string;
  worktree: string | null;
}): void {
  insertSession({
    session_id: opts.id,
    task_id: opts.taskId,
    task_url: 'https://notion.so/x',
    project_context_url: 'https://notion.so/p',
    project_id: 'proj-1',
    status: 'done',
    started_at: NOW - 60 * MIN,
    worktree_path: opts.worktree,
  } as never);
}

/** Structured-result JSON matching one failing test — readRunTestOutcomes' preferred source. */
function structuredResultFor(testId: string): string {
  return JSON.stringify({
    format: 'junit-xml',
    suites: [
      {
        name: 'suite',
        tests: [
          {
            id: testId,
            name: 'test_broken_everywhere',
            outcome: 'failed',
            durationMs: 1,
          },
        ],
      },
    ],
    totals: { passed: 0, failed: 1, skipped: 0, errors: 0 },
    durationMsTotal: 1000,
  });
}

/** One failing run of TEST_ID in its own tree (distinct content hash). */
function addFailingRun(opts: {
  sessionId: string | null;
  worktree: string | null;
  startedAt: number;
  createdAt?: number;
  testId?: string;
}): string {
  seq += 1;
  const id = `run-${seq}`;
  const testId = opts.testId ?? TEST_ID;
  db.prepare(
    `INSERT INTO test_request_runs
       (id, project_id, content_hash, session_id, state, output, requested_at, started_at, finished_at, worktree_path, structured_result)
     VALUES (@id, 'proj-1', @hash, @session_id, 'failed', '', 0, @started_at, @started_at, @worktree_path, @structured_result)`,
  ).run({
    id,
    hash: `hash-${seq}`,
    session_id: opts.sessionId,
    started_at: opts.startedAt,
    worktree_path: opts.worktree,
    structured_result: structuredResultFor(testId),
  });
  db.prepare(
    `INSERT INTO test_run_results
       (test_request_run_id, project_id, test_id, name, outcome, duration_ms, concurrent_run_count, oom_killed, created_at)
     VALUES (@id, 'proj-1', @test_id, 'test_broken_everywhere', 'failed', 1, 0, 0, @created_at)`,
  ).run({
    id,
    test_id: opts.testId ?? TEST_ID,
    created_at: opts.createdAt ?? opts.startedAt,
  });
  return id;
}

function breadth(ownTree: { sessionIds: string[]; worktreePaths: string[] }) {
  return computeTestFailureBreadthFlag(TEST_ID, 24, 3, Date.now(), ownTree);
}

beforeEach(() => {
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_request_runs').run();
  db.prepare('DELETE FROM sessions').run();
  seq = 0;
});

describe('breadth corpus own-tree exclusion', () => {
  it('excuses a session that started testing before the shared failure reached breadthN trees (frozen-cutoff regression)', async () => {
    addSession({ id: 'S', taskId: 'task-s', worktree: '/wt/S' });
    // S's first run predates every foreign failure.
    addFailingRun({
      sessionId: 'S',
      worktree: '/wt/S',
      startedAt: NOW - 50 * MIN,
    });
    for (let i = 0; i < 3; i++) {
      addFailingRun({
        sessionId: `other-${i}`,
        worktree: `/wt/other-${i}`,
        startedAt: NOW - (40 - i) * MIN,
      });
    }
    const later = addFailingRun({
      sessionId: 'S',
      worktree: '/wt/S',
      startedAt: NOW - 1 * MIN,
    });

    const { result, guardBlocked } =
      await filterBaseAttributableFailuresForF2Gate(
        PROJECT,
        getTestRequestRunById(later)!,
        ['src/unrelated.ts'],
        null,
      );
    expect(guardBlocked).toEqual([]);
    expect(result.outcome).toBe('filtered_pass');
    expect(result.excludedTests.map((t) => t.test_id)).toEqual([TEST_ID]);

    const corpus = evaluateTestFlakinessCorpus(
      TEST_ID,
      NOW - 50 * MIN,
      20,
      2,
      3,
      24,
      resolveBreadthOwnTree('proj-1', { sessionId: 'S' }),
    );
    expect(corpus.eligible).toBe(true);
  });

  it("does not count the subject's own session_request and pr_gate rows (self-inflation regression)", async () => {
    addSession({ id: 'S', taskId: 'task-s', worktree: '/wt/S' });
    addFailingRun({
      sessionId: 'S',
      worktree: '/wt/S',
      startedAt: NOW - 30 * MIN,
    });
    addFailingRun({
      sessionId: 'S',
      worktree: '/wt/S',
      startedAt: NOW - 20 * MIN,
    });
    // pr_gate shape: no session_id, the coding session's worktree.
    addFailingRun({
      sessionId: null,
      worktree: '/wt/S',
      startedAt: NOW - 10 * MIN,
    });
    const prGate = addFailingRun({
      sessionId: null,
      worktree: '/wt/S',
      startedAt: NOW - 1 * MIN,
    });

    const { result } = await filterBaseAttributableFailuresForF2Gate(
      PROJECT,
      getTestRequestRunById(prGate)!,
      ['src/unrelated.ts'],
      null,
    );
    expect(result.outcome).toBe('unfiltered');

    const own = resolveBreadthOwnTree('proj-1', { sessionId: 'S' });
    expect(breadth(own).distinctContentHashCount).toBe(0);
    const corpus = evaluateTestFlakinessCorpus(TEST_ID, NOW, 20, 2, 3, 24, own);
    expect(corpus.eligible).toBe(false);
    expect(corpus.reason).toContain('0/3 distinct other trees');
  });

  it('excludes an earlier session of the same task in a different worktree, whatever the task id spelling', () => {
    addSession({
      id: 'S1',
      taskId: 'notion:11111111-2222-3333-4444-555555555555',
      worktree: '/wt/1',
    });
    addSession({
      id: 'S2',
      taskId: '11111111222233334444555555555555',
      worktree: '/wt/2',
    });
    for (let i = 0; i < 3; i++) {
      addFailingRun({
        sessionId: 'S1',
        worktree: '/wt/1',
        startedAt: NOW - (30 - i) * MIN,
      });
    }

    const own = resolveBreadthOwnTree('proj-1', { sessionId: 'S2' });
    expect(own.sessionIds.sort()).toEqual(['S1', 'S2']);
    expect(own.worktreePaths.sort()).toEqual(['/wt/1', '/wt/2']);
    expect(breadth(own).flagged).toBe(false);

    // A pr_gate subject (no session id) resolves the same task via its worktree.
    const viaWorktree = resolveBreadthOwnTree('proj-1', {
      worktreePath: '/wt/2',
    });
    expect(viaWorktree.sessionIds.sort()).toEqual(['S1', 'S2']);
  });

  it('counts foreign trees from a different task', () => {
    addSession({ id: 'S', taskId: 'task-s', worktree: '/wt/S' });
    for (let i = 0; i < 3; i++) {
      addSession({ id: `T${i}`, taskId: `task-${i}`, worktree: `/wt/T${i}` });
      addFailingRun({
        sessionId: `T${i}`,
        worktree: `/wt/T${i}`,
        startedAt: NOW - (30 - i) * MIN,
      });
    }
    const flag = breadth(resolveBreadthOwnTree('proj-1', { sessionId: 'S' }));
    expect(flag.distinctContentHashCount).toBe(3);
    expect(flag.flagged).toBe(true);
  });

  it('never counts runs with a NULL worktree_path', () => {
    for (let i = 0; i < 3; i++) {
      addFailingRun({
        sessionId: `x-${i}`,
        worktree: null,
        startedAt: NOW - (30 - i) * MIN,
      });
    }
    const flag = breadth({ sessionIds: [], worktreePaths: [] });
    expect(flag.distinctContentHashCount).toBe(0);
  });

  it('counts several runs of one other session (distinct hashes, shared session_id or shared pr_gate worktree) as one origin', () => {
    addSession({ id: 'O', taskId: 'task-o', worktree: '/wt/O' });
    addFailingRun({
      sessionId: 'O',
      worktree: '/wt/O',
      startedAt: NOW - 30 * MIN,
    });
    addFailingRun({
      sessionId: 'O',
      worktree: '/wt/O',
      startedAt: NOW - 20 * MIN,
    });
    addFailingRun({
      sessionId: null,
      worktree: '/wt/O',
      startedAt: NOW - 10 * MIN,
    });
    const flag = breadth({ sessionIds: [], worktreePaths: [] });
    expect(flag.distinctContentHashCount).toBe(1);
    expect(flag.flagged).toBe(false);
  });

  it('excludes the own pr_gate run and own test_request runs as the same origin', () => {
    addSession({ id: 'S', taskId: 'task-s', worktree: '/wt/S' });
    addFailingRun({
      sessionId: 'S',
      worktree: '/wt/S',
      startedAt: NOW - 30 * MIN,
    });
    addFailingRun({
      sessionId: null,
      worktree: '/wt/S',
      startedAt: NOW - 20 * MIN,
    });
    // Same origin even when only the session id is given as the own tree.
    const flag = breadth({ sessionIds: ['S'], worktreePaths: [] });
    expect(flag.distinctContentHashCount).toBe(0);
  });

  it('keys a session-less row with no resolvable session per tree', () => {
    addFailingRun({
      sessionId: null,
      worktree: '/wt/gone-1',
      startedAt: NOW - 30 * MIN,
    });
    addFailingRun({
      sessionId: null,
      worktree: '/wt/gone-2',
      startedAt: NOW - 20 * MIN,
    });
    const flag = breadth({ sessionIds: [], worktreePaths: [] });
    expect(flag.distinctContentHashCount).toBe(2);
  });

  it('falls back to the per-tree origin when a worktree path is shared by several sessions', () => {
    addSession({ id: 'A', taskId: 'task-a', worktree: '/wt/shared' });
    addSession({ id: 'B', taskId: 'task-b', worktree: '/wt/shared' });
    addFailingRun({
      sessionId: null,
      worktree: '/wt/shared',
      startedAt: NOW - 30 * MIN,
    });
    addFailingRun({
      sessionId: null,
      worktree: '/wt/shared',
      startedAt: NOW - 20 * MIN,
    });
    const flag = breadth({ sessionIds: [], worktreePaths: [] });
    expect(flag.distinctContentHashCount).toBe(2);
  });

  it('requires ownTree — omitting it is a type error', () => {
    expect(() =>
      // @ts-expect-error ownTree is required
      computeTestFailureBreadthFlag(TEST_ID, 24, 3, Date.now()),
    ).toThrow();
  });
});
