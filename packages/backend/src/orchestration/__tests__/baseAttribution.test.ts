/**
 * Unit tests for the shared base-attributability logic (baseAttribution.ts)
 * that the three retry/cycle budgets (session_test_request_cycles,
 * stalled_pr_retry_count, flake_recovery_attempts) all consult before
 * charging a failure or restoring an exhausted budget.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const { mockCheckBaseBranchHealth } = vi.hoisted(() => ({
  mockCheckBaseBranchHealth: vi.fn(),
}));

vi.mock('../baseHealthCheck.js', () => ({
  checkBaseBranchHealth: mockCheckBaseBranchHealth,
}));

import { db } from '../../db/db';
import {
  isBaseTotalFail,
  isRunFailureBaseAttributable,
  isProjectBaseHealthy,
} from '../baseAttribution';
import { insertTestRequestRun, insertTestRunResults } from '../../db/queries';

const PROJECT = { id: 'proj-1', projectDir: '/proj' } as any;

beforeEach(() => {
  mockCheckBaseBranchHealth.mockReset();
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_request_runs').run();
});

describe('isBaseTotalFail', () => {
  it('is true when the base tree total_fail-s', async () => {
    mockCheckBaseBranchHealth.mockResolvedValue({ outcome: 'total_fail' });
    expect(await isBaseTotalFail(PROJECT)).toBe(true);
  });

  it.each(['clean_pass', 'partial_fail', 'unknown'])(
    'is false for base outcome %s',
    async (outcome) => {
      mockCheckBaseBranchHealth.mockResolvedValue({ outcome });
      expect(await isBaseTotalFail(PROJECT)).toBe(false);
    },
  );
});

describe('isProjectBaseHealthy', () => {
  it('is true only for clean_pass', async () => {
    mockCheckBaseBranchHealth.mockResolvedValue({ outcome: 'clean_pass' });
    expect(await isProjectBaseHealthy(PROJECT)).toBe(true);

    mockCheckBaseBranchHealth.mockResolvedValue({ outcome: 'total_fail' });
    expect(await isProjectBaseHealthy(PROJECT)).toBe(false);
  });
});

describe('isRunFailureBaseAttributable', () => {
  it('is true on a total_fail base regardless of the run', async () => {
    mockCheckBaseBranchHealth.mockResolvedValue({ outcome: 'total_fail' });
    expect(
      await isRunFailureBaseAttributable(PROJECT, { id: 'run-x' }),
    ).toBe(true);
  });

  it('is false on an unknown base outcome (defaults to charge normally)', async () => {
    mockCheckBaseBranchHealth.mockResolvedValue({ outcome: 'unknown' });
    expect(
      await isRunFailureBaseAttributable(PROJECT, { id: 'run-x' }),
    ).toBe(false);
  });

  it('is false on a clean_pass base', async () => {
    mockCheckBaseBranchHealth.mockResolvedValue({ outcome: 'clean_pass' });
    expect(
      await isRunFailureBaseAttributable(PROJECT, { id: 'run-x' }),
    ).toBe(false);
  });

  it('is true on a partial_fail base whose failing tests are a superset of the run\'s own failing tests', async () => {
    insertTestRequestRun('run-own', 'proj-1', 'hash-a', null, Date.now());
    insertTestRunResults(
      'run-own',
      [{ test_id: 't1', name: 'test one', outcome: 'failed', duration_ms: 1 }],
      null,
      false,
    );
    insertTestRequestRun('run-base', 'proj-1', 'hash-base', null, Date.now());
    insertTestRunResults(
      'run-base',
      [
        { test_id: 't1', name: 'test one', outcome: 'failed', duration_ms: 1 },
        { test_id: 't2', name: 'test two', outcome: 'failed', duration_ms: 1 },
      ],
      null,
      false,
    );
    mockCheckBaseBranchHealth.mockResolvedValue({
      outcome: 'partial_fail',
      run: { id: 'run-base' },
    });

    expect(
      await isRunFailureBaseAttributable(PROJECT, { id: 'run-own' }),
    ).toBe(true);
  });

  it('is false on a partial_fail base that does not cover all of the run\'s own failing tests', async () => {
    insertTestRequestRun('run-own-2', 'proj-1', 'hash-a', null, Date.now());
    insertTestRunResults(
      'run-own-2',
      [
        { test_id: 't1', name: 'test one', outcome: 'failed', duration_ms: 1 },
        {
          test_id: 't-real-bug',
          name: 'a real bug in the PR',
          outcome: 'failed',
          duration_ms: 1,
        },
      ],
      null,
      false,
    );
    insertTestRequestRun('run-base-2', 'proj-1', 'hash-base', null, Date.now());
    insertTestRunResults(
      'run-base-2',
      [{ test_id: 't1', name: 'test one', outcome: 'failed', duration_ms: 1 }],
      null,
      false,
    );
    mockCheckBaseBranchHealth.mockResolvedValue({
      outcome: 'partial_fail',
      run: { id: 'run-base-2' },
    });

    expect(
      await isRunFailureBaseAttributable(PROJECT, { id: 'run-own-2' }),
    ).toBe(false);
  });

  it('is false when the run has no failing tests recorded (nothing to attribute)', async () => {
    insertTestRequestRun('run-empty', 'proj-1', 'hash-a', null, Date.now());
    mockCheckBaseBranchHealth.mockResolvedValue({
      outcome: 'partial_fail',
      run: { id: 'run-base' },
    });

    expect(
      await isRunFailureBaseAttributable(PROJECT, { id: 'run-empty' }),
    ).toBe(false);
  });
});
