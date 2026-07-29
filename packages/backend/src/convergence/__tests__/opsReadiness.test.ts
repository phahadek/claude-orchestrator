/**
 * Tests for listOpsMilestoneReadiness / getOpsReadiness
 * (packages/backend/src/convergence/opsReadiness.ts) — the ops axis rollup
 * over ops_journal, mirroring gateService's listMilestoneReadiness.
 *
 * AC: a per-(project, milestone) rollup with terminal = resolved.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { upsertOpsJournalEntry } from '../../db/queries.js';
import { getOpsReadiness, listOpsMilestoneReadiness } from '../opsReadiness.js';

beforeEach(() => {
  db.prepare('DELETE FROM ops_journal').run();
});

function entry(overrides: Partial<Parameters<typeof upsertOpsJournalEntry>[0]> = {}) {
  upsertOpsJournalEntry({
    task_id: 'notion:1',
    project: 'p1',
    milestone: 'M12',
    state: 'pending',
    disposition: null,
    worked_in: null,
    evidence: null,
    finding_or_proposal: null,
    falsification: null,
    filed_followons: null,
    needs_from_operator: null,
    resolution: null,
    updated_at: new Date(0).toISOString(),
    ...overrides,
  });
}

describe('getOpsReadiness', () => {
  it('is blocked while any journal row for the (project, milestone) is not resolved', () => {
    entry({ task_id: 'notion:1', state: 'candidate' });
    const readiness = getOpsReadiness('p1', 'M12');
    expect(readiness.status).toBe('blocked');
    expect(readiness.blocking).toEqual([{ task_id: 'notion:1', state: 'candidate' }]);
    expect(readiness.blockingCount).toBe(1);
  });

  it('is green once every journal row for the milestone is resolved', () => {
    entry({ task_id: 'notion:1', state: 'resolved' });
    entry({ task_id: 'notion:2', state: 'resolved' });
    const readiness = getOpsReadiness('p1', 'M12');
    expect(readiness.status).toBe('green');
    expect(readiness.blocking).toEqual([]);
  });

  it('is green (trivially) when the milestone has no ops_journal rows', () => {
    const readiness = getOpsReadiness('p1', 'M99');
    expect(readiness.status).toBe('green');
    expect(readiness.blockingCount).toBe(0);
  });

  it('scopes strictly to the given (project, milestone) pair', () => {
    entry({ task_id: 'notion:1', project: 'p1', milestone: 'M12', state: 'candidate' });
    entry({ task_id: 'notion:2', project: 'p2', milestone: 'M12', state: 'candidate' });
    entry({ task_id: 'notion:3', project: 'p1', milestone: 'M13', state: 'candidate' });
    const readiness = getOpsReadiness('p1', 'M12');
    expect(readiness.blocking).toEqual([{ task_id: 'notion:1', state: 'candidate' }]);
  });
});

describe('listOpsMilestoneReadiness', () => {
  it('rolls up per (project, milestone), terminal = resolved', () => {
    entry({ task_id: 'notion:1', project: 'p1', milestone: 'M12', state: 'candidate' });
    entry({ task_id: 'notion:2', project: 'p1', milestone: 'M12', state: 'resolved' });
    entry({ task_id: 'notion:3', project: 'p2', milestone: 'M12', state: 'resolved' });

    const rollup = listOpsMilestoneReadiness();
    expect(rollup).toEqual([
      { project: 'p1', milestone: 'M12', status: 'blocked', blockingCount: 1 },
      { project: 'p2', milestone: 'M12', status: 'green', blockingCount: 0 },
    ]);
  });

  it('filters to a single project when requested', () => {
    entry({ task_id: 'notion:1', project: 'p1', milestone: 'M12', state: 'candidate' });
    entry({ task_id: 'notion:2', project: 'p2', milestone: 'M12', state: 'candidate' });

    const rollup = listOpsMilestoneReadiness({ project: 'p1' });
    expect(rollup).toEqual([
      { project: 'p1', milestone: 'M12', status: 'blocked', blockingCount: 1 },
    ]);
  });
});
