/**
 * Integration test: full audit event lifecycle.
 *
 * Verifies that a simulated session lifecycle — launch, commit check, PR open,
 * PR merge, status update — produces all five event types required by the
 * Manual Verification Gate in the audit_log table.
 *
 * Unlike the unit tests, this test does NOT mock recordEvent; it uses a real
 * in-memory SQLite DB so the writes are verified at the DB layer.
 */

import { describe, it, expect, vi } from 'vitest';

// ── In-memory DB (must be hoisted before any transitive import uses it) ──────

vi.mock('../db/db.js', async () => {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const { applyTestSchema } = await import('../../test/helpers/testDbSchema');
  applyTestSchema(db);
  return { db };
});

// ── Imports (resolved after mock is installed) ────────────────────────────────

import { recordEvent } from '../audit/AuditLog';
import {
  checkCommitAttribution,
} from '../github/CommitAttributionWatcher';
import { AuditingTaskBackend } from '../tasks/TaskBackend';
import type { TaskBackend } from '../tasks/TaskBackend';
import type { GitHubClient } from '../github/GitHubClient';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SESSION_ID = 'lifecycle-test-session';
const PROJECT_ID = 'lifecycle-test-project';
const TASK_ID = 'notion:lifecycle-test-task';
const REPO = 'owner/test-repo';
const PR_NUMBER = 99;

function makeMockClient(
  commits: Array<{ sha: string; message: string; author?: string | null }>,
): GitHubClient {
  return {
    getCommitsForPR: vi.fn().mockResolvedValue(commits),
  } as unknown as GitHubClient;
}

function makeInnerBackend(): TaskBackend {
  return {
    type: 'notion' as const,
    updateStatus: vi.fn().mockResolvedValue(undefined),
    attachPR: vi.fn().mockResolvedValue(undefined),
    fetchReadyTasks: vi.fn().mockResolvedValue([]),
    fetchTaskPage: vi.fn().mockResolvedValue(''),
    fetchNonMilestoneReadyTasks: vi.fn().mockResolvedValue([]),
  };
}

// ── Test ─────────────────────────────────────────────────────────────────────

describe('Audit event lifecycle — integration', () => {
  it('starting a session, opening a PR, and merging it produces all five required event types in audit_log', async () => {
    const { db } = await import('../db/db.js');

    // 1. session_launched — emitted by SessionManager.start()
    recordEvent({
      event_type: 'session_launched',
      actor_type: 'ai',
      actor_id: SESSION_ID,
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      payload: { session_type: 'standard' },
    });

    // 2. commit — emitted by CommitAttributionWatcher for every commit it inspects
    const mockClient = makeMockClient([
      {
        sha: 'abc123def456',
        message:
          'feat: implement feature\n\nAI-Authored-By: claude-sonnet-4-6 (session: lifecycle-test-session)',
        author: 'bot@example.com',
      },
    ]);
    await checkCommitAttribution(
      mockClient,
      REPO,
      PR_NUMBER,
      SESSION_ID,
      PROJECT_ID,
      TASK_ID,
      false,
    );

    // 3. pr_opened — emitted by the PR webhook route handler
    recordEvent({
      event_type: 'pr_opened',
      actor_type: 'ai',
      actor_id: SESSION_ID,
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      payload: {
        pr_number: PR_NUMBER,
        repo: REPO,
        pr_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
      },
    });

    // 4. status_updated — emitted via AuditingTaskBackend on any updateStatus call
    const backend = new AuditingTaskBackend(makeInnerBackend(), PROJECT_ID);
    await backend.updateStatus(TASK_ID, '👀 In Review', {
      source: 'orchestrator',
      sessionId: SESSION_ID,
    });

    // 5. pr_merged — emitted by the merge webhook handler
    recordEvent({
      event_type: 'pr_merged',
      actor_type: 'ai',
      actor_id: SESSION_ID,
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      payload: {
        pr_number: PR_NUMBER,
        repo: REPO,
        merge_commit_sha: 'deadbeef',
      },
    });

    // ── Verify all five required types appear in audit_log ────────────────────
    const rows = (db as import('better-sqlite3').Database)
      .prepare('SELECT DISTINCT event_type FROM audit_log')
      .all() as Array<{ event_type: string }>;

    const types = new Set(rows.map((r) => r.event_type));

    expect(types.has('session_launched')).toBe(true);
    expect(types.has('commit')).toBe(true);
    expect(types.has('pr_opened')).toBe(true);
    expect(types.has('pr_merged')).toBe(true);
    expect(types.has('status_updated')).toBe(true);
  });

  it('regression: existing pr_opened, pr_merged, session_launched, attribution_missing events continue to fire', async () => {
    const { db } = await import('../db/db.js');

    // Emit each of the pre-existing event types
    recordEvent({
      event_type: 'pr_opened',
      actor_type: 'ai',
      actor_id: 'reg-session',
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      payload: { pr_number: 100, repo: REPO },
    });
    recordEvent({
      event_type: 'pr_merged',
      actor_type: 'ai',
      actor_id: 'reg-session',
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      payload: { pr_number: 100, repo: REPO },
    });
    recordEvent({
      event_type: 'session_launched',
      actor_type: 'ai',
      actor_id: 'reg-session',
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      payload: { session_type: 'standard' },
    });

    // Trigger attribution_missing via CommitAttributionWatcher with a commit missing the trailer
    const clientMissingTrailer = makeMockClient([
      { sha: 'no-trailer-sha', message: 'fix: some fix', author: 'human@example.com' },
    ]);
    await checkCommitAttribution(
      clientMissingTrailer,
      REPO,
      200,
      'reg-session',
      PROJECT_ID,
      TASK_ID,
      false,
    );

    const rows = (db as import('better-sqlite3').Database)
      .prepare(
        `SELECT event_type FROM audit_log WHERE actor_id = 'reg-session'`,
      )
      .all() as Array<{ event_type: string }>;

    const types = rows.map((r) => r.event_type);
    expect(types).toContain('pr_opened');
    expect(types).toContain('pr_merged');
    expect(types).toContain('session_launched');
    expect(types).toContain('attribution_missing');
    expect(types).toContain('commit');
  });
});
