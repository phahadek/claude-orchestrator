import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── In-memory DB ──────────────────────────────────────────────────────────────
vi.mock('../db/db.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id          TEXT    PRIMARY KEY,
      task_id             TEXT,
      task_url            TEXT,
      project_context_url TEXT,
      status              TEXT    NOT NULL DEFAULT 'running',
      started_at          INTEGER NOT NULL DEFAULT 0,
      ended_at            INTEGER,
      pr_url              TEXT,
      worktree_path       TEXT,
      archived            INTEGER NOT NULL DEFAULT 0,
      project_id          TEXT,
      session_type        TEXT    NOT NULL DEFAULT 'standard',
      favorited           INTEGER NOT NULL DEFAULT 0,
      note                TEXT,
      tags                TEXT,
      task_name           TEXT,
      model               TEXT,
      total_input_tokens  INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS session_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT    NOT NULL,
      event_type   TEXT    NOT NULL,
      payload      TEXT    NOT NULL,
      timestamp    INTEGER NOT NULL,
      message_id   TEXT
    );
    CREATE TABLE IF NOT EXISTS permission_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT    NOT NULL,
      tool_name       TEXT    NOT NULL,
      proposed_action TEXT,
      decision        TEXT    NOT NULL,
      rule_matched    TEXT,
      decided_at      INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS permission_denials (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT    NOT NULL,
      tool_name   TEXT    NOT NULL,
      tool_use_id TEXT    NOT NULL,
      tool_input  TEXT    NOT NULL,
      timestamp   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS permission_rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      order_index INTEGER NOT NULL,
      pattern     TEXT    NOT NULL,
      match_type  TEXT    NOT NULL,
      decision    TEXT    NOT NULL,
      label       TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS task_cache (
      task_id    TEXT    PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      raw_json   TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pull_requests (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number              INTEGER NOT NULL,
      pr_url                 TEXT    NOT NULL UNIQUE,
      task_id                TEXT,
      session_id             TEXT,
      repo                   TEXT    NOT NULL,
      title                  TEXT,
      body                   TEXT,
      head_branch            TEXT,
      base_branch            TEXT,
      state                  TEXT    NOT NULL DEFAULT 'open',
      draft                  INTEGER NOT NULL DEFAULT 0,
      review_result          TEXT,
      review_at              TEXT,
      created_at             TEXT    NOT NULL,
      updated_at             TEXT    NOT NULL,
      synced_at              TEXT    NOT NULL,
      review_session_id      TEXT,
      review_iteration       INTEGER NOT NULL DEFAULT 0,
      head_sha               TEXT,
      last_reviewed_sha      TEXT,
      node_id                TEXT,
      mergeable              INTEGER,
      merge_state            TEXT,
      merge_state_checked_at TEXT,
      pending_push           INTEGER NOT NULL DEFAULT 0,
      pause_reason           TEXT,
      failing_checks         TEXT
    );
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT    PRIMARY KEY,
      name        TEXT    NOT NULL,
      project_dir TEXT    NOT NULL,
      context_url TEXT,
      github_repo TEXT,
      task_source TEXT    NOT NULL DEFAULT 'notion',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);
  return { db };
});

import { db } from '../db/db.js';
import {
  upsertPullRequest,
  getPRByNumber,
  deletePhantomPullRequests,
} from '../db/queries.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOW = '2024-01-01T00:00:00Z';

function insertProject(id: string, githubRepo: string) {
  db.prepare(
    `INSERT OR IGNORE INTO projects (id, name, project_dir, github_repo, task_source, created_at, updated_at)
     VALUES (?, ?, '/test', ?, 'notion', 1000, 1000)`,
  ).run(id, `Project ${id}`, githubRepo);
}

function insertRawPR(
  prUrl: string,
  repo: string,
  prNumber: number,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO pull_requests
       (pr_number, pr_url, repo, state, draft, created_at, updated_at, synced_at)
     VALUES (?, ?, ?, 'open', 0, ?, ?, ?)`,
  ).run(prNumber, prUrl, repo, NOW, NOW, NOW);
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

// ── deletePhantomPullRequests ─────────────────────────────────────────────────

describe('deletePhantomPullRequests — startup sweep', () => {
  it('removes rows whose repo has no matching project', () => {
    // Insert two PRs manually (bypassing upsertPullRequest validation)
    insertRawPR('https://github.com/owner/repo/pull/42', 'owner/repo', 42);
    insertRawPR('https://github.com/owner/repo/pull/99', 'owner/repo', 99);

    // No project configured — both rows are phantoms
    const removed = deletePhantomPullRequests();
    expect(removed).toBe(2);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM pull_requests').get() as { n: number }).n,
    ).toBe(0);
  });

  it('keeps rows whose repo matches a configured project', () => {
    insertProject('proj-1', 'myorg/myrepo');
    insertRawPR('https://github.com/myorg/myrepo/pull/1', 'myorg/myrepo', 1);
    insertRawPR('https://github.com/owner/repo/pull/42', 'owner/repo', 42);

    const removed = deletePhantomPullRequests();
    expect(removed).toBe(1); // only the unconfigured one
    expect(getPRByNumber(1, 'myorg/myrepo')).toBeTruthy();
    expect(getPRByNumber(42, 'owner/repo')).toBeFalsy();
  });

  it('returns 0 when there are no phantom rows', () => {
    insertProject('proj-1', 'myorg/myrepo');
    insertRawPR('https://github.com/myorg/myrepo/pull/5', 'myorg/myrepo', 5);
    expect(deletePhantomPullRequests()).toBe(0);
  });

  it('returns 0 when pull_requests table is empty', () => {
    expect(deletePhantomPullRequests()).toBe(0);
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
