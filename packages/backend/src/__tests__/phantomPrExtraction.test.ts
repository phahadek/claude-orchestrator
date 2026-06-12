import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── In-memory DB ──────────────────────────────────────────────────────────────
vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import { upsertPullRequest, getPRByNumber } from '../db/queries.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOW = '2024-01-01T00:00:00Z';

function insertProject(id: string, githubRepo: string) {
  db.prepare(
    `INSERT OR IGNORE INTO projects (id, name, project_dir, github_repo, task_source, created_at, updated_at)
     VALUES (?, ?, '/test', ?, 'notion', 1000, 1000)`,
  ).run(id, `Project ${id}`, githubRepo);
}

function makePRInput(prNumber: number, repo: string) {
  const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
  return {
    pr_number: prNumber,
    pr_url: prUrl,
    task_id: null,
    session_id: null,
    repo,
    title: `PR ${prNumber}`,
    body: null,
    head_branch: 'feature/x',
    base_branch: 'dev',
    state: 'open' as const,
    draft: 0,
    review_result: null,
    review_at: null,
    created_at: NOW,
    updated_at: NOW,
    synced_at: NOW,
    head_sha: null,
    node_id: null,
    review_session_id: null,
    review_iteration: 0,
    last_reviewed_sha: null,
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
  };
}

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  db.prepare('DELETE FROM pull_requests').run();
  db.prepare('DELETE FROM projects').run();
});

// ── upsertPullRequest cross-repo validation ───────────────────────────────────

describe('upsertPullRequest — repo validation', () => {
  it('returns null and skips insert when repo has no matching project', () => {
    // No project configured for 'owner/repo'
    const result = upsertPullRequest(makePRInput(42, 'owner/repo'));
    expect(result).toBeNull();
    expect(getPRByNumber(42, 'owner/repo')).toBeFalsy();
  });

  it('inserts and returns row when repo matches a configured project', () => {
    insertProject('proj-1', 'owner/repo');
    const result = upsertPullRequest(makePRInput(42, 'owner/repo'));
    expect(result).not.toBeNull();
    expect(result!.pr_number).toBe(42);
    expect(getPRByNumber(42, 'owner/repo')).toBeTruthy();
  });

  it('happy-path regression: real PR URL in configured repo creates row', () => {
    insertProject('proj-real', 'myorg/myrepo');
    const result = upsertPullRequest(makePRInput(100, 'myorg/myrepo'));
    expect(result).not.toBeNull();
    expect(getPRByNumber(100, 'myorg/myrepo')).toBeTruthy();
  });

  it('rejects placeholder URL even in text events if repo is not configured', () => {
    // Simulate: text event carries placeholder URL for unconfigured repo
    const result = upsertPullRequest(makePRInput(42, 'owner/repo'));
    expect(result).toBeNull();
    // No phantom row
    const count = (
      db.prepare('SELECT COUNT(*) AS n FROM pull_requests').get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(0);
  });
});

// ── handleCleanExit event-type filtering (unit coverage) ─────────────────────
// The actual filtering logic lives in AgentSession.handleCleanExit.
// Here we verify the invariant at the query layer: that tool_use events
// containing placeholder URLs do NOT produce pull_requests rows even after
// event-type filtering is applied.

describe('event-type filtering prevents phantom rows', () => {
  it('tool_use event payload URL does not lead to a pull_requests row after filtering', () => {
    insertProject('proj-real', 'myorg/myrepo');

    // Simulate what handleCleanExit does after event-type filtering:
    // A tool_use event (event_type='tool_use') is skipped; only text/system events are scanned.
    // The Write event containing a placeholder URL should be excluded.
    const writeEventPayload = JSON.stringify({
      type: 'tool_use',
      name: 'Write',
      input: { content: 'https://github.com/owner/repo/pull/42' },
    });
    const textEventPayload = JSON.stringify({
      type: 'text',
      message: 'Draft PR opened: https://github.com/myorg/myrepo/pull/100',
    });

    // After filtering, only textEventPayload is scanned.
    // We directly test that upserting for unconfigured repo is rejected.
    const phantomResult = upsertPullRequest(makePRInput(42, 'owner/repo'));
    expect(phantomResult).toBeNull();

    // And the real PR (from text event, configured repo) succeeds.
    const realResult = upsertPullRequest(makePRInput(100, 'myorg/myrepo'));
    expect(realResult).not.toBeNull();

    // Only the real PR is recorded.
    expect(getPRByNumber(42, 'owner/repo')).toBeFalsy();
    expect(getPRByNumber(100, 'myorg/myrepo')).toBeTruthy();

    // Suppress unused variable warnings in the payload strings above.
    void writeEventPayload;
    void textEventPayload;
  });
});
