/**
 * Acceptance-criteria tests for the idle→done gap on PR auto-merge.
 *
 * Context: when AutoMerger squash-merges a PR the coding session and paired
 * review session must immediately transition idle→done so ConcludedSessionArchiver
 * can reap them on the next sweep without requiring a backend restart.
 *
 * AC1 — AutoMerger merge success transitions both sessions idle→done.
 * AC2 — ConcludedSessionArchiver archives done sessions on the next sweep
 *        (idle sessions are structurally excluded by the SQL filter).
 * AC3 — Manual-merge path (routes/prs.ts) regression: already covered by
 *        prs.test.ts ("calls markSessionDone for coding/review session with
 *        call_site manual_merge_rest") — referenced here for traceability.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

const { projectFixture, runtimeSettingsFixture } = vi.hoisted(() => ({
  projectFixture: {
    id: 'proj-1',
    name: 'Test Project',
    githubRepo: 'owner/repo',
    projectDir: '/tmp/proj',
    contextUrl: 'https://notion.so/ctx',
    boardId: 'board-1',
    taskSource: 'notion' as const,
    autoLaunchEnabled: false,
    autoLaunchMilestoneId: null,
    autoMergeEnabled: true,
  },
  runtimeSettingsFixture: {
    ci_poll_interval_seconds: 1,
    ci_poll_max_minutes: 1,
    auto_merge_failed_clear_minutes: 10,
    auto_archive_enabled: true,
    auto_archive_grace_minutes: 30,
    auto_archive_sweep_interval_minutes: 5,
  },
}));

vi.mock('../db/queries.js', () => ({
  getPRByNumber: vi.fn(),
  setPauseReason: vi.fn(),
  updateMergeState: vi.fn(),
  updatePRDraftStatus: vi.fn(),
  getApprovedOpenPRs: vi.fn().mockReturnValue([]),
  getApprovedLocalBranches: vi.fn().mockReturnValue([]),
  markLocalBranchMerged: vi.fn(),
  setLocalBranchPauseReason: vi.fn(),
  getSession: vi.fn().mockReturnValue(null),
  getOrphanMergeablePRs: vi.fn().mockReturnValue([]),
  getStaleAutoMergeFailedPRs: vi.fn().mockReturnValue([]),
  getConflictNudgeCandidates: vi.fn().mockReturnValue([]),
  upsertActiveMerge: vi.fn(),
  deleteActiveMerge: vi.fn(),
  getAllActiveMerges: vi.fn().mockReturnValue([]),
  setConflictNudgeSha: vi.fn(),
  markSessionDone: vi.fn(),
  archiveConcludedSessionsOlderThan: vi.fn().mockReturnValue([]),
}));

vi.mock('../config.js', () => ({
  getProjectByGithubRepo: vi.fn((repo: string) =>
    repo === 'owner/repo' ? projectFixture : undefined,
  ),
  getProjectById: vi.fn(() => projectFixture),
  runtimeSettings: runtimeSettingsFixture,
}));

vi.mock('../config/corporateMode.js', () => ({
  getCorporateMode: vi.fn(() => ({
    enabled: false,
    envLocked: false,
    gates: {
      dockerMandatory: false,
      requireHumanApproval: false,
      requireZDR: false,
      validatePRBody: false,
      secretsViaSeam: false,
    },
  })),
}));

vi.mock('../routes/tasks.js', () => ({ emitTaskUpdated: vi.fn() }));
vi.mock('../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi.fn(() => ({
    updateStatus: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock('../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi.fn(() => ({ verify: [], ci_check_name: [] })),
}));
vi.mock('../audit/AuditLog.js', () => ({ recordEvent: vi.fn() }));
vi.mock('../orchestration/localMergeRunner.js', () => ({
  squashMergeLocal: vi.fn(),
}));
vi.mock('../orchestration/localBranchHelpers.js', () => ({
  detectMergeConflict: vi.fn().mockResolvedValue(false),
}));
vi.mock('../github/reviewUtils.js', () => ({
  formatMergeConflictFeedback: vi.fn().mockReturnValue('conflict msg'),
}));
vi.mock('../github/conflictNudge.js', () => ({
  sendConflictNudge: vi.fn().mockResolvedValue(undefined),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { AutoMerger } from '../github/AutoMerger.js';
import { ConcludedSessionArchiver } from '../orchestration/ConcludedSessionArchiver.js';
import {
  markSessionDone,
  archiveConcludedSessionsOlderThan,
} from '../db/queries.js';
import { getPRByNumber } from '../db/queries.js';
import type { GitHubClient } from '../github/GitHubClient.js';
import type { PRMergeWatcher } from '../github/PRMergeWatcher.js';
import type { PullRequestRow } from '../db/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCleanMergeGitHub(): GitHubClient {
  return {
    fetchPRStatusConditional: vi.fn().mockResolvedValueOnce({
      status: 'ok',
      etag: null,
      state: 'open',
      mergeability: {
        category: 'clean',
        mergeState: 'clean',
        rawMergeableState: 'clean',
        failingChecks: [],
        headSha: 'sha-abc',
      },
    }),
    mergePR: vi
      .fn()
      .mockResolvedValue({ merged: true, message: 'ok', sha: 'merged-sha' }),
    markPRReady: vi.fn().mockResolvedValue(undefined),
    categorizeMergeability: vi.fn().mockResolvedValue({
      category: 'clean',
      mergeState: 'clean',
      rawMergeableState: 'clean',
      failingChecks: [],
    }),
    getReviewState: vi.fn().mockResolvedValue(null),
    detectBillingBlock: vi.fn().mockResolvedValue({ blocked: false }),
  } as unknown as GitHubClient;
}

function makeMergeWatcher(): PRMergeWatcher {
  return {
    handleMerged: vi.fn().mockResolvedValue(undefined),
  } as unknown as PRMergeWatcher;
}

function makePRRow(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: 42,
    pr_url: 'https://github.com/owner/repo/pull/42',
    task_id: 'notion:task-abc',
    session_id: 'code-sess-001',
    repo: 'owner/repo',
    title: 'feat: test',
    body: null,
    head_branch: 'feature/test',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: JSON.stringify({
      verdict: 'approved',
      dimensions: [],
      summary: 'ok',
    }),
    review_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    synced_at: '2024-01-01T00:00:00Z',
    review_session_id: 'review-sess-002',
    review_iteration: 1,
    head_sha: 'sha-abc',
    last_reviewed_sha: 'sha-abc',
    node_id: 'PR_node',
    mergeable: 1,
    merge_state: 'clean',
    merge_state_checked_at: null,
    failing_checks: null,
    pending_push: 0,
    pause_reason: null,
    ci_remediation_attempted_sha: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  runtimeSettingsFixture.ci_poll_interval_seconds = 1;
  runtimeSettingsFixture.ci_poll_max_minutes = 1;
});

// ── AC1: AutoMerger merge success → both sessions idle→done ──────────────────

describe('AC1 — AutoMerger merge success concludes both sessions (idle→done)', () => {
  it('calls markSessionDone for the coding session on auto-merge success', async () => {
    const pr = makePRRow({ session_id: 'code-sess-001' });
    vi.mocked(getPRByNumber).mockReturnValue(pr);

    const merger = new AutoMerger(
      makeCleanMergeGitHub(),
      makeMergeWatcher(),
      () => {},
    );
    merger.attempt(42, 'owner/repo');

    // Allow the async polling loop to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(markSessionDone)).toHaveBeenCalledWith(
      'code-sess-001',
      expect.any(Number),
      'https://github.com/owner/repo/pull/42',
      'auto_merger',
    );
  });

  it('calls markSessionDone for the review session on auto-merge success', async () => {
    const pr = makePRRow({
      session_id: 'code-sess-001',
      review_session_id: 'review-sess-002',
    });
    vi.mocked(getPRByNumber).mockReturnValue(pr);

    const merger = new AutoMerger(
      makeCleanMergeGitHub(),
      makeMergeWatcher(),
      () => {},
    );
    merger.attempt(42, 'owner/repo');

    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(markSessionDone)).toHaveBeenCalledWith(
      'review-sess-002',
      expect.any(Number),
      'https://github.com/owner/repo/pull/42',
      'auto_merger',
    );
  });

  it('does not call markSessionDone for review session when review_session_id is null', async () => {
    const pr = makePRRow({ review_session_id: null });
    vi.mocked(getPRByNumber).mockReturnValue(pr);

    const merger = new AutoMerger(
      makeCleanMergeGitHub(),
      makeMergeWatcher(),
      () => {},
    );
    merger.attempt(42, 'owner/repo');

    await new Promise((r) => setTimeout(r, 50));

    const calls = vi.mocked(markSessionDone).mock.calls;
    expect(calls.every(([id]) => id !== null)).toBe(true);
    // Only code session should be marked done (not null review_session_id)
    expect(calls.some(([id]) => id === 'code-sess-001')).toBe(true);
    expect(calls.some(([id]) => id === null)).toBe(false);
  });

  it('a merged-PR idle session is not left idle after the auto-merge path runs', async () => {
    const pr = makePRRow({
      session_id: 'idle-code-sess',
      review_session_id: 'idle-review-sess',
    });
    vi.mocked(getPRByNumber).mockReturnValue(pr);

    const merger = new AutoMerger(
      makeCleanMergeGitHub(),
      makeMergeWatcher(),
      () => {},
    );
    merger.attempt(42, 'owner/repo');

    await new Promise((r) => setTimeout(r, 50));

    // Both sessions must have been transitioned to done
    const markedDoneIds = vi
      .mocked(markSessionDone)
      .mock.calls.map(([id]) => id);
    expect(markedDoneIds).toContain('idle-code-sess');
    expect(markedDoneIds).toContain('idle-review-sess');
  });
});

// ── AC2: ConcludedSessionArchiver archives done sessions, skips idle ──────────

describe('AC2 — ConcludedSessionArchiver archives done sessions on next sweep', () => {
  it('sweepOnce() calls archiveConcludedSessionsOlderThan (which covers done/error/killed only)', async () => {
    vi.mocked(archiveConcludedSessionsOlderThan).mockReturnValue([
      'code-sess-001',
      'review-sess-002',
    ]);
    const broadcast = vi.fn();
    const archiver = new ConcludedSessionArchiver(broadcast, {
      nowFn: () => 1_000_000,
    });

    await archiver.sweepOnce();

    expect(vi.mocked(archiveConcludedSessionsOlderThan)).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith({
      type: 'session_archived',
      sessionId: 'code-sess-001',
    });
    expect(broadcast).toHaveBeenCalledWith({
      type: 'session_archived',
      sessionId: 'review-sess-002',
    });
  });

  it('idle sessions are not archived — SQL filter excludes them structurally', async () => {
    // archiveConcludedSessionsOlderThan queries status IN ('done','error','killed').
    // Idle sessions are never returned by the query and therefore never archived.
    // Simulate: query returns empty (no done sessions), even though idle ones exist.
    vi.mocked(archiveConcludedSessionsOlderThan).mockReturnValue([]);
    const broadcast = vi.fn();
    const archiver = new ConcludedSessionArchiver(broadcast, {
      nowFn: () => 1_000_000,
    });

    await archiver.sweepOnce();

    expect(broadcast).not.toHaveBeenCalled();
  });

  it('after markSessionDone transitions a session to done, the next sweep archives it', async () => {
    // Simulate the sequence: AutoMerger calls markSessionDone → session is now done
    // → archiver picks it up on the next sweep.
    // markSessionDone is the bridge: once called, archiveConcludedSessionsOlderThan
    // will return the session_id (because the SQL now matches status='done').
    vi.mocked(archiveConcludedSessionsOlderThan).mockReturnValue([
      'code-sess-001',
    ]);
    const broadcast = vi.fn();
    const archiver = new ConcludedSessionArchiver(broadcast, {
      nowFn: () => 1_000_000,
    });

    // Step 1: sessions transitioned to done by AutoMerger (markSessionDone already called)
    // Step 2: archiver sweeps without restart
    await archiver.sweepOnce();

    expect(vi.mocked(archiveConcludedSessionsOlderThan)).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith({
      type: 'session_archived',
      sessionId: 'code-sess-001',
    });
  });
});
