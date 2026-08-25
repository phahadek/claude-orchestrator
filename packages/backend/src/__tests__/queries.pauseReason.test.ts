import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import {
  getApprovedOpenPRs,
  getConflictNudgeCandidates,
  getPausedPrReasonForTask,
  getStaleAutoMergeFailedPRs,
  resetReviewIteration,
  setPauseReason,
} from '../db/queries.js';
import { deriveDisplayStatus } from '../tasks/TaskStatusEngine.js';
import {
  pauseReasonFromCanonical,
  parsePauseReasonSet,
  isMergeBlockingPause,
} from '../db/pauseReason.js';

const NOW = '2024-01-01T00:00:00Z';

function insertPR(opts: {
  pr_number: number;
  task_id?: string | null;
  state?: string;
  review_result?: string | null;
  pause_reason?: string | null;
  session_id?: string | null;
  head_sha?: string | null;
}): void {
  db.prepare(
    `
    INSERT INTO pull_requests
      (pr_number, pr_url, task_id, session_id, repo, state,
       review_result, created_at, updated_at, synced_at, pause_reason, head_sha)
    VALUES
      (@pr_number, @pr_url, @task_id, @session_id, 'owner/repo', @state,
       @review_result, @created_at, @updated_at, @synced_at, @pause_reason, @head_sha)
  `,
  ).run({
    pr_number: opts.pr_number,
    pr_url: `https://github.com/owner/repo/pull/${opts.pr_number}`,
    task_id: opts.task_id ?? null,
    session_id: opts.session_id ?? null,
    state: opts.state ?? 'open',
    review_result: opts.review_result ?? null,
    created_at: NOW,
    updated_at: NOW,
    synced_at: NOW,
    pause_reason: opts.pause_reason ?? null,
    head_sha: opts.head_sha ?? null,
  });
}

beforeEach(() => {
  db.prepare('DELETE FROM pull_requests').run();
});

describe('getApprovedOpenPRs() — Auto-merger candidate query', () => {
  it('returns approved open PRs with no pause_reason', () => {
    insertPR({
      pr_number: 1,
      review_result: JSON.stringify({ verdict: 'approved' }),
    });
    const rows = getApprovedOpenPRs();
    expect(rows).toHaveLength(1);
    expect(rows[0].pr_number).toBe(1);
  });

  it('excludes approved open PRs paused by stuck_timeout', () => {
    insertPR({
      pr_number: 2,
      review_result: JSON.stringify({ verdict: 'approved' }),
      pause_reason: 'stuck_timeout',
    });
    expect(getApprovedOpenPRs()).toHaveLength(0);
  });

  it('excludes approved open PRs paused by max_reviews', () => {
    insertPR({
      pr_number: 3,
      review_result: JSON.stringify({ verdict: 'approved' }),
      pause_reason: 'max_reviews',
    });
    expect(getApprovedOpenPRs()).toHaveLength(0);
  });

  it('returns the mix of paused/unpaused approved PRs minus paused ones', () => {
    insertPR({
      pr_number: 10,
      review_result: JSON.stringify({ verdict: 'approved' }),
    });
    insertPR({
      pr_number: 11,
      review_result: JSON.stringify({ verdict: 'approved' }),
      pause_reason: 'stuck_timeout',
    });
    insertPR({
      pr_number: 12,
      review_result: JSON.stringify({ verdict: 'approved' }),
    });
    const rows = getApprovedOpenPRs()
      .map((r) => r.pr_number)
      .sort((a, b) => a - b);
    expect(rows).toEqual([10, 12]);
  });
});

describe('resetReviewIteration() — resume-mechanism contract', () => {
  it('clears pause_reason=stuck_timeout when called via the re-review pathway', () => {
    insertPR({ pr_number: 20, pause_reason: 'stuck_timeout' });
    db.prepare(
      'UPDATE pull_requests SET review_iteration = 3 WHERE pr_number = 20',
    ).run();

    resetReviewIteration(20, 'owner/repo');

    const row = db
      .prepare(
        'SELECT review_iteration, pause_reason FROM pull_requests WHERE pr_number = 20',
      )
      .get() as { review_iteration: number; pause_reason: string | null };
    expect(row.review_iteration).toBe(0);
    expect(row.pause_reason).toBeNull();
  });

  it('after reset, the PR is no longer skipped by AutoLauncher / Auto-merger queries', () => {
    insertPR({
      pr_number: 21,
      task_id: 'notion:task-abc',
      review_result: JSON.stringify({ verdict: 'approved' }),
      pause_reason: 'stuck_timeout',
    });

    // Pre-reset: blocked
    expect(getApprovedOpenPRs()).toHaveLength(0);
    expect(getPausedPrReasonForTask('notion:task-abc')?.reason).toBe(
      'stuck_timeout',
    );

    // Reset (mirrors the re-review endpoint)
    resetReviewIteration(21, 'owner/repo');

    // Post-reset: unblocked
    expect(getApprovedOpenPRs()).toHaveLength(1);
    expect(getPausedPrReasonForTask('notion:task-abc')).toBeNull();
  });
});

describe('setPauseReason() round-trip', () => {
  it('a stuck_timeout pause set by the monitor flows through getPausedPrReasonForTask', () => {
    insertPR({ pr_number: 30, task_id: 'notion:task-xyz' });
    setPauseReason(30, 'owner/repo', 'stuck_timeout');
    const result = getPausedPrReasonForTask('notion:task-xyz');
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('stuck_timeout');
    expect(result!.source).toBe('session');
    expect(result!.retry_strategy).toBe('automatic');
  });

  it('a review_failed pause set by the catch site flows through getPausedPrReasonForTask', () => {
    insertPR({ pr_number: 31, task_id: 'notion:task-review-failed' });
    setPauseReason(31, 'owner/repo', 'review_failed');
    const result = getPausedPrReasonForTask('notion:task-review-failed');
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('review_failed');
    expect(result!.source).toBe('review');
    expect(result!.retry_strategy).toBe('manual_action');
  });

  it('detail round-trips through write→read', () => {
    insertPR({ pr_number: 32, task_id: 'notion:task-detail' });
    setPauseReason(32, 'owner/repo', 'ci_failing', 'lint failed on PR build');
    const result = getPausedPrReasonForTask('notion:task-detail');
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('ci_failing');
    expect(result!.detail).toBe('lint failed on PR build');
  });

  it('a legacy bare-string row is parsed via fallback to the correct triple', () => {
    insertPR({
      pr_number: 33,
      task_id: 'notion:task-legacy',
      pause_reason: 'merge_conflict',
    });
    const result = getPausedPrReasonForTask('notion:task-legacy');
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('merge_conflict');
    expect(result!.source).toBe('merge');
    expect(result!.retry_strategy).toBe('manual_action');
  });
});

describe('TaskStatusEngine regression — review_failed resolves to needs_attention', () => {
  it('deriveDisplayStatus returns needs_attention when pauseReason is review_failed', () => {
    const status = deriveDisplayStatus({
      notionStatus: '👀 In Review',
      codeSessionStatus: 'done',
      prState: 'open',
      prDraft: false,
      reviewVerdict: 'needs_changes',
      reviewIterationCount: 1,
      reviewIterationCap: 3,
      pauseReason: pauseReasonFromCanonical('review_failed'),
    });
    expect(status).toBe('needs_attention');
  });

  it('deriveDisplayStatus returns needs_attention for review_failed outside In Review', () => {
    const status = deriveDisplayStatus({
      notionStatus: '💻 In Progress',
      codeSessionStatus: 'running',
      prState: null,
      prDraft: false,
      reviewVerdict: null,
      reviewIterationCount: 0,
      reviewIterationCap: 3,
      pauseReason: pauseReasonFromCanonical('review_failed'),
    });
    expect(status).toBe('needs_attention');
  });
});

describe('resetReviewIteration() — review_failed reset coverage', () => {
  it('clears pause_reason=review_failed when called via the re-review pathway', () => {
    insertPR({ pr_number: 40, pause_reason: 'review_failed' });
    db.prepare(
      'UPDATE pull_requests SET review_iteration = 2 WHERE pr_number = 40',
    ).run();

    resetReviewIteration(40, 'owner/repo');

    const row = db
      .prepare(
        'SELECT review_iteration, pause_reason FROM pull_requests WHERE pr_number = 40',
      )
      .get() as { review_iteration: number; pause_reason: string | null };
    expect(row.review_iteration).toBe(0);
    expect(row.pause_reason).toBeNull();
  });

  it('after reset, a review_failed-paused PR is unblocked in AutoLauncher / Auto-merger queries', () => {
    insertPR({
      pr_number: 41,
      task_id: 'notion:task-review-failed-2',
      review_result: JSON.stringify({ verdict: 'approved' }),
      pause_reason: 'review_failed',
    });

    // Pre-reset: blocked
    expect(getApprovedOpenPRs()).toHaveLength(0);
    expect(
      getPausedPrReasonForTask('notion:task-review-failed-2')?.reason,
    ).toBe('review_failed');

    // Reset (mirrors the re-review endpoint)
    resetReviewIteration(41, 'owner/repo');

    // Post-reset: unblocked
    expect(getApprovedOpenPRs()).toHaveLength(1);
    expect(getPausedPrReasonForTask('task-review-failed-2')).toBeNull();
  });
});

function rawPauseReason(prNumber: number): string | null {
  const row = db
    .prepare('SELECT pause_reason FROM pull_requests WHERE pr_number = ?')
    .get(prNumber) as { pause_reason: string | null };
  return row.pause_reason;
}

describe('setPauseReason() — concurrent per-source stacking', () => {
  it('a write from a source with no live entry adds a new concurrent entry without disturbing existing entries from other sources', () => {
    insertPR({ pr_number: 50, task_id: 'notion:task-stack-1' });
    // 'ci' source
    setPauseReason(50, 'owner/repo', 'ci_failing');
    // 'review' source — different source, should stack alongside ci_failing
    setPauseReason(50, 'owner/repo', 'review_failed');

    const set = parsePauseReasonSet(rawPauseReason(50));
    expect(set).toHaveLength(2);
    const reasons = set.map((e) => e.reason).sort();
    expect(reasons).toEqual(['ci_failing', 'review_failed']);
    const sources = set.map((e) => e.source).sort();
    expect(sources).toEqual(['ci', 'review']);
  });

  it('a second write from the same source replaces only that source own entry, leaving other sources entries untouched', () => {
    insertPR({ pr_number: 51, task_id: 'notion:task-stack-2' });
    setPauseReason(51, 'owner/repo', 'ci_failing'); // source: ci
    setPauseReason(51, 'owner/repo', 'review_failed'); // source: review
    setPauseReason(51, 'owner/repo', 'ci_billing_blocked'); // source: ci — replaces ci_failing only

    const set = parsePauseReasonSet(rawPauseReason(51));
    expect(set).toHaveLength(2);
    const bySource = Object.fromEntries(set.map((e) => [e.source, e.reason]));
    expect(bySource.ci).toBe('ci_billing_blocked');
    expect(bySource.review).toBe('review_failed');
  });

  it('reason=null clears the entire concurrent set', () => {
    insertPR({ pr_number: 52, task_id: 'notion:task-stack-3' });
    setPauseReason(52, 'owner/repo', 'ci_failing');
    setPauseReason(52, 'owner/repo', 'review_failed');
    setPauseReason(52, 'owner/repo', null);
    expect(rawPauseReason(52)).toBeNull();
    expect(parsePauseReasonSet(rawPauseReason(52))).toEqual([]);
  });
});

describe('isMergeBlockingPause() — ORs across concurrent entries', () => {
  it('returns true when any live entry (not just the highest-severity one) has blocks_merge:true, even when the other entry is advisory', () => {
    insertPR({ pr_number: 60, task_id: 'notion:task-block-1' });
    // ci_not_completing is blocks_merge:false and needs_attention severity
    setPauseReason(60, 'owner/repo', 'ci_not_completing');
    // merge_conflict is blocks_merge:true (implicit) — a different source
    setPauseReason(60, 'owner/repo', 'merge_conflict');

    const raw = rawPauseReason(60);
    const set = parsePauseReasonSet(raw);
    expect(set).toHaveLength(2);
    expect(isMergeBlockingPause(raw)).toBe(true);
  });

  it('returns false when every live entry is advisory (blocks_merge:false)', () => {
    insertPR({ pr_number: 61, task_id: 'notion:task-block-2' });
    setPauseReason(61, 'owner/repo', 'ci_not_completing'); // source: ci, advisory
    setPauseReason(61, 'owner/repo', 'test_report_acquisition_failed'); // source: tests, advisory

    const raw = rawPauseReason(61);
    expect(parsePauseReasonSet(raw)).toHaveLength(2);
    expect(isMergeBlockingPause(raw)).toBe(false);
  });
});

describe('legacy pause_reason row shapes still parse correctly', () => {
  it('a legacy single-struct JSON row parses as a one-element set', () => {
    insertPR({
      pr_number: 70,
      task_id: 'notion:task-legacy-struct',
      pause_reason: JSON.stringify(
        pauseReasonFromCanonical('auto_merge_failed'),
      ),
    });
    const set = parsePauseReasonSet(rawPauseReason(70));
    expect(set).toHaveLength(1);
    expect(set[0].reason).toBe('auto_merge_failed');
    expect(set[0].source).toBe('merge');
    expect(isMergeBlockingPause(rawPauseReason(70))).toBe(true);
  });

  it('a legacy bare-string row continues to parse as before', () => {
    insertPR({
      pr_number: 71,
      task_id: 'notion:task-legacy-bare',
      pause_reason: 'stuck_timeout',
    });
    const set = parsePauseReasonSet(rawPauseReason(71));
    expect(set).toHaveLength(1);
    expect(set[0].reason).toBe('stuck_timeout');
    expect(set[0].source).toBe('session');
  });
});

describe('getStaleAutoMergeFailedPRs() — per-entry set_at, not the shared column', () => {
  it('still detects staleness when an unrelated source refreshes the shared pause_reason_set_at column', () => {
    insertPR({ pr_number: 80, task_id: 'notion:task-stale-1' });
    const staleSetAt = Date.now() - 10 * 60_000;
    // The row-level column reflects the most recent write from ANY source
    // (here 'ci'), which under the old column-only check would mask the
    // still-stale 'merge' entry underneath it.
    const columnRefreshedByUnrelatedSource = Date.now();
    const rawSet = JSON.stringify([
      {
        reason: 'auto_merge_failed',
        source: 'merge',
        severity: 'needs_attention',
        retry_strategy: 'manual_action',
        blocks_merge: true,
        set_at: staleSetAt,
      },
      {
        reason: 'ci_failing',
        source: 'ci',
        severity: 'needs_attention',
        retry_strategy: 'automatic',
        blocks_merge: true,
        set_at: columnRefreshedByUnrelatedSource,
      },
    ]);
    db.prepare(
      'UPDATE pull_requests SET pause_reason = ?, pause_reason_set_at = ? WHERE pr_number = ?',
    ).run(rawSet, columnRefreshedByUnrelatedSource, 80);

    const stale = getStaleAutoMergeFailedPRs(5 * 60_000);
    expect(stale.map((r) => r.pr_number)).toContain(80);
  });

  it('does not report a fresh auto_merge_failed entry as stale even when the shared column is old', () => {
    insertPR({ pr_number: 82, task_id: 'notion:task-stale-2' });
    const freshSetAt = Date.now();
    const oldColumnTimestamp = Date.now() - 10 * 60_000;
    const rawSet = JSON.stringify([
      {
        reason: 'auto_merge_failed',
        source: 'merge',
        severity: 'needs_attention',
        retry_strategy: 'manual_action',
        blocks_merge: true,
        set_at: freshSetAt,
      },
    ]);
    db.prepare(
      'UPDATE pull_requests SET pause_reason = ?, pause_reason_set_at = ? WHERE pr_number = ?',
    ).run(rawSet, oldColumnTimestamp, 82);

    const stale = getStaleAutoMergeFailedPRs(5 * 60_000);
    expect(stale.map((r) => r.pr_number)).not.toContain(82);
  });

  it('falls back to the row-level column for a legacy entry with no per-entry set_at', () => {
    insertPR({ pr_number: 81, task_id: 'notion:task-stale-legacy' });
    const oldTimestamp = Date.now() - 10 * 60_000;
    const legacyStruct = pauseReasonFromCanonical('auto_merge_failed');
    db.prepare(
      'UPDATE pull_requests SET pause_reason = ?, pause_reason_set_at = ? WHERE pr_number = ?',
    ).run(JSON.stringify(legacyStruct), oldTimestamp, 81);

    const stale = getStaleAutoMergeFailedPRs(5 * 60_000);
    expect(stale.map((r) => r.pr_number)).toContain(81);
  });
});

describe('PAUSE_REASON_HAS_AUTO_MERGE_FAILED_SQL — guards every json_* call across live legacy shapes', () => {
  const objectShape = JSON.stringify({
    reason: 'review_failed',
    source: 'review',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  });
  const objectShapeMatching = JSON.stringify({
    reason: 'auto_merge_failed',
    source: 'merge',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  });
  const arrayShapeMatching = JSON.stringify([
    {
      reason: 'auto_merge_failed',
      source: 'merge',
      severity: 'needs_attention',
      retry_strategy: 'manual_action',
      blocks_merge: true,
    },
  ]);
  const arrayShapeNonMatching = JSON.stringify([
    {
      reason: 'ci_failing',
      source: 'ci',
      severity: 'needs_attention',
      retry_strategy: 'automatic',
      blocks_merge: false,
    },
  ]);

  function seedMixedPopulation(): void {
    insertPR({
      pr_number: 200,
      pause_reason: 'auto_merge_failed',
      session_id: 's-200',
      head_sha: 'sha-200',
    });
    insertPR({
      pr_number: 201,
      pause_reason: objectShape,
      session_id: 's-201',
      head_sha: 'sha-201',
    });
    insertPR({
      pr_number: 202,
      pause_reason: objectShapeMatching,
      session_id: 's-202',
      head_sha: 'sha-202',
    });
    insertPR({
      pr_number: 203,
      pause_reason: arrayShapeMatching,
      session_id: 's-203',
      head_sha: 'sha-203',
    });
    insertPR({
      pr_number: 204,
      pause_reason: arrayShapeNonMatching,
      session_id: 's-204',
      head_sha: 'sha-204',
    });
  }

  it('does not throw on a bare legacy string pause_reason', () => {
    insertPR({
      pr_number: 210,
      pause_reason: 'auto_merge_failed',
      session_id: 's-210',
      head_sha: 'sha-210',
    });
    expect(() => getStaleAutoMergeFailedPRs(0)).not.toThrow();
    expect(() => getConflictNudgeCandidates()).not.toThrow();
  });

  it('does not throw on a legacy single-struct object pause_reason', () => {
    insertPR({
      pr_number: 211,
      pause_reason: objectShape,
      session_id: 's-211',
      head_sha: 'sha-211',
    });
    expect(() => getStaleAutoMergeFailedPRs(0)).not.toThrow();
    expect(() => getConflictNudgeCandidates()).not.toThrow();
  });

  it('matches a concurrent-set array containing an auto_merge_failed entry', () => {
    insertPR({
      pr_number: 212,
      pause_reason: arrayShapeMatching,
      session_id: 's-212',
      head_sha: 'sha-212',
    });
    db.prepare(
      'UPDATE pull_requests SET pause_reason_set_at = ? WHERE pr_number = ?',
    ).run(Date.now() - 10 * 60_000, 212);
    const stale = getStaleAutoMergeFailedPRs(0);
    expect(stale.map((r) => r.pr_number)).toContain(212);
  });

  it('still matches a bare pause_reason = "auto_merge_failed" string', () => {
    insertPR({
      pr_number: 213,
      pause_reason: 'auto_merge_failed',
      session_id: 's-213',
      head_sha: 'sha-213',
    });
    db.prepare(
      'UPDATE pull_requests SET pause_reason_set_at = ? WHERE pr_number = ?',
    ).run(Date.now() - 10 * 60_000, 213);
    const stale = getStaleAutoMergeFailedPRs(0);
    expect(stale.map((r) => r.pr_number)).toContain(213);
  });

  it('does not match an array whose entries are all non-auto_merge_failed', () => {
    insertPR({
      pr_number: 214,
      pause_reason: arrayShapeNonMatching,
      session_id: 's-214',
      head_sha: 'sha-214',
    });
    db.prepare(
      'UPDATE pull_requests SET pause_reason_set_at = ? WHERE pr_number = ?',
    ).run(Date.now() - 10 * 60_000, 214);
    const stale = getStaleAutoMergeFailedPRs(0);
    expect(stale.map((r) => r.pr_number)).not.toContain(214);
  });

  it('exercises the predicate across a mixed population of all four shapes without throwing, matching only the auto_merge_failed rows', () => {
    seedMixedPopulation();
    db.prepare(
      'UPDATE pull_requests SET pause_reason_set_at = ? WHERE pr_number IN (200, 201, 202, 203, 204)',
    ).run(Date.now() - 10 * 60_000);

    let stale: Array<{ pr_number: number; repo: string }> = [];
    expect(() => {
      stale = getStaleAutoMergeFailedPRs(0);
    }).not.toThrow();
    expect(stale.map((r) => r.pr_number).sort()).toEqual([200, 202, 203]);

    expect(() => getConflictNudgeCandidates()).not.toThrow();
  });
});

describe('parsePauseReasonSet() — malformed array element degrades safely instead of vanishing', () => {
  it('keeps a malformed entry in the set as a fail-closed fallback rather than dropping it', () => {
    const raw = JSON.stringify([
      {
        reason: 'ci_failing',
        source: 'ci',
        severity: 'needs_attention',
        retry_strategy: 'automatic',
        blocks_merge: true,
      },
      { garbage: true },
    ]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const set = parsePauseReasonSet(raw);
    warnSpy.mockRestore();
    expect(set).toHaveLength(2);
    expect(set[1].blocks_merge).toBe(true);
  });

  it('a malformed entry keeps isMergeBlockingPause fail-closed instead of under-reporting', () => {
    const raw = JSON.stringify([
      {
        reason: 'test_report_acquisition_failed',
        source: 'tests',
        severity: 'needs_attention',
        retry_strategy: 'manual_action',
        blocks_merge: false,
      },
      { garbage: true },
    ]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(isMergeBlockingPause(raw)).toBe(true);
    warnSpy.mockRestore();
  });
});
