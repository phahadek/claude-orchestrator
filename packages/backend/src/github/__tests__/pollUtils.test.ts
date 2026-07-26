/**
 * Tests for classifyStalledPR's gate_failed classification, specifically
 * around pending_push=1 — a gate-failed PR carrying a stuck pending_push
 * must still be classified for re-drive, not silently excluded.
 */

import { describe, it, expect } from 'vitest';
import { classifyStalledPR } from '../pollUtils';
import type { PullRequestRow } from '../../db/types';

function makePR(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: 42,
    pr_url: 'https://github.com/org/repo/pull/42',
    task_id: 'notion:abc123',
    session_id: 'session-1',
    repo: 'org/repo',
    title: 'Test PR',
    body: null,
    head_branch: 'feature/test',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: null,
    review_at: null,
    created_at: null,
    updated_at: null,
    synced_at: new Date().toISOString(),
    review_session_id: null,
    review_iteration: 0,
    head_sha: 'sha1',
    last_reviewed_sha: 'sha1',
    node_id: null,
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
    failing_checks: null,
    pending_push: 0,
    pause_reason: null,
    pause_reason_set_at: null,
    ci_remediation_attempted_sha: null,
    pre_review_stage: null,
    conflict_nudge_sha: null,
    stalled_pr_retry_count: 0,
    ...overrides,
  };
}

describe('classifyStalledPR — gate_failed', () => {
  it('classifies a gate-failed PR with pending_push=1 as gate_failed (not excluded)', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'autofix_failed' }),
      pending_push: 1,
    });

    expect(classifyStalledPR(pr, null)).toEqual({ kind: 'gate_failed' });
  });

  it('classifies a verify_failed PR with pending_push=1 as gate_failed', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'verify_failed' }),
      pending_push: 1,
    });

    expect(classifyStalledPR(pr, null)).toEqual({ kind: 'gate_failed' });
  });

  it('still classifies a gate-failed PR with !pending_push as gate_failed (no regression)', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'autofix_failed' }),
      pending_push: 0,
    });

    expect(classifyStalledPR(pr, null)).toEqual({ kind: 'gate_failed' });
  });

  it('does not classify a non-gate-failure verdict as gate_failed regardless of pending_push', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'approved' }),
      pending_push: 1,
      mergeable: 1,
    });

    expect(classifyStalledPR(pr, null)?.kind).not.toBe('gate_failed');
  });
});
