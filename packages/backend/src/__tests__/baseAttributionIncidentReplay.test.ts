/**
 * Deterministic replay of the 2026-08-14 incident's PR #1715 leg — the
 * budget-restore primitive StalledPRReconciler drives against the query
 * layer once a PR's stalled_pr_retry_count exhaustion is confirmed
 * base-attributable and later recovers. The session_test_request_cycles leg
 * of this incident (four sessions burning 8/6/7/3 cycles against a
 * confirmed-broken base) no longer has a whole-tree total_fail signal to
 * replay against — see StalledPRReconciler.ts and PRMergeWatcher.ts's
 * per-run breadth-attributability check (db/queries.ts's
 * isRunFailureBreadthAttributable), which replaced it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/db', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db';
import {
  setStalledRetryBaseExhausted,
  resetStalledPRRetryCountForBaseRecovery,
  getPRByNumber,
} from '../db/queries';

const REPO = 'org/repo';

function insertPR1715(): void {
  db.prepare(
    `
    INSERT INTO pull_requests
      (pr_number, pr_url, repo, state, draft, review_result, review_at,
       created_at, updated_at, synced_at, stalled_pr_retry_count,
       stalled_retry_base_exhausted, pause_reason)
    VALUES
      (1715, 'https://github.com/org/repo/pull/1715', @repo, 'open', 0, NULL, NULL,
       '2026-08-14T00:00:00Z', '2026-08-14T00:00:00Z', '2026-08-14T00:00:00Z', 2,
       0, 'stalled_reconcile_cap')
  `,
  ).run({ repo: REPO });
}

function insertUnrelatedExhaustedPR(prNumber: number): void {
  db.prepare(
    `
    INSERT INTO pull_requests
      (pr_number, pr_url, repo, state, draft, review_result, review_at,
       created_at, updated_at, synced_at, stalled_pr_retry_count,
       stalled_retry_base_exhausted, pause_reason)
    VALUES
      (@pr_number, @pr_url, @repo, 'open', 0, NULL, NULL,
       '2026-08-14T00:00:00Z', '2026-08-14T00:00:00Z', '2026-08-14T00:00:00Z', 2,
       0, 'stalled_reconcile_cap')
  `,
  ).run({
    pr_number: prNumber,
    pr_url: `https://github.com/org/repo/pull/${prNumber}`,
    repo: REPO,
  });
}

beforeEach(() => {
  db.prepare('DELETE FROM pull_requests').run();
});

describe('2026-08-14 incident replay', () => {
  it("restores PR #1715's stalled_pr_retry_count once base recovers, scoped to PR #1715 alone", () => {
    // PR #1715 sits exhausted (retry_count at cap, pause=stalled_reconcile_cap)
    // exactly as the real incident left it; an unrelated PR is exhausted too,
    // but for a genuine (non-base) reason, so its flag was never set.
    insertPR1715();
    insertUnrelatedExhaustedPR(1716);

    // The moment the reconciler would have re-classified PR #1715's stall as
    // gate_failed and confirmed it breadth-attributable, it marks the flag —
    // this is what the reconciler's own escalation path does; here it's
    // driven directly against the query layer.
    setStalledRetryBaseExhausted(1715, REPO, true);

    // Base recovers.
    resetStalledPRRetryCountForBaseRecovery(1715, REPO);

    const pr1715 = getPRByNumber(1715, REPO);
    expect(pr1715?.stalled_pr_retry_count).toBe(0);
    expect(pr1715?.stalled_retry_base_exhausted).toBe(0);

    // The unrelated PR's counter is untouched — never a blanket reset.
    const pr1716 = getPRByNumber(1716, REPO);
    expect(pr1716?.stalled_pr_retry_count).toBe(2);
    expect(pr1716?.stalled_retry_base_exhausted).toBe(0);
  });
});
