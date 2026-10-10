import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const filterMock = vi.hoisted(() => vi.fn());
vi.mock('../baseAttributableFilter', () => ({
  filterBaseAttributableFailuresForF2Gate: filterMock,
}));
vi.mock('../../session/autofix-runner', () => ({
  getChangedFiles: vi.fn(async () => ['src/a.ts']),
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
} from '../../db/queries';
import {
  evaluateSubject,
  sweepConfirmedWaiting,
  REATTRIBUTION_FEEDBACK_SOURCE,
} from '../reattributionService';

const NOW = Date.now();

function addSession(id: string): void {
  insertSession({
    session_id: id,
    task_id: `task-${id}`,
    task_url: 'https://notion.so/x',
    project_context_url: 'https://notion.so/p',
    project_id: 'proj-1',
    status: 'running',
    started_at: NOW,
    worktree_path: '/tmp/wt',
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
    `DELETE FROM session_feedback_inbox; DELETE FROM test_request_runs; DELETE FROM sessions;`,
  );
  filterMock.mockReset();
  filterMock.mockResolvedValue(fullExcuse);
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
});
