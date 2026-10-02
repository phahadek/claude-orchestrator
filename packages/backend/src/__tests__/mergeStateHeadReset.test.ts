import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  const db = setupTestDb();
  db.prepare(
    `INSERT INTO projects (id, name, project_dir, github_repo, task_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('proj-1', 'Test Project', '/test', 'owner/repo', 'notion', 1000, 1000);
  return { db };
});

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
  hasTaskEditSinceTimestamp: vi.fn(),
}));

import { recordEvent } from '../audit/AuditLog.js';
import {
  upsertPullRequest,
  setHeadSha,
  updateMergeState,
  getPRByNumber,
} from '../db/queries.js';
import { classifyStalledPR } from '../github/pollUtils.js';

const NOW = '2024-01-01T00:00:00Z';
const REPO = 'owner/repo';
let n = 100;

function insertPR(headSha: string | null, mergeState: string | null): number {
  const prNumber = n++;
  upsertPullRequest({
    pr_number: prNumber,
    pr_url: `https://github.com/${REPO}/pull/${prNumber}`,
    task_id: null,
    session_id: null,
    repo: REPO,
    title: 'PR',
    body: null,
    head_branch: 'feature/x',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: null,
    review_at: null,
    created_at: NOW,
    updated_at: NOW,
    synced_at: NOW,
    head_sha: headSha,
    node_id: null,
    mergeable: mergeState === 'dirty' ? 0 : null,
    merge_state: mergeState,
    merge_state_checked_at: mergeState ? NOW : null,
  });
  return prNumber;
}

function reupsert(prNumber: number, headSha: string | null): void {
  upsertPullRequest({
    pr_number: prNumber,
    pr_url: `https://github.com/${REPO}/pull/${prNumber}`,
    task_id: null,
    session_id: null,
    repo: REPO,
    title: 'PR',
    body: null,
    head_branch: 'feature/x',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: null,
    review_at: null,
    created_at: NOW,
    updated_at: NOW,
    synced_at: NOW,
    head_sha: headSha,
    node_id: null,
  });
}

function seedFailing(prNumber: number): void {
  updateMergeState(prNumber, REPO, 0, 'dirty', ['ci/test']);
  vi.mocked(recordEvent).mockClear();
}

function mergeStateEvents(): number {
  return vi
    .mocked(recordEvent)
    .mock.calls.filter((c) => c[0].event_type === 'pr_merge_state_changed')
    .length;
}

beforeEach(() => vi.mocked(recordEvent).mockClear());

describe('setHeadSha merge-state reset', () => {
  it('clears the four mergeability fields when the head changes and audits once', () => {
    const pr = insertPR('shaA', null);
    seedFailing(pr);

    setHeadSha(pr, REPO, 'shaB');

    const row = getPRByNumber(pr, REPO)!;
    expect(row.head_sha).toBe('shaB');
    expect(row.mergeable).toBeNull();
    expect(row.merge_state).toBeNull();
    expect(row.merge_state_checked_at).toBeNull();
    expect(row.failing_checks).toBeNull();
    expect(mergeStateEvents()).toBe(1);
  });

  it('leaves the fields alone for the same SHA or a NULL SHA', () => {
    const pr = insertPR('shaA', null);
    seedFailing(pr);

    setHeadSha(pr, REPO, 'shaA');
    setHeadSha(pr, REPO, null);

    const row = getPRByNumber(pr, REPO)!;
    expect(row.merge_state).toBe('dirty');
    expect(row.mergeable).toBe(0);
    expect(row.merge_state_checked_at).not.toBeNull();
    expect(row.failing_checks).not.toBeNull();
    expect(mergeStateEvents()).toBe(0);
  });

  it('emits no audit row when the state was already NULL', () => {
    const pr = insertPR('shaA', null);

    setHeadSha(pr, REPO, 'shaB');

    expect(mergeStateEvents()).toBe(0);
  });

  it('lets the next completed check write the new category', () => {
    const pr = insertPR('shaA', null);
    seedFailing(pr);
    setHeadSha(pr, REPO, 'shaB');

    updateMergeState(pr, REPO, 1, 'clean');

    const row = getPRByNumber(pr, REPO)!;
    expect(row.merge_state).toBe('clean');
    expect(row.mergeable).toBe(1);
  });
});

describe('upsertPullRequest merge-state reset', () => {
  it('resets the fields when a non-null head_sha changes', () => {
    const pr = insertPR('shaA', null);
    seedFailing(pr);

    reupsert(pr, 'shaB');

    const row = getPRByNumber(pr, REPO)!;
    expect(row.head_sha).toBe('shaB');
    expect(row.merge_state).toBeNull();
    expect(row.mergeable).toBeNull();
    expect(row.merge_state_checked_at).toBeNull();
    expect(row.failing_checks).toBeNull();
    expect(mergeStateEvents()).toBe(1);
  });

  it('keeps COALESCE behaviour when head_sha is unchanged or absent', () => {
    const pr = insertPR('shaA', null);
    seedFailing(pr);

    reupsert(pr, 'shaA');
    reupsert(pr, null);

    const row = getPRByNumber(pr, REPO)!;
    expect(row.merge_state).toBe('dirty');
    expect(row.mergeable).toBe(0);
    expect(mergeStateEvents()).toBe(0);
  });
});

describe('classifyStalledPR after head move (#1926 shape)', () => {
  it('does not return conflict_dead_session once the head moved off a dirty reading', () => {
    const pr = insertPR('shaA', null);
    seedFailing(pr);

    const before = getPRByNumber(pr, REPO)!;
    before.review_result = JSON.stringify({ verdict: 'approved' });
    expect(classifyStalledPR(before, 'idle')?.kind).toBe(
      'conflict_dead_session',
    );

    setHeadSha(pr, REPO, 'shaB');
    const after = getPRByNumber(pr, REPO)!;
    after.review_result = JSON.stringify({ verdict: 'approved' });
    expect(classifyStalledPR(after, 'idle')?.kind).not.toBe(
      'conflict_dead_session',
    );
  });
});
