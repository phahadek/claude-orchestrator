import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () => ({
  setPauseReason: vi.fn(),
  getPRByNumber: vi.fn(),
  setCiRemediationAttemptedSha: vi.fn(),
  updateMergeState: vi.fn(),
  getApprovedOpenPRs: vi.fn(() => []),
  getApprovedLocalBranches: vi.fn(() => []),
}));

vi.mock('../config.js', () => ({
  GITHUB_TOKEN: 'test-token',
  GITHUB_REPO: 'owner/repo',
  getProjectByGithubRepo: vi.fn(() => ({
    id: 'proj-1',
    projectDir: '/tmp/proj',
    autoMergeEnabled: true,
  })),
  getProjectById: vi.fn(),
  runtimeSettings: {
    ci_poll_interval_seconds: 5,
    ci_poll_max_minutes: 60,
  },
}));

vi.mock('../routes/tasks.js', () => ({
  emitTaskUpdated: vi.fn(),
}));

vi.mock('../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi.fn(() => ({ ci_check_name: [] })),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import {
  isBillingBlockedAnnotation,
  type CheckRunAnnotation,
} from '../github/GitHubClient.js';
import { GitHubClient } from '../github/GitHubClient.js';
import { AutoMerger } from '../github/AutoMerger.js';
import * as queries from '../db/queries.js';
import type { PullRequestRow } from '../db/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const BILLING_ANNOTATION: CheckRunAnnotation = {
  annotation_level: 'failure',
  path: '.github',
  message:
    "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings",
  raw_details: null,
};

const NORMAL_ANNOTATION: CheckRunAnnotation = {
  annotation_level: 'failure',
  path: 'src/index.ts',
  message: 'Type error: cannot assign null to string',
  raw_details: null,
};

function makePRRow(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: 42,
    pr_url: 'https://github.com/owner/repo/pull/42',
    task_id: 'task-1',
    session_id: 'sess-1',
    repo: 'owner/repo',
    title: 'Test PR',
    body: null,
    head_branch: 'feature/test',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: JSON.stringify({ verdict: 'approved' }),
    review_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    synced_at: '2024-01-01T00:00:00Z',
    review_session_id: null,
    review_iteration: 1,
    head_sha: 'abc123',
    last_reviewed_sha: null,
    node_id: null,
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
    failing_checks: null,
    pending_push: 0,
    pause_reason: null,
    ci_remediation_attempted_sha: null,
    ...overrides,
  };
}

// ── isBillingBlockedAnnotation tests ─────────────────────────────────────────

describe('isBillingBlockedAnnotation', () => {
  it('returns true for the confirmed billing message', () => {
    expect(isBillingBlockedAnnotation(BILLING_ANNOTATION)).toBe(true);
  });

  it('returns true for spending-limit variant', () => {
    expect(
      isBillingBlockedAnnotation({
        ...BILLING_ANNOTATION,
        message:
          'The job was not started because your spending limit needs to be increased.',
      }),
    ).toBe(true);
  });

  it('returns false for a normal code-failure annotation', () => {
    expect(isBillingBlockedAnnotation(NORMAL_ANNOTATION)).toBe(false);
  });

  it('returns false for empty annotations array element with wrong path', () => {
    expect(
      isBillingBlockedAnnotation({
        annotation_level: 'failure',
        path: 'src/other.ts',
        message: BILLING_ANNOTATION.message,
        raw_details: null,
      }),
    ).toBe(false);
  });

  it('returns false when annotation_level is not failure', () => {
    expect(
      isBillingBlockedAnnotation({
        ...BILLING_ANNOTATION,
        annotation_level: 'warning',
      }),
    ).toBe(false);
  });

  it('returns false when message does not match the billing prefix', () => {
    expect(
      isBillingBlockedAnnotation({
        ...BILLING_ANNOTATION,
        message: 'Some other error occurred',
      }),
    ).toBe(false);
  });
});

// ── GitHubClient.fetchCheckRunAnnotations round-trip ─────────────────────────

describe('GitHubClient.fetchCheckRunAnnotations', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches and returns annotations for a check run', async () => {
    const annotations = [BILLING_ANNOTATION, NORMAL_ANNOTATION];
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => annotations,
    });

    const client = new GitHubClient();
    const result = await client.fetchCheckRunAnnotations('owner/repo', 12345);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/repos/owner/repo/check-runs/12345/annotations'),
      expect.any(Object),
    );
    expect(result).toHaveLength(2);
    expect(result[0].path).toBe('.github');
    expect(result[1].path).toBe('src/index.ts');
  });

  it('returns empty array when check run has no annotations', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => [],
    });

    const client = new GitHubClient();
    const result = await client.fetchCheckRunAnnotations('owner/repo', 99999);
    expect(result).toEqual([]);
  });
});

// ── GitHubClient.detectBillingBlock ──────────────────────────────────────────

describe('GitHubClient.detectBillingBlock', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns blocked=true when a failing check has the billing annotation', async () => {
    // First call: check-runs for SHA
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        check_runs: [{ id: 111, status: 'completed', conclusion: 'failure' }],
      }),
    });
    // Second call: annotations for check run 111
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => [BILLING_ANNOTATION],
    });

    const client = new GitHubClient();
    const result = await client.detectBillingBlock('abc123', 'owner/repo');

    expect(result.blocked).toBe(true);
    expect(result.message).toContain('The job was not started because');
  });

  it('returns blocked=false when annotations are normal code failures', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        check_runs: [{ id: 222, status: 'completed', conclusion: 'failure' }],
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => [NORMAL_ANNOTATION],
    });

    const client = new GitHubClient();
    const result = await client.detectBillingBlock('abc123', 'owner/repo');

    expect(result.blocked).toBe(false);
    expect(result.message).toBeNull();
  });

  it('returns blocked=false when no failing checks', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        check_runs: [{ id: 333, status: 'completed', conclusion: 'success' }],
      }),
    });

    const client = new GitHubClient();
    const result = await client.detectBillingBlock('abc123', 'owner/repo');

    expect(result.blocked).toBe(false);
    // Should not have fetched annotations for a passing check
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns blocked=false for empty annotations array', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        check_runs: [{ id: 444, status: 'completed', conclusion: 'failure' }],
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => [],
    });

    const client = new GitHubClient();
    const result = await client.detectBillingBlock('abc123', 'owner/repo');

    expect(result.blocked).toBe(false);
  });
});

// ── AutoMerger — billing-block behavior ──────────────────────────────────────

describe('AutoMerger ci_billing_blocked behavior', () => {
  let broadcast: ReturnType<typeof vi.fn>;
  let mockGithub: {
    fetchPRStatusConditional: ReturnType<typeof vi.fn>;
    detectBillingBlock: ReturnType<typeof vi.fn>;
    categorizeMergeability: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    broadcast = vi.fn();
    mockGithub = {
      fetchPRStatusConditional: vi.fn(),
      detectBillingBlock: vi.fn(),
      categorizeMergeability: vi.fn(),
    };
    vi.clearAllMocks();
  });

  it('sets pause_reason=ci_billing_blocked and broadcasts when billing-blocked', async () => {
    const prRow = makePRRow();
    vi.mocked(queries.getPRByNumber).mockReturnValue(prRow);

    // Poll returns ci_failed
    mockGithub.fetchPRStatusConditional.mockResolvedValue({
      status: 'ok',
      etag: null,
      state: 'open',
      mergeability: {
        category: 'ci_failed',
        mergeState: 'ci_failed',
        rawMergeableState: 'blocked',
        failingChecks: [{ name: 'build', conclusion: 'failure' }],
        headSha: 'abc123',
      },
    });

    // detectBillingBlock returns blocked=true
    mockGithub.detectBillingBlock.mockResolvedValue({
      blocked: true,
      message: BILLING_ANNOTATION.message,
    });

    const mockMergeWatcher = {} as never;
    const autoMerger = new AutoMerger(
      mockGithub as never,
      mockMergeWatcher,
      broadcast,
    );

    await autoMerger['run'](42, 'owner/repo');

    expect(vi.mocked(queries.setPauseReason)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'ci_billing_blocked',
    );
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ci_billing_blocked',
        prNumber: 42,
        repo: 'owner/repo',
      }),
    );
  });

  it('does NOT send ci_billing_blocked when annotations are normal failures', async () => {
    const prRow = makePRRow();
    vi.mocked(queries.getPRByNumber).mockReturnValue(prRow);

    mockGithub.fetchPRStatusConditional.mockResolvedValue({
      status: 'ok',
      etag: null,
      state: 'open',
      mergeability: {
        category: 'ci_failed',
        mergeState: 'ci_failed',
        rawMergeableState: 'blocked',
        failingChecks: [{ name: 'lint', conclusion: 'failure' }],
        headSha: 'abc123',
      },
    });

    // detectBillingBlock returns blocked=false
    mockGithub.detectBillingBlock.mockResolvedValue({
      blocked: false,
      message: null,
    });

    const mockMergeWatcher = {} as never;
    const autoMerger = new AutoMerger(
      mockGithub as never,
      mockMergeWatcher,
      broadcast,
    );

    await autoMerger['run'](42, 'owner/repo');

    // Should set ci_failing, NOT ci_billing_blocked
    expect(vi.mocked(queries.setPauseReason)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'ci_failing',
    );
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ci_billing_blocked' }),
    );
  });

  it('falls back to ci_failing when detectBillingBlock has no headSha', async () => {
    const prRow = makePRRow();
    vi.mocked(queries.getPRByNumber).mockReturnValue(prRow);

    mockGithub.fetchPRStatusConditional.mockResolvedValue({
      status: 'ok',
      etag: null,
      state: 'open',
      mergeability: {
        category: 'ci_failed',
        mergeState: 'ci_failed',
        rawMergeableState: 'blocked',
        failingChecks: [{ name: 'build', conclusion: 'failure' }],
        headSha: null, // No SHA available
      },
    });

    const mockMergeWatcher = {} as never;
    const autoMerger = new AutoMerger(
      mockGithub as never,
      mockMergeWatcher,
      broadcast,
    );

    await autoMerger['run'](42, 'owner/repo');

    // Should NOT call detectBillingBlock when there's no headSha
    expect(mockGithub.detectBillingBlock).not.toHaveBeenCalled();
    expect(vi.mocked(queries.setPauseReason)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'ci_failing',
    );
  });
});
