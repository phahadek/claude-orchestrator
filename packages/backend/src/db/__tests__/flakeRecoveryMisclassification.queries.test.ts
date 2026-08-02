/**
 * Tests for the transient-failure self-falsification rate read
 * (db/queries.ts's getFlakeRecoveryMisclassificationRates): per
 * (project, gate), the fraction of conclusive flake-recovery re-runs that
 * ended in failure — see PRMergeWatcher.handleVerifiedFlakyDisposition and
 * PreReviewPipeline.rerunFlakyTests for the flake_recovery_ci_rerun /
 * flake_recovery_f2_rerun events this reads.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import { getFlakeRecoveryMisclassificationRates } from '../queries.js';
import { recordEvent } from '../../audit/AuditLog.js';

beforeEach(() => {
  db.prepare('DELETE FROM audit_log').run();
});

function recordRerun(
  eventType: 'flake_recovery_ci_rerun' | 'flake_recovery_f2_rerun',
  projectId: string,
  outcome: 'passed' | 'failed' | 'inconclusive',
): void {
  recordEvent({
    event_type: eventType,
    actor_type: 'system',
    project_id: projectId,
    task_id: null,
    payload: { pr_number: 1, repo: 'org/repo', sha: 'abc123', outcome },
  });
}

describe('getFlakeRecoveryMisclassificationRates', () => {
  it('returns an empty array when the contract has never fired', () => {
    expect(getFlakeRecoveryMisclassificationRates()).toEqual([]);
  });

  it('computes the failure rate from conclusive ci re-runs, excluding inconclusive from the denominator', () => {
    recordRerun('flake_recovery_ci_rerun', 'proj-1', 'passed');
    recordRerun('flake_recovery_ci_rerun', 'proj-1', 'failed');
    recordRerun('flake_recovery_ci_rerun', 'proj-1', 'failed');
    recordRerun('flake_recovery_ci_rerun', 'proj-1', 'inconclusive');

    const result = getFlakeRecoveryMisclassificationRates();
    expect(result).toEqual([
      {
        project: 'proj-1',
        gate: 'ci',
        conclusive: 3,
        failed: 2,
        inconclusive: 1,
        rate: 2 / 3,
      },
    ]);
  });

  it('groups separately per (project, gate)', () => {
    recordRerun('flake_recovery_ci_rerun', 'proj-1', 'passed');
    recordRerun('flake_recovery_f2_rerun', 'proj-1', 'failed');
    recordRerun('flake_recovery_ci_rerun', 'proj-2', 'failed');

    const result = getFlakeRecoveryMisclassificationRates();
    expect(result).toHaveLength(3);
    expect(result).toEqual(
      expect.arrayContaining([
        {
          project: 'proj-1',
          gate: 'ci',
          conclusive: 1,
          failed: 0,
          inconclusive: 0,
          rate: 0,
        },
        {
          project: 'proj-1',
          gate: 'f2',
          conclusive: 1,
          failed: 1,
          inconclusive: 0,
          rate: 1,
        },
        {
          project: 'proj-2',
          gate: 'ci',
          conclusive: 1,
          failed: 1,
          inconclusive: 0,
          rate: 1,
        },
      ]),
    );
  });

  it('returns a null rate when only inconclusive re-runs exist, still reporting the inconclusive count', () => {
    recordRerun('flake_recovery_ci_rerun', 'proj-1', 'inconclusive');

    const result = getFlakeRecoveryMisclassificationRates();
    expect(result).toEqual([
      {
        project: 'proj-1',
        gate: 'ci',
        conclusive: 0,
        failed: 0,
        inconclusive: 1,
        rate: null,
      },
    ]);
  });

  it('filters by project when given one', () => {
    recordRerun('flake_recovery_ci_rerun', 'proj-1', 'failed');
    recordRerun('flake_recovery_ci_rerun', 'proj-2', 'passed');

    const result = getFlakeRecoveryMisclassificationRates('proj-1');
    expect(result).toEqual([
      {
        project: 'proj-1',
        gate: 'ci',
        conclusive: 1,
        failed: 1,
        inconclusive: 0,
        rate: 1,
      },
    ]);
  });

  it('ignores unrelated audit events', () => {
    recordEvent({
      event_type: 'flake_recovery_attempted',
      actor_type: 'system',
      project_id: 'proj-1',
      task_id: null,
      payload: {
        pr_number: 1,
        repo: 'org/repo',
        sha: 'abc123',
        gate: 'ci',
        reason: 'x',
        attempt: 1,
      },
    });
    recordEvent({
      event_type: 'flake_recovery_exhausted',
      actor_type: 'system',
      project_id: 'proj-1',
      task_id: null,
      payload: { pr_number: 1, repo: 'org/repo', attempts: 3, max_retries: 3 },
    });

    expect(getFlakeRecoveryMisclassificationRates()).toEqual([]);
  });
});
