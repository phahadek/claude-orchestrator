import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const filterMock = vi.hoisted(() => vi.fn());
vi.mock('../baseAttributableFilter', () => ({
  filterBaseAttributableFailuresForF2Gate: filterMock,
}));
const getChangedFilesMock = vi.hoisted(() => vi.fn());
vi.mock('../../session/autofix-runner', () => ({
  getChangedFiles: getChangedFilesMock,
}));
vi.mock('../../config', () => ({
  getProjectById: vi.fn(() => ({ id: 'proj-1', baseBranch: 'dev' })),
}));

import { db } from '../../db/db';
import {
  insertSession,
  insertTestRequestRun,
  markTestRequestRunAwaitingDisposition,
  listUndeliveredInboxItems,
  getTestRequestRunById,
  listAwaitingDispositionRuns,
  enqueueFeedbackItem,
} from '../../db/queries';
import { getChangedFiles } from '../../session/autofix-runner';
import {
  evaluateSubject,
  sweepConfirmedWaiting,
  REATTRIBUTION_FEEDBACK_SOURCE,
  ATTRIBUTION_WAIT_WAKE_SOURCE,
} from '../reattributionService';

const NOW = Date.now();
const WT = fs.mkdtempSync(path.join(os.tmpdir(), 'reattr-wt-'));
afterAll(() => fs.rmSync(WT, { recursive: true, force: true }));

function addSession(
  id: string,
  status = 'running',
  worktree: string | null = WT,
): void {
  insertSession({
    session_id: id,
    task_id: `task-${id}`,
    task_url: 'https://notion.so/x',
    project_context_url: 'https://notion.so/p',
    project_id: 'proj-1',
    status,
    started_at: NOW,
    worktree_path: worktree,
  } as never);
}

function addWaitingRun(runId: string, sessionId: string, waiting = true): void {
  insertTestRequestRun(runId, 'proj-1', `hash-${runId}`, sessionId, NOW);
  db.prepare(`UPDATE test_request_runs SET state = 'failed' WHERE id = ?`).run(
    runId,
  );
  if (waiting) markTestRequestRunAwaitingDisposition(runId);
}

const fullExcuse = {
  result: {
    outcome: 'filtered_pass',
    passed: true,
    excludedTests: [{ test_id: 't1', name: 't1' }],
    flakyExcludedTests: [],
    remainingTests: [],
    baseRun: null,
  },
  guardBlocked: [],
};

beforeEach(() => {
  db.exec(
    `DELETE FROM session_feedback_inbox; DELETE FROM test_run_results; DELETE FROM test_request_runs; DELETE FROM sessions;`,
  );
  filterMock.mockReset();
  filterMock.mockResolvedValue(fullExcuse);
  getChangedFilesMock.mockReset();
  getChangedFilesMock.mockResolvedValue(['src/a.ts']);
  addSession('s1');
  addSession('s2');
});

describe('reattributionService', () => {
  it('wakes a run at most once when ingest and sweep observe the same transition concurrently', async () => {
    addWaitingRun('r1', 's1');
    const deliver = vi.fn(async () => {});
    const sink = { deliverReattributionWake: deliver };

    const outcomes = await Promise.all([
      evaluateSubject('r1', sink),
      sweepConfirmedWaiting(sink),
      evaluateSubject('r1', sink),
    ]);

    expect(getTestRequestRunById('r1')?.state).toBe('passed');
    const rows = listUndeliveredInboxItems('s1').filter(
      (i) => i.source === REATTRIBUTION_FEEDBACK_SOURCE,
    );
    expect(rows).toHaveLength(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(outcomes).toBeDefined();
  });

  it('sweeps only the confirmed-waiting marker set', async () => {
    addWaitingRun('r-wait', 's1');
    addWaitingRun('r-nomarker', 's2', false);
    expect(listAwaitingDispositionRuns().map((r) => r.id)).toEqual(['r-wait']);

    await sweepConfirmedWaiting(null);

    expect(getTestRequestRunById('r-nomarker')?.state).toBe('failed');
    expect(listUndeliveredInboxItems('s2')).toHaveLength(0);
    expect(filterMock).toHaveBeenCalledTimes(1);
  });

  it('excludes terminal and missing-session runs but keeps idle ones, reporting evaluated/woken', async () => {
    for (const [sid, status] of [
      ['s-idle', 'idle'],
      ['s-done', 'done'],
      ['s-err', 'error'],
      ['s-kill', 'killed'],
    ] as const) {
      addSession(sid);
      db.prepare(`UPDATE sessions SET status = ? WHERE session_id = ?`).run(
        status,
        sid,
      );
      addWaitingRun(`r-${sid}`, sid);
    }
    db.pragma('foreign_keys = OFF');
    addWaitingRun('r-orphan', 'no-such-session');
    db.pragma('foreign_keys = ON');

    expect(listAwaitingDispositionRuns().map((r) => r.id)).toEqual([
      'r-s-idle',
    ]);
    expect(
      listAwaitingDispositionRuns({ failingTestIds: ['t1'] }),
    ).toBeDefined();

    const res = await sweepConfirmedWaiting(null);
    expect(res).toEqual({ items_processed: 1, evaluated: 1 });
    expect(getTestRequestRunById('r-s-idle')?.state).toBe('passed');
    expect(listUndeliveredInboxItems('s-idle')).toHaveLength(1);
    expect(getTestRequestRunById('r-s-done')?.state).toBe('failed');
  });

  it('leaves the wake durably in the inbox when delivery crashes, with no duplicate on re-evaluation', async () => {
    addWaitingRun('r1', 's1');
    const sink = {
      deliverReattributionWake: vi.fn(async () => {
        throw new Error('crash after commit');
      }),
    };
    expect(await evaluateSubject('r1', sink)).toBe('woken');

    // Boot reconcile / retry sweep reads the same durable row.
    expect(listUndeliveredInboxItems('s1')).toHaveLength(1);

    // A later sweep tick re-observes nothing: the run left the subject set.
    expect(await evaluateSubject('r1', sink)).toBe('skipped');
    await sweepConfirmedWaiting(sink);
    expect(listUndeliveredInboxItems('s1')).toHaveLength(1);
    expect(sink.deliverReattributionWake).toHaveBeenCalledTimes(1);
  });

  it('skips (excuses nothing, no flip, no wake) when the worktree path does not exist', async () => {
    const actual = await vi.importActual<
      typeof import('../../session/autofix-runner')
    >('../../session/autofix-runner');
    getChangedFilesMock.mockImplementation(actual.getChangedFiles);
    db.prepare(
      `UPDATE sessions SET worktree_path = '/nonexistent/worktree/path' WHERE session_id = 's1'`,
    ).run();
    addWaitingRun('r1', 's1');
    const deliver = vi.fn(async () => {});

    expect(
      await evaluateSubject('r1', { deliverReattributionWake: deliver }),
    ).toBe('skipped');

    expect(filterMock).not.toHaveBeenCalled();
    expect(getTestRequestRunById('r1')?.state).toBe('failed');
    expect(listUndeliveredInboxItems('s1')).toHaveLength(0);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('does not flip or wake on a partial excuse', async () => {
    addWaitingRun('r1', 's1');
    filterMock.mockResolvedValue({
      ...fullExcuse,
      result: {
        ...fullExcuse.result,
        outcome: 'filtered_partial',
        passed: false,
      },
    });
    expect(await evaluateSubject('r1', null)).toBe('not_excused');
    expect(getTestRequestRunById('r1')?.state).toBe('failed');
    expect(listUndeliveredInboxItems('s1')).toHaveLength(0);
  });

  it.each(['done', 'killed', 'error'])(
    'clears the marker without spawning for a %s session',
    async (status) => {
      addSession(`sd-${status}`, status);
      addWaitingRun(`rd-${status}`, `sd-${status}`);
      vi.mocked(getChangedFiles).mockClear();
      expect(await evaluateSubject(`rd-${status}`, null)).toBe('skipped');
      expect(
        getTestRequestRunById(`rd-${status}`)?.awaiting_disposition_at,
      ).toBeNull();
      expect(getChangedFiles).not.toHaveBeenCalled();
    },
  );

  it('one sweep tick clears the marker of terminal and missing-session failed runs without spawning git', async () => {
    for (const status of ['done', 'killed', 'error']) {
      addSession(`sw-${status}`, status);
      addWaitingRun(`rw-${status}`, `sw-${status}`);
    }
    db.pragma('foreign_keys = OFF');
    addWaitingRun('rw-orphan', 'no-such-session');
    db.pragma('foreign_keys = ON');
    addWaitingRun('rw-live', 's1');
    vi.mocked(getChangedFiles).mockClear();
    filterMock.mockResolvedValue({
      ...fullExcuse,
      result: {
        ...fullExcuse.result,
        outcome: 'filtered_partial',
        passed: false,
      },
    });

    await sweepConfirmedWaiting(null);

    for (const id of ['rw-done', 'rw-killed', 'rw-error', 'rw-orphan']) {
      expect(getTestRequestRunById(id)?.awaiting_disposition_at).toBeNull();
    }
    expect(getChangedFiles).not.toHaveBeenCalled();
    expect(filterMock).toHaveBeenCalledTimes(1);
    expect(
      getTestRequestRunById('rw-live')?.awaiting_disposition_at,
    ).not.toBeNull();
  });

  it('clears the marker without spawning when the worktree is gone', async () => {
    addSession('sg', 'running', path.join(WT, 'missing'));
    addWaitingRun('rg', 'sg');
    vi.mocked(getChangedFiles).mockClear();
    expect(await evaluateSubject('rg', null)).toBe('skipped');
    expect(getTestRequestRunById('rg')?.awaiting_disposition_at).toBeNull();
    expect(getChangedFiles).not.toHaveBeenCalled();
  });

  it('drains dead runs and still reaches a live run behind >500 dead ones', async () => {
    addSession('sdead', 'done');
    for (let i = 0; i < 510; i++) addWaitingRun(`dead-${i}`, 'sdead');
    addWaitingRun('live', 's1');
    db.prepare(
      `UPDATE test_request_runs SET awaiting_disposition_at = ? WHERE id = 'live'`,
    ).run(Date.now() + 1_000_000);
    filterMock.mockResolvedValue({
      ...fullExcuse,
      result: {
        ...fullExcuse.result,
        outcome: 'filtered_partial',
        passed: false,
      },
    });
    await sweepConfirmedWaiting(null);
    expect(filterMock).toHaveBeenCalledTimes(1);
    expect(listAwaitingDispositionRuns().map((r) => r.id)).toEqual(['live']);
  });
});

describe('attribution wait wake', () => {
  const partial = {
    ...fullExcuse,
    result: {
      ...fullExcuse.result,
      outcome: 'filtered_partial',
      passed: false,
    },
  };

  function addResult(
    runId: string,
    testId: string,
    outcome: string,
    createdAt: number,
  ): void {
    db.prepare(
      `INSERT INTO test_run_results
         (test_request_run_id, project_id, test_id, name, outcome, duration_ms, concurrent_run_count, oom_killed, created_at)
       VALUES (?, 'proj-1', ?, ?, ?, 1, 0, 0, ?)`,
    ).run(runId, testId, testId, outcome, createdAt);
  }

  function addOtherPass(sessionId: string, testId: string): void {
    addSession(sessionId, 'running', `/other/${sessionId}`);
    const runId = `pass-${sessionId}-${testId}`;
    insertTestRequestRun(runId, 'proj-1', `h-${runId}`, sessionId, NOW);
    db.prepare(
      `UPDATE test_request_runs SET state = 'passed', worktree_path = ? WHERE id = ?`,
    ).run(`/other/${sessionId}`, runId);
    addResult(runId, testId, 'passed', Date.now() + 10);
  }

  function setup(): void {
    addWaitingRun('r1', 's1');
    addResult('r1', 'tw', 'failed', NOW);
    filterMock.mockResolvedValue(partial);
  }

  const wakes = () =>
    listUndeliveredInboxItems('s1').filter(
      (i) => i.source === ATTRIBUTION_WAIT_WAKE_SOURCE,
    );

  const expireDeadline = () =>
    db
      .prepare(
        `UPDATE test_request_runs SET awaiting_disposition_at = ? WHERE id = 'r1'`,
      )
      .run(Date.now() - 121 * 60_000);

  it('wakes once on other-tree evidence before the deadline', async () => {
    setup();
    for (const s of ['o1', 'o2', 'o3']) addOtherPass(s, 'tw');
    const deliver = vi.fn(async () => {});
    const sink = { deliverReattributionWake: deliver };
    await evaluateSubject('r1', sink);
    await evaluateSubject('r1', sink);
    await sweepConfirmedWaiting(sink);
    const rows = wakes();
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe('attribution_wait_wake:r1');
    const payload = JSON.parse(rows[0].payload);
    expect(payload.trigger).toBe('other_tree_evidence');
    expect(payload.tests[0]).toMatchObject({
      test_id: 'tw',
      distinctOtherSessionPasses: 3,
    });
    expect(payload.output).toMatch(/fix/);
    expect(payload.output).toMatch(/override/);
    expect(getTestRequestRunById('r1')?.state).toBe('failed');
    expect(getTestRequestRunById('r1')?.awaiting_disposition_at).toBeNull();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('wakes on deadline with no evidence, and never again', async () => {
    setup();
    expireDeadline();
    await evaluateSubject('r1', null);
    await sweepConfirmedWaiting(null);
    const rows = wakes();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload).trigger).toBe('deadline');
  });

  it('does not wake with fewer than N passes on one test inside the deadline', async () => {
    setup();
    addResult('r1', 'tw2', 'failed', NOW);
    for (const s of ['o1', 'o2', 'o3']) addOtherPass(s, 'tw');
    addOtherPass('o4', 'tw2');
    await evaluateSubject('r1', null);
    expect(wakes()).toHaveLength(0);
    expect(getTestRequestRunById('r1')?.awaiting_disposition_at).not.toBeNull();
  });

  it('does not collide with an existing reattribution row', async () => {
    setup();
    expireDeadline();
    enqueueFeedbackItem(
      's1',
      REATTRIBUTION_FEEDBACK_SOURCE,
      '{}',
      'reattribution:r1',
    );
    await evaluateSubject('r1', null);
    expect(wakes()).toHaveLength(1);
  });
});
