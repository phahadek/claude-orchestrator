/**
 * The docs execution flow's never-auto-merged gate: an open, un-merged
 * human_merge_only PR must never be classified stalled/orphaned — it waits
 * indefinitely for a human to merge it.
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
    title: 'docs: test',
    body: null,
    head_branch: 'feature/docs',
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
    session_initiated_close_at: null,
    reviewer_requested_at: null,
    flake_recovery_attempts: 0,
    human_merge_only: 0,
    ...overrides,
  };
}

describe('classifyStalledPR — human_merge_only', () => {
  it('never classifies a human_merge_only PR, even in an otherwise gate_failed shape', () => {
    const pr = makePR({
      human_merge_only: 1,
      review_result: JSON.stringify({ verdict: 'autofix_failed' }),
    });
    expect(classifyStalledPR(pr, null)).toBeNull();
  });

  it('never classifies a human_merge_only PR in an otherwise pre_review_interrupted shape', () => {
    const pr = makePR({ human_merge_only: 1, review_result: null });
    expect(classifyStalledPR(pr, null)).toBeNull();
  });

  it('still classifies the same shape normally when human_merge_only=0', () => {
    const pr = makePR({
      human_merge_only: 0,
      review_result: JSON.stringify({ verdict: 'autofix_failed' }),
    });
    expect(classifyStalledPR(pr, null)).toEqual({ kind: 'gate_failed' });
  });
});
