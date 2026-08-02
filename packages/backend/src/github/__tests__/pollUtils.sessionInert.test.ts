/**
 * Tests for the activity-based stall signal: classifyStalledPR's
 * session_inert kind. Every other kind keys on a pre-existing fault (a pause
 * reason, a verdict, a merge state) already latched on the PR row — a PR that
 * is otherwise healthy but whose implementing session has simply stopped
 * emitting activity matched none of them. session_inert closes that gap,
 * evaluated only after every existing kind, keyed on injected activity
 * age/threshold rather than any I/O or clock read inside the classifier.
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
    review_session_id: 'review-session-1',
    review_iteration: 0,
    head_sha: 'sha1',
    last_reviewed_sha: 'sha1',
    node_id: null,
    mergeable: 1,
    merge_state: 'clean',
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

const TEN_MIN_MS = 10 * 60 * 1000;

describe('classifyStalledPR — session_inert', () => {
  it('classifies as session_inert when nothing else matches and activity age exceeds the threshold', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'approved' }),
    });

    expect(
      classifyStalledPR(
        pr,
        'done',
        'running',
        false,
        TEN_MIN_MS + 1,
        TEN_MIN_MS,
      ),
    ).toEqual({ kind: 'session_inert' });
  });

  it('classifies null when activity age is within the threshold', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'approved' }),
    });

    expect(
      classifyStalledPR(
        pr,
        'done',
        'running',
        false,
        TEN_MIN_MS - 1,
        TEN_MIN_MS,
      ),
    ).toBeNull();
  });

  it('fires for an implementing session at status running, not just idle — the PR #1225/#1228 divergence', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'approved' }),
    });

    const runningResult = classifyStalledPR(
      pr,
      'done',
      'running',
      false,
      TEN_MIN_MS + 1,
      TEN_MIN_MS,
    );
    const idleResult = classifyStalledPR(
      pr,
      'done',
      'idle',
      false,
      TEN_MIN_MS + 1,
      TEN_MIN_MS,
    );

    expect(runningResult).toEqual({ kind: 'session_inert' });
    expect(idleResult).toEqual({ kind: 'session_inert' });
  });

  it('never classifies session_inert when lastActivityAgeMs is null (unknown, e.g. pruned session_events)', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'approved' }),
    });

    expect(
      classifyStalledPR(pr, 'done', 'running', false, null, TEN_MIN_MS),
    ).toBeNull();
  });

  it('performs no database access or clock read — deterministic given the same injected fixtures', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'approved' }),
    });

    const first = classifyStalledPR(
      pr,
      'done',
      'running',
      false,
      TEN_MIN_MS + 1,
      TEN_MIN_MS,
    );
    const second = classifyStalledPR(
      pr,
      'done',
      'running',
      false,
      TEN_MIN_MS + 1,
      TEN_MIN_MS,
    );

    expect(first).toEqual(second);
    expect(first).toEqual({ kind: 'session_inert' });
  });

  describe('pre-existing kinds still win over session_inert (activity age past threshold on every fixture)', () => {
    it('conflict_dead_session', () => {
      const pr = makePR({
        merge_state: 'dirty',
        review_result: null,
      });

      expect(
        classifyStalledPR(pr, null, 'done', false, TEN_MIN_MS + 1, TEN_MIN_MS),
      ).toEqual({ kind: 'conflict_dead_session' });
    });

    it('analyze_failing', () => {
      const pr = makePR({
        pause_reason: 'analyze_failing',
        pending_push: 0,
      });

      expect(
        classifyStalledPR(
          pr,
          'done',
          'idle',
          false,
          TEN_MIN_MS + 1,
          TEN_MIN_MS,
        ),
      ).toEqual({ kind: 'analyze_failing' });
    });

    it('gate_failed', () => {
      const pr = makePR({
        review_result: JSON.stringify({ verdict: 'autofix_failed' }),
      });

      expect(
        classifyStalledPR(
          pr,
          'done',
          'idle',
          false,
          TEN_MIN_MS + 1,
          TEN_MIN_MS,
        ),
      ).toEqual({ kind: 'gate_failed' });
    });

    it('incomplete_verdict', () => {
      const pr = makePR({
        review_result: JSON.stringify({ verdict: 'incomplete' }),
        head_sha: 'sha1',
        last_reviewed_sha: 'sha1',
      });

      expect(
        classifyStalledPR(
          pr,
          'done',
          'idle',
          false,
          TEN_MIN_MS + 1,
          TEN_MIN_MS,
        ),
      ).toEqual({ kind: 'incomplete_verdict' });
    });

    it('undelivered_review_feedback', () => {
      const pr = makePR({
        review_result: JSON.stringify({ verdict: 'needs_changes' }),
        head_sha: 'sha1',
        last_reviewed_sha: 'sha1',
      });

      expect(
        classifyStalledPR(pr, 'done', 'idle', true, TEN_MIN_MS + 1, TEN_MIN_MS),
      ).toEqual({ kind: 'undelivered_review_feedback' });
    });

    it('pre_review_interrupted', () => {
      const pr = makePR({
        review_result: null,
        pending_push: 0,
        review_session_id: null,
      });

      expect(
        classifyStalledPR(pr, null, 'idle', false, TEN_MIN_MS + 1, TEN_MIN_MS),
      ).toEqual({ kind: 'pre_review_interrupted' });
    });

    it('errored_review_session', () => {
      const pr = makePR({
        review_result: JSON.stringify({ verdict: 'needs_changes' }),
        head_sha: 'sha2',
        last_reviewed_sha: 'sha1',
      });

      expect(
        classifyStalledPR(
          pr,
          'error',
          'idle',
          false,
          TEN_MIN_MS + 1,
          TEN_MIN_MS,
        ),
      ).toEqual({ kind: 'errored_review_session' });
    });
  });
});
