/**
 * Tests for the ops.prIntent <-> pull_requests linkage (db/queries.ts):
 * linkPRToPRIntent's fire-once enforcement — one approved ops.prIntent
 * authorizes exactly one PR — and getPRIntentForPR's resolution path, which
 * PRReviewService uses to build the Ops rubric's "changed files" dimension.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  insertStagedIntent,
  linkPRToPRIntent,
  getPRIntentForPR,
  PRIntentAlreadyConsumedError,
} from '../queries.js';
import type { StagedIntentRow } from '../types.js';

const NOW = '2024-01-01T00:00:00Z';

function insertPR(prNumber: number, repo = 'owner/repo'): void {
  db.prepare(
    `
    INSERT INTO pull_requests
      (pr_number, pr_url, task_id, repo, state, created_at, updated_at, synced_at)
    VALUES
      (@pr_number, @pr_url, 'task-1', @repo, 'open', @created_at, @updated_at, @synced_at)
  `,
  ).run({
    pr_number: prNumber,
    pr_url: `https://github.com/${repo}/pull/${prNumber}`,
    repo,
    created_at: NOW,
    updated_at: NOW,
    synced_at: NOW,
  });
}

function insertOpsPrIntent(id: string): StagedIntentRow {
  const now = Date.now();
  const row: StagedIntentRow = {
    id,
    kind: 'ops.prIntent',
    payload: JSON.stringify({
      taskId: 'task-1',
      title: 'add retry to the poller',
      scope: 'src/ops/poller.ts',
      reason: 'poller drops events under transient network errors',
    }),
    payload_hash: `hash-${id}`,
    task_id: 'task-1',
    project_id: 'proj-1',
    session_id: 'session-1',
    group_id: null,
    milestone: null,
    state: 'committed',
    supersedes: null,
    annotation: null,
    decision_proposal: null,
    groom_proposal: null,
    advisory: null,
    disposition_reason: null,
    answer: null,
    created_at: now,
    updated_at: now,
  };
  insertStagedIntent(row);
  return row;
}

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM pull_requests').run();
});

describe('linkPRToPRIntent / getPRIntentForPR', () => {
  it('links a PR to its approved ops.prIntent, resolvable via getPRIntentForPR', () => {
    insertPR(1);
    const intent = insertOpsPrIntent('intent-1');

    linkPRToPRIntent(1, 'owner/repo', intent.id);

    const resolved = getPRIntentForPR(1, 'owner/repo');
    expect(resolved?.id).toBe('intent-1');
    expect(resolved?.kind).toBe('ops.prIntent');
  });

  it('returns null for a PR with no linked PR-intent', () => {
    insertPR(1);
    expect(getPRIntentForPR(1, 'owner/repo')).toBeNull();
  });

  it('is idempotent when re-linking the same PR to the same intent', () => {
    insertPR(1);
    const intent = insertOpsPrIntent('intent-1');

    linkPRToPRIntent(1, 'owner/repo', intent.id);
    expect(() => linkPRToPRIntent(1, 'owner/repo', intent.id)).not.toThrow();
    expect(getPRIntentForPR(1, 'owner/repo')?.id).toBe('intent-1');
  });

  it('fire-once: rejects linking the same PR-intent to a second PR', () => {
    insertPR(1);
    insertPR(2);
    const intent = insertOpsPrIntent('intent-1');

    linkPRToPRIntent(1, 'owner/repo', intent.id);

    expect(() => linkPRToPRIntent(2, 'owner/repo', intent.id)).toThrow(
      PRIntentAlreadyConsumedError,
    );
    // The first PR keeps the link; the second was never granted it.
    expect(getPRIntentForPR(1, 'owner/repo')?.id).toBe('intent-1');
    expect(getPRIntentForPR(2, 'owner/repo')).toBeNull();
  });
});
