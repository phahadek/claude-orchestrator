import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks (must come before imports of the modules under test) ──────────────

vi.mock('../db/queries.js', () => ({
  getPRByNumber: vi.fn(),
  setPRReviewResult: vi.fn(),
  getEventsBySession: vi.fn(),
  setReviewSessionId: vi.fn(),
  clearReviewSessionId: vi.fn(),
  updatePRDraftStatus: vi.fn(),
  incrementReviewIteration: vi.fn(),
  setLastReviewedSha: vi.fn(),
  setHeadSha: vi.fn(),
  setLocalBranchReviewResult: vi.fn(),
  getLocalBranchById: vi.fn(),
  getSession: vi.fn().mockReturnValue(null),
  getPRIntentForPR: vi.fn().mockReturnValue(null),
  setPauseReason: vi.fn(),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../tasks/TaskWriteCommands.js', () => ({
  getCachedType: vi.fn().mockReturnValue('💻 Code'),
}));

vi.mock('../db/migrationReservation.js', () => ({
  getReservationForTaskDirSuffix: vi.fn(),
}));

import {
  PRReviewService,
  FetchRetryExhaustedError,
  evaluateMigrationRenumberTolerance,
  extractListedMigrationPaths,
  overrideFilesPathsDimension,
} from './PRReviewService';
import {
  getPRByNumber,
  setPRReviewResult,
  getEventsBySession,
  setReviewSessionId,
  clearReviewSessionId,
  updatePRDraftStatus,
  incrementReviewIteration,
  setLocalBranchReviewResult,
  getLocalBranchById,
  setLastReviewedSha,
  getSession,
  setPauseReason,
} from '../db/queries';
import { recordEvent } from '../audit/AuditLog';
import { getCachedType } from '../tasks/TaskWriteCommands';
import { getReservationForTaskDirSuffix } from '../db/migrationReservation';
import type { GitHubClient } from './GitHubClient';
import { GitHubApiError } from './types';
import type { TaskTrackerBackend } from '../tasks/TaskTrackerBackend';
import type { PullRequest, PRDiff } from './types';
import type { SessionEvent } from '../db/types';
import type { DiffSource } from './DiffSource';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const mockPR: PullRequest = {
  id: 42,
  title: 'feat: add something cool',
  body: 'This PR implements the something cool feature',
  url: 'https://github.com/owner/repo/pull/42',
  apiUrl: 'https://api.github.com/repos/owner/repo/pulls/42',
  headBranch: 'feature/something-cool',
  baseBranch: 'dev',
  state: 'open',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T01:00:00Z',
  mergeableState: 'clean',
  draft: false,
};

const mockDiff: PRDiff = {
  prId: 42,
  diff: 'diff --git a/src/foo.ts b/src/foo.ts\nindex abc..def 100644\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,1 +1,2 @@\n export const foo = 1;\n+export const bar = 2;\n',
  filesChanged: ['src/foo.ts'],
};

const mockTaskBody =
  '## Summary\nImplement the something cool feature for users\n\n' +
  '## Context\nThe implementation should add bar export to foo.ts using the existing pattern\n\n' +
  '## Acceptance Criteria\n- [ ] bar export is added\n- [ ] tsc passes\n\n' +
  '## Files\n- src/foo.ts (update)';

const mockPRRow = {
  id: 1,
  pr_number: 42,
  pr_url: 'https://github.com/owner/repo/pull/42',
  task_id: 'notion:task-abc123',
  session_id: 'session-xyz',
  repo: 'owner/repo',
  title: 'feat: add something cool',
  body: null,
  head_branch: 'feature/something-cool',
  base_branch: 'dev',
  state: 'open',
  draft: 0,
  review_result: null,
  review_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T01:00:00Z',
  synced_at: '2024-01-01T01:00:00Z',
  review_session_id: null,
  review_iteration: 0,
  head_sha: null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockGitHub(): GitHubClient {
  return {
    listOpenPRs: vi.fn().mockResolvedValue([mockPR]),
    fetchPR: vi.fn().mockResolvedValue(mockPR),
    fetchDiff: vi.fn().mockResolvedValue(mockDiff),
    mergePR: vi.fn(),
    getMergeability: vi
      .fn()
      .mockResolvedValue({ mergeable: true, mergeableState: 'clean' }),
    getMergeabilityWithRetry: vi
      .fn()
      .mockResolvedValue({ mergeable: true, mergeableState: 'clean' }),
    markPRReady: vi.fn().mockResolvedValue(undefined),
    listFilePathsAtRef: vi.fn().mockResolvedValue([]),
  } as unknown as GitHubClient;
}

function makeMockNotion(): TaskTrackerBackend {
  return {
    type: 'notion' as const,
    fetchTaskPage: vi.fn().mockResolvedValue(mockTaskBody),
    fetchReadyTasks: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    attachPR: vi.fn(),
  } as unknown as TaskTrackerBackend;
}

function makeMockSessionManager() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    start: vi.fn().mockReturnValue('review-session-id'),
    send: vi.fn(),
    isAlive: vi.fn().mockReturnValue(false),
    sendOrResume: vi.fn().mockResolvedValue('resumed-session-id'),
  });
}

function makeMockDiffSource(diff: string = mockDiff.diff): DiffSource {
  return { fetchDiff: vi.fn().mockResolvedValue(diff) };
}

function makeAssistantEvent(text: string): SessionEvent {
  return {
    id: 1,
    session_id: 'review-session-id',
    event_type: 'text',
    payload: JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    }),
    timestamp: Date.now(),
  };
}

function makeSessionEventMessage(sessionId: string, text: string) {
  return {
    type: 'session_event' as const,
    sessionId,
    eventType: 'text' as const,
    content: JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── tryParseVerdict() — fence stripping and JSON extraction ──────────────────

describe('PRReviewService.tryParseVerdict() — hardened parsing', () => {
  function makeService() {
    return new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );
  }

  const validPayload = {
    verdict: 'approved',
    dimensions: [{ name: 'Diff vs Context spec', passed: true, notes: 'ok' }],
    summary: 'All good.',
  };

  it('parses bare JSON without fences', () => {
    const service = makeService();
    // Access via parseReviewResult with a single event
    const events = [makeAssistantEvent(JSON.stringify(validPayload))];
    const result = service.parseReviewResult(events, 42, 'owner/repo');
    expect(result.verdict).toBe('approved');
  });

  it('strips ```json ... ``` fences and parses inner JSON', () => {
    const service = makeService();
    const fenced = '```json\n' + JSON.stringify(validPayload) + '\n```';
    const events = [makeAssistantEvent(fenced)];
    const result = service.parseReviewResult(events, 42, 'owner/repo');
    expect(result.verdict).toBe('approved');
  });

  it('strips ``` ... ``` fences without language specifier', () => {
    const service = makeService();
    const fenced = '```\n' + JSON.stringify(validPayload) + '\n```';
    const events = [makeAssistantEvent(fenced)];
    const result = service.parseReviewResult(events, 42, 'owner/repo');
    expect(result.verdict).toBe('approved');
  });

  it('extracts JSON from text with preamble and trailing content', () => {
    const service = makeService();
    const withPreamble =
      'Here is my review:\n' +
      JSON.stringify(validPayload) +
      '\nPlease let me know if you need changes.';
    const events = [makeAssistantEvent(withPreamble)];
    const result = service.parseReviewResult(events, 42, 'owner/repo');
    expect(result.verdict).toBe('approved');
  });

  it('returns incomplete verdict when no JSON object is present', () => {
    const service = makeService();
    const events = [makeAssistantEvent('The PR looks good overall!')];
    const result = service.parseReviewResult(events, 42, 'owner/repo');
    expect(result.verdict).toBe('incomplete');
  });
});

// ── parseReviewResult() — last assistant message filtering ───────────────────

describe('PRReviewService.parseReviewResult() — last assistant message only', () => {
  function makeService() {
    return new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );
  }

  it('ignores text from earlier assistant messages (tool call pollution)', () => {
    const service = makeService();

    // First assistant message contains tool call output — not a verdict
    const toolCallEvent = makeAssistantEvent('Fetching Notion context...');

    // Last assistant message contains the verdict
    const verdictPayload = {
      verdict: 'needs_changes',
      dimensions: [
        {
          name: 'Diff vs Acceptance Criteria',
          passed: false,
          notes: 'Missing test.',
        },
      ],
      summary: 'One dimension failed.',
    };
    const verdictEvent = makeAssistantEvent(JSON.stringify(verdictPayload));

    const result = service.parseReviewResult(
      [toolCallEvent, verdictEvent],
      42,
      'owner/repo',
    );
    expect(result.verdict).toBe('needs_changes');
    expect(result.summary).toBe('One dimension failed.');
  });

  it('succeeds when JSON is split across multiple text blocks in last assistant message', () => {
    const service = makeService();

    const fullPayload = {
      verdict: 'approved',
      dimensions: [
        {
          name: 'Title and description vs task Summary',
          passed: true,
          notes: 'Matches.',
        },
      ],
      summary: 'Looks great.',
    };
    // Split JSON across two text blocks within the same assistant message
    const jsonStr = JSON.stringify(fullPayload);
    const half = Math.floor(jsonStr.length / 2);
    const part1 = jsonStr.slice(0, half);
    const part2 = jsonStr.slice(half);

    const splitEvent: SessionEvent = {
      id: 1,
      session_id: 'review-session-id',
      event_type: 'text',
      payload: JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: part1 },
            { type: 'text', text: part2 },
          ],
        },
      }),
      timestamp: Date.now(),
    };

    const result = service.parseReviewResult([splitEvent], 42, 'owner/repo');
    expect(result.verdict).toBe('approved');
  });
});

// ── buildPrompt() ─────────────────────────────────────────────────────────────

describe('PRReviewService.buildPrompt()', () => {
  it('includes PR diff, task spec body, and the JSON schema instruction', () => {
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    const prompt = service.buildPrompt(mockPR, mockDiff, mockTaskBody);

    expect(prompt).toContain(mockPR.title);
    expect(prompt).toContain(mockDiff.diff);
    expect(prompt).toContain('Implement the something cool feature for users');
    expect(prompt).toContain('add bar export to foo.ts');
    expect(prompt).toContain('bar export is added');
    expect(prompt).toContain('src/foo.ts (update)');
    expect(prompt).toContain('"verdict"');
    expect(prompt).toContain('"dimensions"');
    expect(prompt).toContain('Title and description vs task Summary');
    expect(prompt).toContain('Diff vs Context spec');
    expect(prompt).toContain('Diff vs Acceptance Criteria');
    expect(prompt).toContain('Changed files vs Files/paths affected list');
  });

  it('instructs reviewer to pass downstream file changes for the Changed files dimension', () => {
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    const prompt = service.buildPrompt(mockPR, mockDiff, mockTaskBody);

    expect(prompt).toContain(
      'necessary downstream updates caused by the listed changes',
    );
    expect(prompt).toContain(
      'Fail only if the PR touches files unrelated to the task',
    );
  });

  it('includes the full diff without truncation', () => {
    const longDiff: PRDiff = { ...mockDiff, diff: 'A'.repeat(13000) };
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    const prompt = service.buildPrompt(mockPR, longDiff, mockTaskBody);

    expect(prompt).toContain('A'.repeat(13000));
    expect(prompt).not.toContain('[diff truncated');
  });

  it('Ops rubric: resolves the "changed files" dimension against the approved PR-intent, not the task-body Files section', () => {
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    const prIntent = {
      taskId: 'task-1',
      title: 'add retry to the poller',
      scope: 'src/ops/poller.ts and its test — add exponential backoff retry',
      reason: 'poller drops events under transient network errors',
    };

    const prompt = service.buildPrompt(
      mockPR,
      mockDiff,
      mockTaskBody,
      prIntent,
    );

    // The Ops-approved declaration is rendered in the prompt...
    expect(prompt).toContain('## Approved PR Intent');
    expect(prompt).toContain(prIntent.scope);
    expect(prompt).toContain(prIntent.reason);
    // ...and the "changed files" dimension's guidance points at it instead
    // of the task-body Files/paths section.
    expect(prompt).toContain(
      "compare the changed files against that declaration's scope",
    );
    expect(prompt).not.toContain(
      'necessary downstream updates caused by the listed changes',
    );
  });

  it('without a prIntent, keeps the default Files/paths rubric unchanged', () => {
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    const prompt = service.buildPrompt(mockPR, mockDiff, mockTaskBody);

    expect(prompt).not.toContain('## Approved PR Intent');
    expect(prompt).toContain(
      'necessary downstream updates caused by the listed changes',
    );
  });
});

// ── parseReviewResult() ───────────────────────────────────────────────────────

describe('PRReviewService.parseReviewResult()', () => {
  it('extracts verdict and dimensions from assistant event text', () => {
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    const payload = {
      verdict: 'approved',
      dimensions: [
        {
          name: 'Title and description vs task Summary',
          passed: true,
          notes: 'Good.',
        },
        { name: 'Diff vs Context spec', passed: true, notes: 'Good.' },
        { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'Good.' },
        {
          name: 'Changed files vs Files/paths affected list',
          passed: true,
          notes: 'Good.',
        },
      ],
      summary: 'All four dimensions passed.',
    };

    const events = [makeAssistantEvent(JSON.stringify(payload))];
    const result = service.parseReviewResult(events, 42, 'owner/repo');

    expect(result.verdict).toBe('approved');
    expect(result.dimensions).toHaveLength(4);
    expect(result.summary).toBe('All four dimensions passed.');
  });

  it('returns incomplete verdict when event text is not valid JSON', () => {
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    const events = [makeAssistantEvent('this is not JSON at all')];
    const result = service.parseReviewResult(events, 42, 'owner/repo');

    expect(result.verdict).toBe('incomplete');
    expect(result.summary).toContain('Failed to parse');
  });
});

// ── reviewPR() — verdict parsed from event stream ────────────────────────────

describe('PRReviewService.reviewPR() — event-driven verdict parsing', () => {
  it('resolves when verdict JSON block arrives in session_event (not session_ended)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const claudePayload = {
      verdict: 'approved',
      dimensions: [
        {
          name: 'Title and description vs task Summary',
          passed: true,
          notes: 'Matches.',
        },
        { name: 'Diff vs Context spec', passed: true, notes: 'Matches.' },
        {
          name: 'Diff vs Acceptance Criteria',
          passed: true,
          notes: 'Matches.',
        },
        {
          name: 'Changed files vs Files/paths affected list',
          passed: true,
          notes: 'Matches.',
        },
      ],
      summary: 'All four dimensions passed.',
    };

    const mockSM = makeMockSessionManager();
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    const startMock = mockSM.start as ReturnType<typeof vi.fn>;
    startMock.mockImplementationOnce(
      (_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
        const id = opts.sessionId;
        // Emit verdict via session_event — session stays alive (no session_ended)
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(id, JSON.stringify(claudePayload)),
          ),
        );
        return id;
      },
    );

    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    expect(startMock).toHaveBeenCalledOnce();
    const [, , opts] = startMock.mock.calls[0];
    expect(opts.sessionType).toBe('review');
    expect(typeof opts.customPrompt).toBe('string');
    expect(typeof opts.sessionId).toBe('string');

    expect(result.verdict).toBe('approved');
    expect(vi.mocked(setPRReviewResult)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      expect.stringContaining('"approved"'),
    );
    expect(vi.mocked(setReviewSessionId)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      opts.sessionId,
    );
  });

  it('falls back to stored events when session_ended fires before verdict', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const claudePayload = {
      verdict: 'needs_changes',
      dimensions: [
        {
          name: 'Diff vs Context spec',
          passed: false,
          notes: 'Missing export.',
        },
      ],
      summary: 'One dimension failed.',
    };
    vi.mocked(getEventsBySession).mockReturnValue([
      makeAssistantEvent(JSON.stringify(claudePayload)),
    ]);

    const mockSM = makeMockSessionManager();
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    const startMock = mockSM.start as ReturnType<typeof vi.fn>;
    startMock.mockImplementationOnce(
      (_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
        const id = opts.sessionId;
        setImmediate(() =>
          mockSM.emit('message', {
            type: 'session_ended',
            sessionId: id,
            status: 'done',
          }),
        );
        return id;
      },
    );

    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    expect(result.verdict).toBe('needs_changes');
    const [, , opts] = startMock.mock.calls[0];
    expect(vi.mocked(getEventsBySession)).toHaveBeenCalledWith(opts.sessionId);
  });

  it('verdict listener is active before session start() returns (race condition fix)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const claudePayload = {
      verdict: 'approved',
      dimensions: [{ name: 'Diff vs Context spec', passed: true, notes: 'ok' }],
      summary: 'Fast review approved.',
    };

    const mockSM = makeMockSessionManager();
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    let listenerCountAtStart = 0;
    const startMock = mockSM.start as ReturnType<typeof vi.fn>;
    startMock.mockImplementationOnce(
      (_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
        // Check how many 'message' listeners are attached at the moment start() is called.
        // With the fix, waitForVerdict() has already subscribed, so count must be >= 1.
        listenerCountAtStart = mockSM.listenerCount('message');
        // Emit verdict synchronously inside start() — will only be captured if listener
        // was already attached before start() was called.
        mockSM.emit(
          'message',
          makeSessionEventMessage(
            opts.sessionId,
            JSON.stringify(claudePayload),
          ),
        );
        return opts.sessionId;
      },
    );

    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    expect(listenerCountAtStart).toBeGreaterThanOrEqual(1);
    expect(result.verdict).toBe('approved');
  });

  it('fast review: verdict emitted synchronously during start() is captured, not missed', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const claudePayload = {
      verdict: 'approved',
      dimensions: [
        { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'ok' },
      ],
      summary: 'Approved immediately.',
    };

    const mockSM = makeMockSessionManager();
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    const startMock = mockSM.start as ReturnType<typeof vi.fn>;
    startMock.mockImplementationOnce(
      (_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
        const id = opts.sessionId;
        // Emit SYNCHRONOUSLY inside start() — simulates the CLI completing the
        // review before start() even returns (the original race condition).
        mockSM.emit(
          'message',
          makeSessionEventMessage(id, JSON.stringify(claudePayload)),
        );
        return id;
      },
    );

    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    expect(result.verdict).toBe('approved');
    expect(result.summary).toBe('Approved immediately.');
    expect(vi.mocked(setPRReviewResult)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      expect.stringContaining('"approved"'),
    );
  });

  it('throws when PR is not found in database', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(null);

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    await expect(
      service.reviewPR(
        { type: 'pr', prNumber: 99, repo: 'owner/repo' },
        makeMockDiffSource(),
      ),
    ).rejects.toThrow('not found in database');
  });
});

// ── Verdict ignores mergeability state ───────────────────────────────────────

describe('PRReviewService — verdict ignores mergeability state', () => {
  const allPassedAIPayload = {
    verdict: 'approved',
    dimensions: [
      {
        name: 'Title and description vs task Summary',
        passed: true,
        notes: 'ok',
      },
      { name: 'Diff vs Context spec', passed: true, notes: 'ok' },
      { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'ok' },
      {
        name: 'Changed files vs Files/paths affected list',
        passed: true,
        notes: 'ok',
      },
      { name: 'Size proportionality', passed: true, notes: 'In budget.' },
    ],
    summary: 'All five AI dimensions passed.',
  };

  it('all Claude dimensions passing → approved even when PR has merge conflicts (mergeable=false)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const mockSM = makeMockSessionManager();
    const mockGH = makeMockGitHub();

    const service = new PRReviewService(
      mockGH,
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
        const id = opts.sessionId;
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(id, JSON.stringify(allPassedAIPayload)),
          ),
        );
        return id;
      },
    );

    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    expect(result.verdict).toBe('approved');
    expect(result.dimensions).toHaveLength(5);
    const conflictDim = result.dimensions!.find(
      (d) => d.name === 'Merge conflicts',
    );
    expect(conflictDim).toBeUndefined();
    expect(vi.mocked(mockGH.getMergeabilityWithRetry)).not.toHaveBeenCalled();
  });

  it('any substantive dimension failing → needs_changes regardless of mergeability', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const oneFailedPayload = {
      verdict: 'needs_changes',
      dimensions: [
        {
          name: 'Title and description vs task Summary',
          passed: true,
          notes: 'ok',
        },
        {
          name: 'Diff vs Context spec',
          passed: false,
          notes: 'Missing export.',
        },
        { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'ok' },
        {
          name: 'Changed files vs Files/paths affected list',
          passed: true,
          notes: 'ok',
        },
        { name: 'Size proportionality', passed: true, notes: 'In budget.' },
      ],
      summary: 'One dimension failed.',
    };

    const mockSM = makeMockSessionManager();
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
        const id = opts.sessionId;
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(id, JSON.stringify(oneFailedPayload)),
          ),
        );
        return id;
      },
    );

    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    expect(result.verdict).toBe('needs_changes');
    const conflictDim = result.dimensions!.find(
      (d) => d.name === 'Merge conflicts',
    );
    expect(conflictDim).toBeUndefined();
  });

  it('zero passing dimensions (session killed) → incomplete', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);
    vi.mocked(getEventsBySession).mockReturnValue([]);

    const mockSM = makeMockSessionManager();
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
        const id = opts.sessionId;
        setImmediate(() =>
          mockSM.emit('message', {
            type: 'session_ended',
            sessionId: id,
            status: 'killed',
          }),
        );
        return id;
      },
    );

    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    expect(result.verdict).toBe('incomplete');
    const conflictDim = result.dimensions?.find(
      (d) => d.name === 'Merge conflicts',
    );
    expect(conflictDim).toBeUndefined();
  });
});

// ── handleApprovedVerdict() ───────────────────────────────────────────────────

describe('PRReviewService.handleApprovedVerdict()', () => {
  it('calls markPRReady and updatePRDraftStatus when PR is a draft', async () => {
    const draftPRRow = { ...mockPRRow, draft: 1 };
    vi.mocked(getPRByNumber).mockReturnValue(draftPRRow as any);

    const mockGH = makeMockGitHub();
    const service = new PRReviewService(
      mockGH,
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    const result = await service.handleApprovedVerdict(
      42,
      'owner/repo',
      'task-abc123',
    );

    expect(vi.mocked(mockGH.markPRReady)).toHaveBeenCalledWith(
      'owner/repo',
      42,
    );
    expect(vi.mocked(updatePRDraftStatus)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      0,
    );
    expect(result).toBe(true);
  });

  it('calls markPRReady even when PR is not a draft (draft=0) — eliminates stale-field race', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any); // draft: 0

    const mockGH = makeMockGitHub();
    const service = new PRReviewService(
      mockGH,
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    const result = await service.handleApprovedVerdict(
      42,
      'owner/repo',
      'task-abc123',
    );

    expect(vi.mocked(mockGH.markPRReady)).toHaveBeenCalledWith(
      'owner/repo',
      42,
    );
    expect(vi.mocked(updatePRDraftStatus)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      0,
    );
    expect(result).toBe(true);
  });

  it('handles markPRReady failure gracefully — does not throw, returns false', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const mockGH = makeMockGitHub();
    vi.mocked(mockGH.markPRReady).mockRejectedValue(
      new Error('PR is not a draft'),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new PRReviewService(
      mockGH,
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    const result = await service.handleApprovedVerdict(
      42,
      'owner/repo',
      'task-abc123',
    );

    expect(vi.mocked(mockGH.markPRReady)).toHaveBeenCalledWith(
      'owner/repo',
      42,
    );
    expect(vi.mocked(updatePRDraftStatus)).not.toHaveBeenCalled();
    expect(result).toBe(false);
    warnSpy.mockRestore();
  });

  it('updates Notion status to In Review when taskId is provided', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const mockNotion = makeMockNotion();
    const service = new PRReviewService(
      makeMockGitHub(),
      mockNotion,
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    await service.handleApprovedVerdict(42, 'owner/repo', 'task-abc123');

    expect(vi.mocked(mockNotion.updateStatus)).toHaveBeenCalledWith(
      'task-abc123',
      '👀 In Review',
    );
  });

  it('does NOT call Notion updateStatus when taskId is null', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const mockNotion = makeMockNotion();
    const service = new PRReviewService(
      makeMockGitHub(),
      mockNotion,
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    await service.handleApprovedVerdict(42, 'owner/repo', null);

    expect(vi.mocked(mockNotion.updateStatus)).not.toHaveBeenCalled();
  });

  it('does NOT set manual_verification_pending when the cached task Type is 💻 Code', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);
    vi.mocked(getCachedType).mockReturnValue('💻 Code');

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    await service.handleApprovedVerdict(42, 'owner/repo', 'task-abc123');

    expect(vi.mocked(setPauseReason)).not.toHaveBeenCalled();
  });

  it('sets manual_verification_pending when the cached task Type is not 💻 Code', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);
    vi.mocked(getCachedType).mockReturnValue('🔧 Operational');

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    await service.handleApprovedVerdict(
      42,
      'owner/repo',
      'task-abc123',
      'proj-1',
      ['Manually verify the migration ran cleanly.'],
    );

    expect(vi.mocked(setPauseReason)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'manual_verification_pending',
      JSON.stringify(['Manually verify the migration ran cleanly.']),
    );
  });

  it('fails closed (sets manual_verification_pending) when getCachedType misses (returns null)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);
    vi.mocked(getCachedType).mockReturnValue(null);

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    await service.handleApprovedVerdict(42, 'owner/repo', 'task-abc123');

    expect(vi.mocked(setPauseReason)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'manual_verification_pending',
      undefined,
    );
  });

  it('sets depth_review_pending before autoMerger.attempt() when a depth review service is configured', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);
    vi.mocked(getCachedType).mockReturnValue('💻 Code');

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    service.setDepthReviewService({} as any);

    const callOrder: string[] = [];
    vi.mocked(setPauseReason).mockImplementation(() => {
      callOrder.push('setPauseReason');
    });
    const autoMergerAttempt = vi.fn(() => {
      callOrder.push('autoMerger.attempt');
    });
    service.setAutoMerger({ attempt: autoMergerAttempt } as any);

    await service.handleApprovedVerdict(42, 'owner/repo', 'task-abc123');

    expect(vi.mocked(setPauseReason)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'depth_review_pending',
    );
    expect(callOrder).toEqual(['setPauseReason', 'autoMerger.attempt']);
  });

  it('does NOT set depth_review_pending when no depth review service is configured', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);
    vi.mocked(getCachedType).mockReturnValue('💻 Code');

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    await service.handleApprovedVerdict(42, 'owner/repo', 'task-abc123');

    expect(vi.mocked(setPauseReason)).not.toHaveBeenCalled();
  });
});

// ── reviewPR() — approved verdict triggers handleApprovedVerdict ──────────────

describe('PRReviewService.reviewPR() — approved verdict calls handleApprovedVerdict', () => {
  const claudeApprovedPayload = {
    verdict: 'approved',
    dimensions: [
      {
        name: 'Title and description vs task Summary',
        passed: true,
        notes: 'ok',
      },
      { name: 'Diff vs Context spec', passed: true, notes: 'ok' },
      { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'ok' },
      {
        name: 'Changed files vs Files/paths affected list',
        passed: true,
        notes: 'ok',
      },
    ],
    summary: 'All dimensions passed.',
  };

  it('calls markPRReady when approved verdict and PR is a draft', async () => {
    const draftPRRow = { ...mockPRRow, draft: 1 };
    vi.mocked(getPRByNumber).mockReturnValue(draftPRRow as any);

    const mockGH = makeMockGitHub();
    const mockSM = makeMockSessionManager();
    const service = new PRReviewService(
      mockGH,
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(
              opts.sessionId,
              JSON.stringify(claudeApprovedPayload),
            ),
          ),
        );
        return opts.sessionId;
      },
    );

    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    expect(result.verdict).toBe('approved');
    expect(vi.mocked(mockGH.markPRReady)).toHaveBeenCalledWith(
      'owner/repo',
      42,
    );
    expect(vi.mocked(updatePRDraftStatus)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      0,
    );
  });

  it('does NOT call markPRReady when verdict is needs_changes', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({ ...mockPRRow, draft: 1 } as any);

    const needsChangesPayload = {
      verdict: 'needs_changes',
      dimensions: [
        {
          name: 'Diff vs Context spec',
          passed: false,
          notes: 'Missing export.',
        },
      ],
      summary: 'One dimension failed.',
    };

    const mockGH = makeMockGitHub();
    vi.mocked(mockGH.getMergeability).mockResolvedValue({
      mergeable: true,
      mergeableState: 'clean',
    });
    vi.mocked(mockGH.getMergeabilityWithRetry).mockResolvedValue({
      mergeable: true,
      mergeableState: 'clean',
    });
    const mockSM = makeMockSessionManager();
    const service = new PRReviewService(
      mockGH,
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(
              opts.sessionId,
              JSON.stringify(needsChangesPayload),
            ),
          ),
        );
        return opts.sessionId;
      },
    );

    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    expect(result.verdict).toBe('needs_changes');
    expect(vi.mocked(mockGH.markPRReady)).not.toHaveBeenCalled();
    expect(vi.mocked(updatePRDraftStatus)).not.toHaveBeenCalled();
  });

  it('updates Notion to In Review when approved verdict and PR has task_id', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any); // task_id: 'notion:task-abc123'

    const mockGH = makeMockGitHub();
    const mockNotion = makeMockNotion();
    const mockSM = makeMockSessionManager();
    const service = new PRReviewService(
      mockGH,
      mockNotion,
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(
              opts.sessionId,
              JSON.stringify(claudeApprovedPayload),
            ),
          ),
        );
        return opts.sessionId;
      },
    );

    await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    expect(vi.mocked(mockNotion.updateStatus)).toHaveBeenCalledWith(
      'notion:task-abc123',
      '👀 In Review',
    );
  });

  it('passes projectId to handleApprovedVerdict in the fresh-review path (Case 3)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any); // review_session_id: null → fresh review

    const mockGH = makeMockGitHub();
    const mockNotion = makeMockNotion();
    const mockSM = makeMockSessionManager();
    const service = new PRReviewService(
      mockGH,
      mockNotion,
      mockSM as any,
      'default-proj',
      'https://notion.so/ctx',
    );

    const handleSpy = vi.spyOn(service, 'handleApprovedVerdict');

    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(
              opts.sessionId,
              JSON.stringify(claudeApprovedPayload),
            ),
          ),
        );
        return opts.sessionId;
      },
    );

    await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
      'specific-project-id',
    );

    expect(handleSpy).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'notion:task-abc123',
      'specific-project-id',
      undefined,
    );
    expect(vi.mocked(mockNotion.updateStatus)).toHaveBeenCalledWith(
      'notion:task-abc123',
      '👀 In Review',
    );
  });
});

// ── reviewPR() — session reuse logic ─────────────────────────────────────────

describe('PRReviewService.reviewPR() — session reuse', () => {
  const claudePayload = {
    verdict: 'approved',
    dimensions: [{ name: 'Diff vs Context spec', passed: true, notes: 'ok' }],
    summary: 'All good.',
  };

  it('reuses an existing live review session: sends follow-up, does not spawn', async () => {
    const prRowWithLiveSession = {
      ...mockPRRow,
      review_session_id: 'existing-review-session-id',
    };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithLiveSession as any);

    const mockSM = makeMockSessionManager();
    (mockSM.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const sendMock = mockSM.send as ReturnType<typeof vi.fn>;
    sendMock.mockImplementationOnce(() => {
      setImmediate(() =>
        mockSM.emit(
          'message',
          makeSessionEventMessage(
            'existing-review-session-id',
            JSON.stringify(claudePayload),
          ),
        ),
      );
    });

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    expect(mockSM.start).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledWith(
      'existing-review-session-id',
      expect.any(String),
    );
    expect(vi.mocked(setReviewSessionId)).not.toHaveBeenCalled();
    expect(result.verdict).toBe('approved');
  });

  it('surfaces an unconfirmed follow-up delivery to a live review session instead of dropping it silently', async () => {
    const prRowWithLiveSession = {
      ...mockPRRow,
      review_session_id: 'existing-review-session-id',
    };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithLiveSession as any);

    const mockSM = makeMockSessionManager();
    (mockSM.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const sendMock = mockSM.send as ReturnType<typeof vi.fn>;
    sendMock.mockImplementationOnce(() => {
      setImmediate(() =>
        mockSM.emit(
          'message',
          makeSessionEventMessage(
            'existing-review-session-id',
            JSON.stringify(claudePayload),
          ),
        ),
      );
      return false;
    });

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'session_nudge_delivery_failed',
        actor_id: 'existing-review-session-id',
      }),
    );
  });

  it('resumes a dead-but-resumable review session via sendOrResume (Case 2)', async () => {
    const prRowWithDeadSession = {
      ...mockPRRow,
      review_session_id: 'dead-review-session-id',
    };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithDeadSession as any);
    // Session row exists and is idle (not terminal) — qualifies for Case 2
    vi.mocked(getSession).mockReturnValueOnce({ status: 'idle' } as any);

    const mockSM = makeMockSessionManager();
    (mockSM.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const resumedId = 'new-resumed-session-id';
    (mockSM.sendOrResume as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(resumedId, JSON.stringify(claudePayload)),
          ),
        );
        return resumedId;
      },
    );

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    expect(mockSM.start).not.toHaveBeenCalled();
    expect(mockSM.sendOrResume).toHaveBeenCalledWith(
      'dead-review-session-id',
      expect.any(String),
    );
    expect(vi.mocked(setReviewSessionId)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      resumedId,
    );
    expect(result.verdict).toBe('approved');
  });

  it('spawns fresh session when review_session_id has no DB row (pruned) and clears the stale pointer', async () => {
    const prRowWithPrunedSession = {
      ...mockPRRow,
      review_session_id: 'pruned-session-id',
    };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithPrunedSession as any);
    // Default mock returns null — simulates pruned/missing session row
    vi.mocked(getSession).mockReturnValue(null);

    const mockSM = makeMockSessionManager();
    (mockSM.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const startMock = mockSM.start as ReturnType<typeof vi.fn>;
    startMock.mockImplementationOnce(
      (_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
        const id = opts.sessionId;
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(id, JSON.stringify(claudePayload)),
          ),
        );
        return id;
      },
    );

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    // stale pointer cleared
    expect(vi.mocked(clearReviewSessionId)).toHaveBeenCalledWith(
      42,
      'owner/repo',
    );
    // fresh session spawned (Case 3), not sendOrResume
    expect(startMock).toHaveBeenCalledOnce();
    expect(mockSM.sendOrResume).not.toHaveBeenCalled();
    expect(result.verdict).toBe('approved');
  });

  it('spawns fresh session when review_session_id is terminal (done/error/killed) and clears the stale pointer', async () => {
    const prRowWithTerminalSession = {
      ...mockPRRow,
      review_session_id: 'terminal-session-id',
    };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithTerminalSession as any);
    vi.mocked(getSession).mockReturnValueOnce({ status: 'done' } as any);

    const mockSM = makeMockSessionManager();
    (mockSM.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const startMock = mockSM.start as ReturnType<typeof vi.fn>;
    startMock.mockImplementationOnce(
      (_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
        const id = opts.sessionId;
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(id, JSON.stringify(claudePayload)),
          ),
        );
        return id;
      },
    );

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    // stale terminal pointer cleared
    expect(vi.mocked(clearReviewSessionId)).toHaveBeenCalledWith(
      42,
      'owner/repo',
    );
    // fresh session spawned, sendOrResume never called on dead ID
    expect(startMock).toHaveBeenCalledOnce();
    expect(mockSM.sendOrResume).not.toHaveBeenCalled();
    // waitForVerdict never called on the terminal ID — it completes via fresh session
    expect(result.verdict).toBe('approved');
  });

  it('spawns a new session only when no prior review_session_id exists on the PR', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any); // review_session_id: null

    const mockSM = makeMockSessionManager();
    const startMock = mockSM.start as ReturnType<typeof vi.fn>;
    startMock.mockImplementationOnce(
      (_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
        const id = opts.sessionId;
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(id, JSON.stringify(claudePayload)),
          ),
        );
        return id;
      },
    );

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    expect(startMock).toHaveBeenCalledOnce();
    expect(mockSM.send).not.toHaveBeenCalled();
    expect(mockSM.sendOrResume).not.toHaveBeenCalled();
    const [, , opts] = startMock.mock.calls[0];
    expect(vi.mocked(setReviewSessionId)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      opts.sessionId,
    );
    expect(result.verdict).toBe('approved');
  });

  it('live-session follow-up inlines the full JSON schema (not a reference to "same format")', async () => {
    const prRowWithLiveSession = {
      ...mockPRRow,
      review_session_id: 'existing-review-session-id',
    };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithLiveSession as any);

    const mockSM = makeMockSessionManager();
    (mockSM.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);

    (mockSM.send as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      setImmediate(() =>
        mockSM.emit(
          'message',
          makeSessionEventMessage(
            'existing-review-session-id',
            JSON.stringify(claudePayload),
          ),
        ),
      );
    });

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    const [, followUp] = (mockSM.send as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(followUp).not.toContain('same JSON review format as before');
    expect(followUp).toContain('"verdict"');
    expect(followUp).toContain('"dimensions"');
    expect(followUp).toContain('Title and description vs task Summary');
    expect(followUp).toContain('Diff vs Context spec');
    expect(followUp).toContain('Diff vs Acceptance Criteria');
    expect(followUp).toContain('Changed files vs Files/paths affected list');
    expect(followUp).toContain('verdict rules:');
    expect(followUp).toContain(
      'necessary downstream updates caused by the listed changes',
    );
  });

  it('does not overwrite review_session_id when reusing an existing live session', async () => {
    const prRowWithLiveSession = {
      ...mockPRRow,
      review_session_id: 'existing-review-session-id',
    };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithLiveSession as any);

    const mockSM = makeMockSessionManager();
    (mockSM.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);

    (mockSM.send as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      setImmediate(() =>
        mockSM.emit(
          'message',
          makeSessionEventMessage(
            'existing-review-session-id',
            JSON.stringify(claudePayload),
          ),
        ),
      );
    });

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    expect(vi.mocked(setReviewSessionId)).not.toHaveBeenCalled();
  });
});

// ── reReviewPR() ──────────────────────────────────────────────────────────────

describe('PRReviewService.reReviewPR()', () => {
  const claudePayload = {
    verdict: 'approved',
    dimensions: [
      { name: 'Diff vs Context spec', passed: true, notes: 'Fixed.' },
    ],
    summary: 'Issues addressed.',
  };

  it('calls sendOrResume with the existing review_session_id', async () => {
    const prRowWithSession = {
      ...mockPRRow,
      review_session_id: 'existing-review-session-abc',
    };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithSession as any);

    const mockSM = makeMockSessionManager();
    (mockSM.sendOrResume as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (sessionId: string) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(sessionId, JSON.stringify(claudePayload)),
          ),
        );
        return sessionId;
      },
    );

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    const result = await service.reReviewPR(42, 'owner/repo');

    expect(mockSM.sendOrResume).toHaveBeenCalledOnce();
    const [calledSessionId] = (mockSM.sendOrResume as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(calledSessionId).toBe('existing-review-session-abc');
    expect(result.verdict).toBe('approved');
  });

  it('falls back to reviewPR() when PR has no review_session_id', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any); // review_session_id: null

    const mockSM = makeMockSessionManager();
    const startMock = mockSM.start as ReturnType<typeof vi.fn>;
    startMock.mockImplementationOnce(
      (_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
        const id = opts.sessionId;
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(id, JSON.stringify(claudePayload)),
          ),
        );
        return id;
      },
    );

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    const result = await service.reReviewPR(42, 'owner/repo');

    expect(startMock).toHaveBeenCalledOnce();
    expect(mockSM.sendOrResume).not.toHaveBeenCalled();
    expect(result.verdict).toBe('approved');
  });

  it('increments review_iteration in DB before calling sendOrResume', async () => {
    const prRowWithSession = {
      ...mockPRRow,
      review_session_id: 'review-session-xyz',
      review_iteration: 1,
    };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithSession as any);

    const mockSM = makeMockSessionManager();
    (mockSM.sendOrResume as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (sessionId: string) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(sessionId, JSON.stringify(claudePayload)),
          ),
        );
        return sessionId;
      },
    );

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    await service.reReviewPR(42, 'owner/repo');

    expect(vi.mocked(incrementReviewIteration)).toHaveBeenCalledWith(
      42,
      'owner/repo',
    );
  });

  it('updates review_session_id when sendOrResume returns a new session ID', async () => {
    const prRowWithSession = {
      ...mockPRRow,
      review_session_id: 'old-review-session',
    };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithSession as any);

    const mockSM = makeMockSessionManager();
    (mockSM.sendOrResume as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(
              'new-review-session',
              JSON.stringify(claudePayload),
            ),
          ),
        );
        return 'new-review-session';
      },
    );

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    await service.reReviewPR(42, 'owner/repo');

    expect(vi.mocked(setReviewSessionId)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'new-review-session',
    );
  });

  it('calls handleApprovedVerdict with (prNumber, repo, task_id, projectId) when verdict is approved', async () => {
    const prRowWithSession = {
      ...mockPRRow,
      review_session_id: 'review-session-approved',
      task_id: 'notion:task-abc123',
    };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithSession as any);

    const mockGH = makeMockGitHub();
    const mockSM = makeMockSessionManager();
    (mockSM.sendOrResume as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (sessionId: string) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(sessionId, JSON.stringify(claudePayload)),
          ),
        );
        return sessionId;
      },
    );

    const service = new PRReviewService(
      mockGH,
      makeMockNotion(),
      mockSM as any,
      'proj-re-review',
      'https://notion.so/ctx',
    );
    const handleSpy = vi.spyOn(service, 'handleApprovedVerdict');

    const result = await service.reReviewPR(42, 'owner/repo', 'proj-re-review');

    expect(result.verdict).toBe('approved');
    expect(handleSpy).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'notion:task-abc123',
      'proj-re-review',
      undefined,
    );
  });

  it('re-arms manual_verification_pending on a re-review that approves again, even if a prior round was cleared', async () => {
    const prRowWithSession = {
      ...mockPRRow,
      review_session_id: 'review-session-rearm',
    };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithSession as any);
    vi.mocked(getCachedType).mockReturnValue('🔧 Operational');

    const mockSM = makeMockSessionManager();
    (mockSM.sendOrResume as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (sessionId: string) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(sessionId, JSON.stringify(claudePayload)),
          ),
        );
        return sessionId;
      },
    );

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    const result = await service.reReviewPR(42, 'owner/repo');

    expect(result.verdict).toBe('approved');
    expect(vi.mocked(setPauseReason)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'manual_verification_pending',
      undefined,
    );
  });

  it('does NOT call handleApprovedVerdict when verdict is needs_changes', async () => {
    const prRowWithSession = {
      ...mockPRRow,
      review_session_id: 'review-session-needs-changes',
    };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithSession as any);

    const needsChangesPayload = {
      verdict: 'needs_changes',
      dimensions: [
        { name: 'Diff vs Context spec', passed: false, notes: 'Still broken.' },
      ],
      summary: 'Not ready yet.',
    };

    const mockGH = makeMockGitHub();
    vi.mocked(mockGH.getMergeabilityWithRetry).mockResolvedValue({
      mergeable: true,
      mergeableState: 'clean',
    });
    const mockSM = makeMockSessionManager();
    (mockSM.sendOrResume as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (sessionId: string) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(
              sessionId,
              JSON.stringify(needsChangesPayload),
            ),
          ),
        );
        return sessionId;
      },
    );

    const service = new PRReviewService(
      mockGH,
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    const handleSpy = vi.spyOn(service, 'handleApprovedVerdict');

    const result = await service.reReviewPR(42, 'owner/repo');

    expect(result.verdict).toBe('needs_changes');
    expect(handleSpy).not.toHaveBeenCalled();
  });

  it('follow-up inlines the full JSON schema (not a reference to "same format")', async () => {
    const prRowWithSession = {
      ...mockPRRow,
      review_session_id: 'review-session-abc',
    };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithSession as any);

    const mockSM = makeMockSessionManager();
    (mockSM.sendOrResume as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (sessionId: string) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(sessionId, JSON.stringify(claudePayload)),
          ),
        );
        return sessionId;
      },
    );

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    await service.reReviewPR(42, 'owner/repo');

    const [, followUp] = (mockSM.sendOrResume as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(followUp).not.toContain('same JSON review format as before');
    expect(followUp).toContain('"verdict"');
    expect(followUp).toContain('"dimensions"');
    expect(followUp).toContain('Title and description vs task Summary');
    expect(followUp).toContain('Diff vs Context spec');
    expect(followUp).toContain('Diff vs Acceptance Criteria');
    expect(followUp).toContain('Changed files vs Files/paths affected list');
    expect(followUp).toContain('verdict rules:');
    expect(followUp).toContain(
      'necessary downstream updates caused by the listed changes',
    );
  });
});

// ── Verdict persisted before GitHub side effects (all four review paths) ───────

describe('PRReviewService — verdict persisted before side effects', () => {
  const approvedPayload = {
    verdict: 'approved',
    dimensions: [{ name: 'Diff vs Context spec', passed: true, notes: 'ok' }],
    summary: 'All good.',
  };

  function makeSessionThatEmits(
    mockSM: ReturnType<typeof makeMockSessionManager>,
    payload: object,
    useStart = true,
  ) {
    if (useStart) {
      (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (_u: string, _c: string, opts: { sessionId: string }) => {
          setImmediate(() =>
            mockSM.emit(
              'message',
              makeSessionEventMessage(opts.sessionId, JSON.stringify(payload)),
            ),
          );
          return opts.sessionId;
        },
      );
    }
  }

  it('Case 3 (fresh): setPRReviewResult called before markPRReady', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({
      ...mockPRRow,
      review_session_id: null,
      draft: 1,
    } as any);

    const callOrder: string[] = [];
    const mockGH = makeMockGitHub();
    vi.mocked(mockGH.markPRReady).mockImplementation(async () => {
      callOrder.push('markPRReady');
    });
    vi.mocked(setPRReviewResult).mockImplementation(() => {
      callOrder.push('setPRReviewResult');
    });

    const mockSM = makeMockSessionManager();
    makeSessionThatEmits(mockSM, approvedPayload);

    const service = new PRReviewService(
      mockGH,
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    expect(callOrder.indexOf('setPRReviewResult')).toBeLessThan(
      callOrder.indexOf('markPRReady'),
    );
  });

  it('Case 1 (live): setPRReviewResult called before markPRReady', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({
      ...mockPRRow,
      review_session_id: 'existing-review-session-id',
      draft: 1,
    } as any);

    const callOrder: string[] = [];
    const mockGH = makeMockGitHub();
    vi.mocked(mockGH.markPRReady).mockImplementation(async () => {
      callOrder.push('markPRReady');
    });
    vi.mocked(setPRReviewResult).mockImplementation(() => {
      callOrder.push('setPRReviewResult');
    });

    const mockSM = makeMockSessionManager();
    (mockSM.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (mockSM.send as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      setImmediate(() =>
        mockSM.emit(
          'message',
          makeSessionEventMessage(
            'existing-review-session-id',
            JSON.stringify(approvedPayload),
          ),
        ),
      );
    });

    const service = new PRReviewService(
      mockGH,
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    expect(callOrder.indexOf('setPRReviewResult')).toBeLessThan(
      callOrder.indexOf('markPRReady'),
    );
  });

  it('Case 2 (resume): setPRReviewResult called before markPRReady', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({
      ...mockPRRow,
      review_session_id: 'dead-session-id',
      draft: 1,
    } as any);
    // Session row exists and is idle — qualifies for Case 2
    vi.mocked(getSession).mockReturnValueOnce({ status: 'idle' } as any);

    const callOrder: string[] = [];
    const mockGH = makeMockGitHub();
    vi.mocked(mockGH.markPRReady).mockImplementation(async () => {
      callOrder.push('markPRReady');
    });
    vi.mocked(setPRReviewResult).mockImplementation(() => {
      callOrder.push('setPRReviewResult');
    });

    const mockSM = makeMockSessionManager();
    (mockSM.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (mockSM.sendOrResume as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (sessionId: string) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(sessionId, JSON.stringify(approvedPayload)),
          ),
        );
        return sessionId;
      },
    );

    const service = new PRReviewService(
      mockGH,
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    expect(callOrder.indexOf('setPRReviewResult')).toBeLessThan(
      callOrder.indexOf('markPRReady'),
    );
  });

  it('reReviewPR: setPRReviewResult called before markPRReady', async () => {
    const prRowWithSession = {
      ...mockPRRow,
      review_session_id: 'review-session-rereview',
      draft: 1,
    };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithSession as any);

    const callOrder: string[] = [];
    const mockGH = makeMockGitHub();
    vi.mocked(mockGH.markPRReady).mockImplementation(async () => {
      callOrder.push('markPRReady');
    });
    vi.mocked(setPRReviewResult).mockImplementation(() => {
      callOrder.push('setPRReviewResult');
    });

    const mockSM = makeMockSessionManager();
    (mockSM.sendOrResume as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (sessionId: string) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(sessionId, JSON.stringify(approvedPayload)),
          ),
        );
        return sessionId;
      },
    );

    const service = new PRReviewService(
      mockGH,
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    await service.reReviewPR(42, 'owner/repo');

    expect(callOrder.indexOf('setPRReviewResult')).toBeLessThan(
      callOrder.indexOf('markPRReady'),
    );
  });
});

// ── Verdict persisted on GitHub outage — regression for #627 ──────────────────

describe('PRReviewService — verdict survives GitHub side-effect failure (#627)', () => {
  it('verdict + last_reviewed_sha persisted even when markPRReady throws (GitHub outage)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({
      ...mockPRRow,
      review_session_id: null,
      draft: 1,
    } as any);

    const mockGH = makeMockGitHub();
    vi.mocked(mockGH.markPRReady).mockRejectedValue(
      new Error('GitHub outage: 503 Service Unavailable'),
    );

    const mockSM = makeMockSessionManager();
    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_u: string, _c: string, opts: { sessionId: string }) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(
              opts.sessionId,
              JSON.stringify({
                verdict: 'approved',
                dimensions: [
                  { name: 'Diff vs Context spec', passed: true, notes: 'ok' },
                ],
                summary: 'Approved.',
              }),
            ),
          ),
        );
        return opts.sessionId;
      },
    );

    const service = new PRReviewService(
      mockGH,
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    // Verdict must be persisted despite the GitHub failure
    expect(vi.mocked(setPRReviewResult)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      expect.stringContaining('"approved"'),
    );
    // SHA must also be recorded
    expect(vi.mocked(setLastReviewedSha)).toHaveBeenCalled();
    // review_side_effect_failed audit event must be emitted
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'review_side_effect_failed',
        actor_type: 'system',
        payload: expect.objectContaining({
          side_effect: 'markPRReady',
          pr_number: 42,
        }),
      }),
    );
    // reviewPR must still return the verdict (not throw)
    expect(result.verdict).toBe('approved');
  });

  it('pipeline proceeds: autoMerger.attempt called even when markPRReady throws', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({
      ...mockPRRow,
      review_session_id: null,
    } as any);

    const mockGH = makeMockGitHub();
    vi.mocked(mockGH.markPRReady).mockRejectedValue(new Error('GitHub outage'));

    const mockSM = makeMockSessionManager();
    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_u: string, _c: string, opts: { sessionId: string }) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(
              opts.sessionId,
              JSON.stringify({
                verdict: 'approved',
                dimensions: [
                  { name: 'Diff vs Context spec', passed: true, notes: 'ok' },
                ],
                summary: 'Approved.',
              }),
            ),
          ),
        );
        return opts.sessionId;
      },
    );

    const service = new PRReviewService(
      mockGH,
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    const autoMergerAttempt = vi.fn();
    service.setAutoMerger({ attempt: autoMergerAttempt } as any);

    await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    expect(autoMergerAttempt).toHaveBeenCalledWith(42, 'owner/repo');
  });
});

// ── Baseline escalation floor ────────────────────────────────────────────────

describe('PRReviewService — baseline escalation floor', () => {
  const fourPassedDims = [
    {
      name: 'Title and description vs task Summary',
      passed: true,
      notes: 'ok',
    },
    { name: 'Diff vs Context spec', passed: true, notes: 'ok' },
    { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'ok' },
    {
      name: 'Changed files vs Files/paths affected list',
      passed: true,
      notes: 'ok',
    },
  ];

  function makeDiffTouching(path: string): string {
    return [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -1,1 +1,2 @@',
      ' keep me',
      '+added line',
    ].join('\n');
  }

  async function runReview(
    diff: string,
    payload: Record<string, unknown>,
  ): Promise<import('./PRReviewService').PRReviewResult> {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);
    const mockSM = makeMockSessionManager();
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_a: string, _b: string, opts: { sessionId: string }) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(opts.sessionId, JSON.stringify(payload)),
          ),
        );
        return opts.sessionId;
      },
    );
    return service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(diff),
    );
  }

  it('forces escalate:true when the diff touches .github/workflows/ even though review_rules found nothing', async () => {
    const result = await runReview(
      makeDiffTouching('.github/workflows/ci.yml'),
      {
        verdict: 'approved',
        dimensions: fourPassedDims,
        summary: 'LLM saw nothing to escalate.',
      },
    );
    expect(result.escalate).toBe(true);
    expect(result.baselineEscalationFloor).toBe(true);
    expect(result.escalationReason).toMatch(/CI\/workflow config/);
  });

  it('forces escalate:true for a migration path', async () => {
    const result = await runReview(
      makeDiffTouching('db/migrations/0042_add_column.sql'),
      {
        verdict: 'approved',
        dimensions: fourPassedDims,
        summary: 'LLM saw nothing to escalate.',
      },
    );
    expect(result.escalate).toBe(true);
    expect(result.baselineEscalationFloor).toBe(true);
    expect(result.escalationReason).toMatch(/database migration/);
  });

  it('forces escalate:true for an auth-related path', async () => {
    const result = await runReview(
      makeDiffTouching('packages/backend/src/auth/session.ts'),
      {
        verdict: 'approved',
        dimensions: fourPassedDims,
        summary: 'LLM saw nothing to escalate.',
      },
    );
    expect(result.escalate).toBe(true);
    expect(result.baselineEscalationFloor).toBe(true);
    expect(result.escalationReason).toMatch(/auth/);
  });

  it('forces escalate:true for a secrets-related path', async () => {
    const result = await runReview(
      makeDiffTouching('packages/backend/src/config/secretsLoader.ts'),
      {
        verdict: 'approved',
        dimensions: fourPassedDims,
        summary: 'LLM saw nothing to escalate.',
      },
    );
    expect(result.escalate).toBe(true);
    expect(result.baselineEscalationFloor).toBe(true);
    expect(result.escalationReason).toMatch(/secrets/);
  });

  it('does not escalate an ordinary diff with no baseline-floor paths', async () => {
    const result = await runReview(makeDiffTouching('src/widgets/Button.tsx'), {
      verdict: 'approved',
      dimensions: fourPassedDims,
      summary: 'Nothing sensitive touched.',
    });
    expect(result.escalate).toBeUndefined();
    expect(result.baselineEscalationFloor).toBeUndefined();
  });

  it('cannot be overridden by the LLM setting escalate:false explicitly', async () => {
    const result = await runReview(
      makeDiffTouching('.github/workflows/deploy.yml'),
      {
        verdict: 'approved',
        dimensions: fourPassedDims,
        summary: 'LLM explicitly declined to escalate.',
        escalate: false,
      },
    );
    expect(result.escalate).toBe(true);
    expect(result.baselineEscalationFloor).toBe(true);
  });
});

// ── buildPrompt() — conformance schema (size relocated to depth review) ──────

describe('PRReviewService.buildPrompt() — conformance schema', () => {
  it('evaluates exactly 4 dimensions and no longer includes size proportionality', () => {
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    const prompt = service.buildPrompt(mockPR, mockDiff, mockTaskBody);
    expect(prompt).toContain('exactly these 4 dimensions');
    expect(prompt).toContain('all 4 passed');
    expect(prompt).not.toContain('"name": "Size proportionality"');
  });
});

// ── reReviewPR() — same-SHA dedup guard ──────────────────────────────────────

describe('PRReviewService.reReviewPR() — same-SHA dedup guard', () => {
  const approvedPayload = {
    verdict: 'approved',
    dimensions: [
      { name: 'Diff vs Context spec', passed: true, notes: 'Fixed.' },
    ],
    summary: 'Issues addressed.',
  };
  const storedNeedsChanges = {
    verdict: 'needs_changes',
    dimensions: [
      { name: 'Diff vs Context spec', passed: false, notes: 'Fix it.' },
    ],
    summary: 'Still needs work.',
  };

  it('two consecutive calls with the same headSha invoke the underlying review exactly once', async () => {
    const prRowFirstCall = {
      ...mockPRRow,
      review_session_id: 'review-session-dedup',
      head_sha: 'sha-abc',
      last_reviewed_sha: null,
      review_result: JSON.stringify(storedNeedsChanges),
    };
    const prRowSecondCall = {
      ...prRowFirstCall,
      last_reviewed_sha: 'sha-abc',
    };

    vi.mocked(getPRByNumber)
      .mockReturnValueOnce(prRowFirstCall as any)
      .mockReturnValue(prRowSecondCall as any);

    const mockSM = makeMockSessionManager();
    (mockSM.sendOrResume as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (sessionId: string) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(sessionId, JSON.stringify(approvedPayload)),
          ),
        );
        return sessionId;
      },
    );

    const github = makeMockGitHub();
    (github.fetchPR as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockPR,
      headSha: 'sha-abc',
    });

    const service = new PRReviewService(
      github,
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    // First call: last_reviewed_sha is null → guard does not fire, review runs
    const first = await service.reReviewPR(42, 'owner/repo');
    expect(first.verdict).toBe('approved');
    expect(mockSM.sendOrResume).toHaveBeenCalledTimes(1);

    // Second call: last_reviewed_sha equals headSha → dedup guard fires, skips review
    const second = await service.reReviewPR(42, 'owner/repo');
    expect(mockSM.sendOrResume).toHaveBeenCalledTimes(1); // no additional calls
    expect(second.verdict).toBe('needs_changes'); // returned from stored result
  });

  it('dedup guard skips incrementReviewIteration and sendOrResume when headSha matches last_reviewed_sha', async () => {
    const prRowSameSha = {
      ...mockPRRow,
      review_session_id: 'review-session-xyz',
      head_sha: 'sha-abc',
      last_reviewed_sha: 'sha-abc',
      review_result: JSON.stringify(storedNeedsChanges),
    };
    vi.mocked(getPRByNumber).mockReturnValue(prRowSameSha as any);

    const mockSM = makeMockSessionManager();
    const github = makeMockGitHub();
    (github.fetchPR as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockPR,
      headSha: 'sha-abc',
    });

    const service = new PRReviewService(
      github,
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    await service.reReviewPR(42, 'owner/repo');

    expect(vi.mocked(incrementReviewIteration)).not.toHaveBeenCalled();
    expect(mockSM.sendOrResume).not.toHaveBeenCalled();
  });

  it('does not skip when headSha differs from last_reviewed_sha', async () => {
    const prRowDifferentSha = {
      ...mockPRRow,
      review_session_id: 'review-session-xyz',
      head_sha: 'sha-abc',
      last_reviewed_sha: 'sha-old',
      review_result: null,
    };
    vi.mocked(getPRByNumber).mockReturnValue(prRowDifferentSha as any);

    const mockSM = makeMockSessionManager();
    (mockSM.sendOrResume as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (sessionId: string) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(sessionId, JSON.stringify(approvedPayload)),
          ),
        );
        return sessionId;
      },
    );

    const github = makeMockGitHub();
    (github.fetchPR as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockPR,
      headSha: 'sha-abc',
    });

    const service = new PRReviewService(
      github,
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    const result = await service.reReviewPR(42, 'owner/repo');
    expect(result.verdict).toBe('approved');
    expect(mockSM.sendOrResume).toHaveBeenCalledTimes(1);
    expect(vi.mocked(incrementReviewIteration)).toHaveBeenCalledTimes(1);
  });
});

// ── reviewPR() — DiffSource populates prompt ──────────────────────────────────

describe('PRReviewService.reviewPR() — DiffSource populates prompt', () => {
  it('uses diff returned by DiffSource in the reviewer prompt', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const customDiff = 'diff --git a/custom.ts b/custom.ts\n+const x = 1;\n';
    const diffSource = makeMockDiffSource(customDiff);

    const approvedPayload = {
      verdict: 'approved',
      dimensions: [
        {
          name: 'Title and description vs task Summary',
          passed: true,
          notes: 'ok',
        },
        { name: 'Diff vs Context spec', passed: true, notes: 'ok' },
        { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'ok' },
        {
          name: 'Changed files vs Files/paths affected list',
          passed: true,
          notes: 'ok',
        },
        { name: 'Size proportionality', passed: true, notes: 'ok' },
      ],
      summary: 'All good.',
    };

    const mockSM = makeMockSessionManager();
    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (
        _a: string,
        _b: string,
        opts: { sessionId: string; customPrompt: string },
      ) => {
        // Verify the custom diff appears in the prompt
        expect(opts.customPrompt).toContain(customDiff);
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(
              opts.sessionId,
              JSON.stringify(approvedPayload),
            ),
          ),
        );
        return opts.sessionId;
      },
    );

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      diffSource,
    );
    expect(result.verdict).toBe('approved');
    expect(diffSource.fetchDiff).toHaveBeenCalledOnce();
  });
});

// ── reviewPR() — local branch verdict persistence ─────────────────────────────

describe('PRReviewService.reviewPR() — local branch verdict persistence', () => {
  const localBranchRow = {
    id: 7,
    project_id: 'proj-1',
    session_id: 'session-lb-1',
    branch_name: 'feature/local-test',
    base_branch: 'dev',
    status: 'open',
    review_result: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  it('persists verdict to local_branches.review_result for local_branch work items', async () => {
    vi.mocked(getLocalBranchById).mockReturnValue(localBranchRow as any);

    const approvedPayload = {
      verdict: 'approved',
      dimensions: [
        {
          name: 'Title and description vs task Summary',
          passed: true,
          notes: 'ok',
        },
        { name: 'Diff vs Context spec', passed: true, notes: 'ok' },
        { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'ok' },
        {
          name: 'Changed files vs Files/paths affected list',
          passed: true,
          notes: 'ok',
        },
        { name: 'Size proportionality', passed: true, notes: 'ok' },
      ],
      summary: 'LGTM.',
    };

    const mockSM = makeMockSessionManager();
    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_a: string, _b: string, opts: { sessionId: string }) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(
              opts.sessionId,
              JSON.stringify(approvedPayload),
            ),
          ),
        );
        return opts.sessionId;
      },
    );

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    const result = await service.reviewPR(
      {
        type: 'local_branch',
        localBranchId: 7,
        branchName: 'feature/local-test',
        baseBranch: 'dev',
        sessionId: 'session-lb-1',
        taskId: null,
      },
      makeMockDiffSource(),
    );

    expect(result.verdict).toBe('approved');
    expect(vi.mocked(setLocalBranchReviewResult)).toHaveBeenCalledWith(
      7,
      expect.any(String),
    );
    const storedJson = vi.mocked(setLocalBranchReviewResult).mock.calls[0][1];
    const stored = JSON.parse(storedJson) as { verdict: string };
    expect(stored.verdict).toBe('approved');
    // Must NOT write to pull_requests
    expect(vi.mocked(setPRReviewResult)).not.toHaveBeenCalled();
  });

  it('persists verdict internally — PRReviewService is the single owner of the write', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const approvedPayload = {
      verdict: 'approved',
      dimensions: [
        {
          name: 'Title and description vs task Summary',
          passed: true,
          notes: 'ok',
        },
        { name: 'Diff vs Context spec', passed: true, notes: 'ok' },
        { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'ok' },
        {
          name: 'Changed files vs Files/paths affected list',
          passed: true,
          notes: 'ok',
        },
        { name: 'Size proportionality', passed: true, notes: 'ok' },
      ],
      summary: 'All good.',
    };

    const mockSM = makeMockSessionManager();
    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_a: string, _b: string, opts: { sessionId: string }) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(
              opts.sessionId,
              JSON.stringify(approvedPayload),
            ),
          ),
        );
        return opts.sessionId;
      },
    );

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    // PRReviewService is now the single owner of the verdict write
    expect(vi.mocked(setPRReviewResult)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      expect.stringContaining('"approved"'),
    );
    // local_branch path writes to setLocalBranchReviewResult, not setPRReviewResult
    expect(vi.mocked(setLocalBranchReviewResult)).not.toHaveBeenCalled();
    expect(result.verdict).toBe('approved');
  });
});

// ── reviewPR() — transient fetch retry ───────────────────────────────────────

describe('PRReviewService.reviewPR() — transient fetch retry', () => {
  const noopSleep = vi.fn().mockResolvedValue(undefined);

  const approvedPayload = {
    verdict: 'approved',
    dimensions: [
      {
        name: 'Title and description vs task Summary',
        passed: true,
        notes: 'ok',
      },
      { name: 'Diff vs Context spec', passed: true, notes: 'ok' },
      { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'ok' },
      {
        name: 'Changed files vs Files/paths affected list',
        passed: true,
        notes: 'ok',
      },
      { name: 'Size proportionality', passed: true, notes: 'ok' },
    ],
    summary: 'All good.',
  };

  function _makeServiceAndStart(
    startImpl: (
      taskUrl: string,
      ctxUrl: string,
      opts: { sessionId: string },
    ) => string,
  ) {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);
    const mockSM = makeMockSessionManager();
    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementation(startImpl);
    const mockGH = makeMockGitHub();
    const service = new PRReviewService(
      mockGH,
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    return { service, mockSM, mockGH };
  }

  it('retries up to 3 times when diff-fetch throws TypeError: fetch failed', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const fetchError = new TypeError('fetch failed');
    const diffSource: DiffSource = {
      fetchDiff: vi
        .fn()
        .mockRejectedValueOnce(fetchError)
        .mockRejectedValueOnce(fetchError)
        .mockRejectedValueOnce(fetchError)
        .mockResolvedValue(mockDiff.diff),
    };

    const mockSM = makeMockSessionManager();
    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_a: string, _b: string, opts: { sessionId: string }) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(
              opts.sessionId,
              JSON.stringify(approvedPayload),
            ),
          ),
        );
        return opts.sessionId;
      },
    );

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      diffSource,
      'proj-1',
      'https://notion.so/ctx',
      noopSleep,
    );

    expect(diffSource.fetchDiff).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    expect(result.verdict).toBe('approved');
    expect(noopSleep).toHaveBeenCalledTimes(3);
    expect(noopSleep).toHaveBeenNthCalledWith(1, 250);
    expect(noopSleep).toHaveBeenNthCalledWith(2, 500);
    expect(noopSleep).toHaveBeenNthCalledWith(3, 1000);
  });

  it('when all retries fail, review_result is NOT stored (setPRReviewResult not called)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const fetchError = new TypeError('fetch failed');
    const diffSource: DiffSource = {
      fetchDiff: vi.fn().mockRejectedValue(fetchError),
    };

    const mockSM = makeMockSessionManager();
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    await expect(
      service.reviewPR(
        { type: 'pr', prNumber: 42, repo: 'owner/repo' },
        diffSource,
        'proj-1',
        'https://notion.so/ctx',
        noopSleep,
      ),
    ).rejects.toBeInstanceOf(FetchRetryExhaustedError);

    expect(vi.mocked(setPRReviewResult)).not.toHaveBeenCalled();
    expect(diffSource.fetchDiff).toHaveBeenCalledTimes(4); // all retries exhausted
  });

  it('when all retries fail, emits review_failed WS message with PR number and error', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const fetchError = new TypeError('fetch failed');
    const diffSource: DiffSource = {
      fetchDiff: vi.fn().mockRejectedValue(fetchError),
    };

    const mockSM = makeMockSessionManager();
    const emittedMessages: unknown[] = [];
    mockSM.on('message', (msg: unknown) => emittedMessages.push(msg));

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    await expect(
      service.reviewPR(
        { type: 'pr', prNumber: 42, repo: 'owner/repo' },
        diffSource,
        'proj-1',
        'https://notion.so/ctx',
        noopSleep,
      ),
    ).rejects.toBeInstanceOf(FetchRetryExhaustedError);

    const failedMsg = emittedMessages.find(
      (m: any) => m.type === 'review_failed',
    ) as
      | { type: string; prNumber: number; repo: string; message: string }
      | undefined;
    expect(failedMsg).toBeDefined();
    expect(failedMsg!.prNumber).toBe(42);
    expect(failedMsg!.repo).toBe('owner/repo');
    expect(failedMsg!.message).toContain('fetch failed');
  });

  it('when retry succeeds on 2nd attempt, verdict is stored normally', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const fetchError = new TypeError('fetch failed');
    const diffSource: DiffSource = {
      fetchDiff: vi
        .fn()
        .mockRejectedValueOnce(fetchError)
        .mockResolvedValue(mockDiff.diff),
    };

    const mockSM = makeMockSessionManager();
    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_a: string, _b: string, opts: { sessionId: string }) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(
              opts.sessionId,
              JSON.stringify(approvedPayload),
            ),
          ),
        );
        return opts.sessionId;
      },
    );

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      diffSource,
      'proj-1',
      'https://notion.so/ctx',
      noopSleep,
    );

    expect(result.verdict).toBe('approved');
    expect(vi.mocked(setPRReviewResult)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      expect.stringContaining('"approved"'),
    );
    expect(diffSource.fetchDiff).toHaveBeenCalledTimes(2);
  });

  it('retries on HTTP 5xx (GitHubApiError with status 503)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const serverError = new GitHubApiError(503, 'Service Unavailable');
    const diffSource: DiffSource = {
      fetchDiff: vi
        .fn()
        .mockRejectedValueOnce(serverError)
        .mockResolvedValue(mockDiff.diff),
    };

    const mockSM = makeMockSessionManager();
    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_a: string, _b: string, opts: { sessionId: string }) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(
              opts.sessionId,
              JSON.stringify(approvedPayload),
            ),
          ),
        );
        return opts.sessionId;
      },
    );

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      diffSource,
      'proj-1',
      'https://notion.so/ctx',
      noopSleep,
    );

    expect(result.verdict).toBe('approved');
    expect(diffSource.fetchDiff).toHaveBeenCalledTimes(2);
  });

  it('retries on HTTP 429 (rate limit)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const rateLimitError = new GitHubApiError(429, 'Too Many Requests');
    const diffSource: DiffSource = {
      fetchDiff: vi
        .fn()
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValue(mockDiff.diff),
    };

    const mockSM = makeMockSessionManager();
    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_a: string, _b: string, opts: { sessionId: string }) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(
              opts.sessionId,
              JSON.stringify(approvedPayload),
            ),
          ),
        );
        return opts.sessionId;
      },
    );

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      diffSource,
      'proj-1',
      'https://notion.so/ctx',
      noopSleep,
    );

    expect(result.verdict).toBe('approved');
    expect(diffSource.fetchDiff).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on HTTP 404 (non-transient 4xx) — fails immediately', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const notFoundError = new GitHubApiError(404, 'Not Found');
    const diffSource: DiffSource = {
      fetchDiff: vi.fn().mockRejectedValue(notFoundError),
    };

    const mockSM = makeMockSessionManager();
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    await expect(
      service.reviewPR(
        { type: 'pr', prNumber: 42, repo: 'owner/repo' },
        diffSource,
        'proj-1',
        'https://notion.so/ctx',
        noopSleep,
      ),
    ).rejects.toThrow(notFoundError);

    // Only 1 call — no retries for 4xx errors
    expect(diffSource.fetchDiff).toHaveBeenCalledTimes(1);
    expect(noopSleep).not.toHaveBeenCalled();
  });

  it('does NOT retry on parse errors (non-transient) — fails immediately', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const parseError = new SyntaxError('Unexpected token in JSON');
    const diffSource: DiffSource = {
      fetchDiff: vi.fn().mockRejectedValue(parseError),
    };

    const mockSM = makeMockSessionManager();
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    await expect(
      service.reviewPR(
        { type: 'pr', prNumber: 42, repo: 'owner/repo' },
        diffSource,
        'proj-1',
        'https://notion.so/ctx',
        noopSleep,
      ),
    ).rejects.toThrow(parseError);

    expect(diffSource.fetchDiff).toHaveBeenCalledTimes(1);
    expect(noopSleep).not.toHaveBeenCalled();
  });
});

// ── Manual verification items ─────────────────────────────────────────────────

describe('PRReviewService — manual verification items excluded from verdict', () => {
  function makeService() {
    return new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );
  }

  it('automated items passing + manual items unfulfilled → verdict approved, not needs_changes', () => {
    const service = makeService();

    // Simulates a reviewer that correctly sets all automated dims to passed:true
    // and surfaces manual items in manualItemsForHuman rather than failing the verdict.
    const payload = {
      verdict: 'approved',
      dimensions: [
        {
          name: 'Title and description vs task Summary',
          passed: true,
          notes: 'ok',
        },
        { name: 'Diff vs Context spec', passed: true, notes: 'ok' },
        {
          name: 'Diff vs Acceptance Criteria',
          passed: true,
          notes: 'Automated criteria met. Manual verification items excluded.',
        },
        {
          name: 'Changed files vs Files/paths affected list',
          passed: true,
          notes: 'ok',
        },
        { name: 'Size proportionality', passed: true, notes: 'ok' },
      ],
      summary:
        'All automated criteria pass. Manual items deferred to human reviewer.',
      manualItemsForHuman: [
        'Verify live credentials work end-to-end',
        'Check dashboard renders correctly in production',
      ],
    };

    const events = [makeAssistantEvent(JSON.stringify(payload))];
    const result = service.parseReviewResult(events, 42, 'owner/repo');

    expect(result.verdict).toBe('approved');
    expect(result.manualItemsForHuman).toEqual([
      'Verify live credentials work end-to-end',
      'Check dashboard renders correctly in production',
    ]);
  });

  it('surfaces manualItemsForHuman field for downstream UI consumption', () => {
    const service = makeService();

    const payload = {
      verdict: 'needs_changes',
      dimensions: [
        {
          name: 'Diff vs Acceptance Criteria',
          passed: false,
          notes: 'Missing unit test.',
        },
      ],
      summary: 'Code changes needed.',
      manualItemsForHuman: ['Run integration test suite against staging'],
    };

    const events = [makeAssistantEvent(JSON.stringify(payload))];
    const result = service.parseReviewResult(events, 42, 'owner/repo');

    expect(result.manualItemsForHuman).toEqual([
      'Run integration test suite against staging',
    ]);
  });

  it('filters the "Covered by the Manual Verification Gate task." sentinel out of manualItemsForHuman', () => {
    const service = makeService();

    const payload = {
      verdict: 'approved',
      dimensions: [{ name: 'Diff vs Context spec', passed: true, notes: 'ok' }],
      summary: 'All good.',
      manualItemsForHuman: [
        'Covered by the Manual Verification Gate task.',
        'Verify live credentials work end-to-end',
      ],
    };

    const events = [makeAssistantEvent(JSON.stringify(payload))];
    const result = service.parseReviewResult(events, 42, 'owner/repo');

    expect(result.manualItemsForHuman).toEqual([
      'Verify live credentials work end-to-end',
    ]);
  });

  it('omits manualItemsForHuman entirely when only the sentinel was present', () => {
    const service = makeService();

    const payload = {
      verdict: 'approved',
      dimensions: [{ name: 'Diff vs Context spec', passed: true, notes: 'ok' }],
      summary: 'All good.',
      manualItemsForHuman: ['Covered by the Manual Verification Gate task.'],
    };

    const events = [makeAssistantEvent(JSON.stringify(payload))];
    const result = service.parseReviewResult(events, 42, 'owner/repo');

    expect(result.manualItemsForHuman).toBeUndefined();
  });

  it('manualItemsForHuman is omitted when the reviewer does not include it', () => {
    const service = makeService();

    const payload = {
      verdict: 'approved',
      dimensions: [{ name: 'Diff vs Context spec', passed: true, notes: 'ok' }],
      summary: 'All good.',
    };

    const events = [makeAssistantEvent(JSON.stringify(payload))];
    const result = service.parseReviewResult(events, 42, 'owner/repo');

    expect(result.manualItemsForHuman).toBeUndefined();
  });

  it('REVIEW_JSON_SCHEMA_BLOCK prompt instructs reviewer to skip manual verification items', () => {
    const service = makeService();
    const prompt = service.buildPrompt(mockPR, mockDiff, mockTaskBody);

    expect(prompt).toContain('Manual verification items');
    expect(prompt).toContain(
      'Exclude them entirely from your pass/fail evaluation',
    );
    expect(prompt).toContain(
      'Never fail the verdict solely because manual verification',
    );
    expect(prompt).toContain('manualItemsForHuman');
  });
});

// ── PRReviewService — toExternalId URL construction ──────────────────────────

describe('PRReviewService — taskUrl strips notion: prefix', () => {
  const approvedPayload = {
    verdict: 'approved',
    dimensions: [
      {
        name: 'Title and description vs task Summary',
        passed: true,
        notes: '',
      },
      { name: 'Diff vs Context spec', passed: true, notes: '' },
      { name: 'Diff vs Acceptance Criteria', passed: true, notes: '' },
      {
        name: 'Changed files vs Files/paths affected list',
        passed: true,
        notes: '',
      },
      { name: 'Size proportionality', passed: true, notes: '' },
    ],
    summary: 'All good.',
    manualItemsForHuman: [],
  };

  it('passes the project context URL as taskUrl and carries the real task association via taskId (not notion:task-abc123)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any); // task_id: 'notion:task-abc123'

    const mockSM = makeMockSessionManager();
    let capturedTaskUrl = '';
    let capturedTaskId: string | undefined;
    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (
        taskUrl: string,
        _ctxUrl: string,
        opts: { sessionId: string; taskId?: string },
      ) => {
        capturedTaskUrl = taskUrl;
        capturedTaskId = opts.taskId;
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(
              opts.sessionId,
              JSON.stringify(approvedPayload),
            ),
          ),
        );
        return opts.sessionId;
      },
    );

    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    // taskUrl is only used for display/storage for a review session — the
    // actual task association is carried by taskId, so it works for any
    // backend (github, notion, etc.).
    expect(capturedTaskUrl).toBe('https://notion.so/ctx');
    expect(capturedTaskId).toBe('notion:task-abc123');
  });
});

// ── Migration-renumber tolerance — deterministic pre-check ──────────────────

describe('evaluateMigrationRenumberTolerance()', () => {
  const listed = ['migrations/postgres/0099_daemon_roster_canary.sql'];

  it('tolerates a renumber to a number free on the base branch', () => {
    const evaluation = evaluateMigrationRenumberTolerance(
      ['migrations/postgres/0108_daemon_roster_canary.sql'],
      listed,
      ['migrations/postgres/0100_unrelated_thing.sql'],
    );
    expect(evaluation.collisions).toEqual([]);
    expect(evaluation.toleratedRenumbers).toEqual([
      {
        diffPath: 'migrations/postgres/0108_daemon_roster_canary.sql',
        listedPath: 'migrations/postgres/0099_daemon_roster_canary.sql',
        number: '0108',
      },
    ]);
  });

  it('flags a collision when the new number is already used on the base branch', () => {
    const evaluation = evaluateMigrationRenumberTolerance(
      ['migrations/postgres/0108_daemon_roster_canary.sql'],
      listed,
      ['migrations/postgres/0108_something_else.sql'],
    );
    expect(evaluation.toleratedRenumbers).toEqual([]);
    expect(evaluation.collisions).toEqual([
      {
        diffPath: 'migrations/postgres/0108_daemon_roster_canary.sql',
        collidesWithPath: 'migrations/postgres/0108_something_else.sql',
        number: '0108',
      },
    ]);
  });

  it('does not treat a literal match as a deviation', () => {
    const evaluation = evaluateMigrationRenumberTolerance(
      ['migrations/postgres/0099_daemon_roster_canary.sql'],
      listed,
      [],
    );
    expect(evaluation.toleratedRenumbers).toEqual([]);
    expect(evaluation.collisions).toEqual([]);
  });

  it('does not tolerate an unrelated migration file with no matching suffix', () => {
    const evaluation = evaluateMigrationRenumberTolerance(
      ['migrations/postgres/0110_totally_unrelated.sql'],
      listed,
      [],
    );
    expect(evaluation.toleratedRenumbers).toEqual([]);
    expect(evaluation.collisions).toEqual([]);
  });

  it('is a pure function — identical inputs always produce identical output', () => {
    const run = () =>
      evaluateMigrationRenumberTolerance(
        ['migrations/postgres/0112_daemon_roster_canary.sql'],
        listed,
        ['migrations/postgres/0100_other.sql'],
      );
    expect(run()).toEqual(run());
  });
});

describe('extractListedMigrationPaths()', () => {
  it('extracts a migration path from the Files / paths affected section', () => {
    const body =
      '## Summary\nDo the thing\n\n' +
      '## Files / paths affected\n' +
      '- migrations/postgres/0099_daemon_roster_canary.sql *(new)*\n' +
      '- packages/backend/src/daemon/roster.ts\n';
    expect(extractListedMigrationPaths(body)).toEqual([
      'migrations/postgres/0099_daemon_roster_canary.sql',
    ]);
  });

  it('returns an empty array when no migration path is listed', () => {
    const body =
      '## Files / paths affected\n- packages/backend/src/daemon/roster.ts\n';
    expect(extractListedMigrationPaths(body)).toEqual([]);
  });
});

describe('overrideFilesPathsDimension()', () => {
  const baseResult = {
    prNumber: 1,
    repo: 'owner/repo',
    verdict: 'needs_changes' as const,
    summary: 's',
    reviewedAt: '2024-01-01T00:00:00Z',
    dimensions: [
      {
        name: 'Title and description vs task Summary',
        passed: true,
        notes: 'ok',
      },
      { name: 'Diff vs Context spec', passed: true, notes: 'ok' },
      { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'ok' },
      {
        name: 'Changed files vs Files/paths affected list',
        passed: false,
        notes: 'migration file numbered differently than the task body',
      },
    ],
  };

  it('flips the dimension to passed and recomputes verdict to approved', () => {
    const result = overrideFilesPathsDimension(
      baseResult,
      true,
      'Deterministic migration-renumber check: tolerated.',
    );
    const dim = result.dimensions!.find(
      (d) => d.name === 'Changed files vs Files/paths affected list',
    )!;
    expect(dim.passed).toBe(true);
    expect(dim.notes).toMatch(/Deterministic migration-renumber check/);
    expect(result.verdict).toBe('approved');
  });

  it('forces the dimension to failed and recomputes verdict to needs_changes, naming the collision', () => {
    const allPassed = {
      ...baseResult,
      dimensions: baseResult.dimensions.map((d) =>
        d.name === 'Changed files vs Files/paths affected list'
          ? { ...d, passed: true }
          : d,
      ),
    };
    const result = overrideFilesPathsDimension(
      allPassed,
      false,
      'Deterministic migration-renumber check: 0108 collides with 0108_something_else.sql.',
    );
    const dim = result.dimensions!.find(
      (d) => d.name === 'Changed files vs Files/paths affected list',
    )!;
    expect(dim.passed).toBe(false);
    expect(dim.notes).toMatch(/collides/);
    expect(result.verdict).toBe('needs_changes');
  });
});

describe('PRReviewService — migration-renumber override wired into reviewPR()', () => {
  const taskBodyWithMigration =
    '## Summary\nAdd the daemon roster canary migration\n\n' +
    '## Files / paths affected\n' +
    '- migrations/postgres/0099_daemon_roster_canary.sql *(new)*\n';

  const dimsFailingFilesOnly = [
    {
      name: 'Title and description vs task Summary',
      passed: true,
      notes: 'ok',
    },
    { name: 'Diff vs Context spec', passed: true, notes: 'ok' },
    { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'ok' },
    {
      name: 'Changed files vs Files/paths affected list',
      passed: false,
      notes: 'migration is 0108_daemon_roster_canary.sql, not 0099 as assigned',
    },
  ];

  const dimsAllPassed = dimsFailingFilesOnly.map((d) =>
    d.name === 'Changed files vs Files/paths affected list'
      ? { ...d, passed: true, notes: 'renumbered, explained above' }
      : d,
  );

  function migrationDiff(path: string): string {
    return [
      `diff --git a/${path} b/${path}`,
      'new file mode 100644',
      `--- /dev/null`,
      `+++ b/${path}`,
      '@@ -0,0 +1,1 @@',
      '+select 1;',
    ].join('\n');
  }

  async function runReview(
    diff: string,
    payload: Record<string, unknown>,
    baseBranchFiles: string[],
  ): Promise<import('./PRReviewService').PRReviewResult> {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);
    const mockSM = makeMockSessionManager();
    const github = makeMockGitHub();
    (github.listFilePathsAtRef as ReturnType<typeof vi.fn>).mockResolvedValue(
      baseBranchFiles,
    );
    const notion = makeMockNotion();
    (notion.fetchTaskPage as ReturnType<typeof vi.fn>).mockResolvedValue(
      taskBodyWithMigration,
    );
    const service = new PRReviewService(
      github,
      notion,
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_a: string, _b: string, opts: { sessionId: string }) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(opts.sessionId, JSON.stringify(payload)),
          ),
        );
        return opts.sessionId;
      },
    );
    return service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(diff),
    );
  }

  it('a renumbered migration to a currently-free number does not fail the dimension (#1027-shaped case)', async () => {
    const result = await runReview(
      migrationDiff('migrations/postgres/0108_daemon_roster_canary.sql'),
      {
        verdict: 'needs_changes',
        dimensions: dimsFailingFilesOnly,
        summary: 'LLM flagged the renumber.',
      },
      ['migrations/postgres/0050_unrelated.sql'],
    );
    const dim = result.dimensions!.find(
      (d) => d.name === 'Changed files vs Files/paths affected list',
    )!;
    expect(dim.passed).toBe(true);
    expect(result.verdict).toBe('approved');
  });

  it('an unlisted non-migration file still fails the dimension — tolerance is scoped to migrations', async () => {
    const dims = [
      {
        name: 'Title and description vs task Summary',
        passed: true,
        notes: 'ok',
      },
      { name: 'Diff vs Context spec', passed: true, notes: 'ok' },
      { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'ok' },
      {
        name: 'Changed files vs Files/paths affected list',
        passed: false,
        notes: 'touches unrelated_module.ts, not in the task spec',
      },
    ];
    const result = await runReview(
      [
        'diff --git a/src/unrelated_module.ts b/src/unrelated_module.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/src/unrelated_module.ts',
        '@@ -0,0 +1,1 @@',
        '+export const x = 1;',
      ].join('\n'),
      {
        verdict: 'needs_changes',
        dimensions: dims,
        summary: 'Unrelated file added.',
      },
      [],
    );
    const dim = result.dimensions!.find(
      (d) => d.name === 'Changed files vs Files/paths affected list',
    )!;
    expect(dim.passed).toBe(false);
  });

  it('a migration number colliding with the base branch still fails, naming the collision', async () => {
    const result = await runReview(
      migrationDiff('migrations/postgres/0108_daemon_roster_canary.sql'),
      {
        verdict: 'approved',
        dimensions: dimsAllPassed,
        summary: 'LLM incorrectly approved despite the collision.',
      },
      ['migrations/postgres/0108_something_else.sql'],
    );
    const dim = result.dimensions!.find(
      (d) => d.name === 'Changed files vs Files/paths affected list',
    )!;
    expect(dim.passed).toBe(false);
    expect(dim.notes).toMatch(/0108/);
    expect(result.verdict).toBe('needs_changes');
  });

  it('replaying #1027 (LLM passed) and #1036 (LLM failed) shaped inputs on the same free-number renumber produces the same outcome', async () => {
    const pr1027Style = await runReview(
      migrationDiff('migrations/postgres/0108_daemon_roster_canary.sql'),
      {
        verdict: 'approved',
        dimensions: dimsAllPassed,
        summary:
          'All core files match the spec list, migration renumbered as explained.',
      },
      ['migrations/postgres/0050_unrelated.sql'],
    );
    const pr1036Style = await runReview(
      migrationDiff('migrations/postgres/0112_daemon_roster_canary.sql'),
      {
        verdict: 'needs_changes',
        dimensions: dimsFailingFilesOnly,
        summary:
          'This resubmission is byte-for-byte identical to the diff already flagged: migration is still not 0099 as assigned.',
      },
      ['migrations/postgres/0050_unrelated.sql'],
    );
    const dim1027 = pr1027Style.dimensions!.find(
      (d) => d.name === 'Changed files vs Files/paths affected list',
    )!;
    const dim1036 = pr1036Style.dimensions!.find(
      (d) => d.name === 'Changed files vs Files/paths affected list',
    )!;
    expect(dim1027.passed).toBe(true);
    expect(dim1036.passed).toBe(true);
    expect(pr1027Style.verdict).toBe('approved');
    expect(pr1036Style.verdict).toBe('approved');
  });
});

describe('PRReviewService — migration-reservation override wired into reviewPR()', () => {
  const taskBodyWithReservation =
    '## Summary\nAdd the widget migration\n\n' +
    '## Files / paths affected\n' +
    '- migrations/postgres/0100_widget_table.sql *(new)*\n';

  const dimsFailingFilesOnly = [
    {
      name: 'Title and description vs task Summary',
      passed: true,
      notes: 'ok',
    },
    { name: 'Diff vs Context spec', passed: true, notes: 'ok' },
    { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'ok' },
    {
      name: 'Changed files vs Files/paths affected list',
      passed: false,
      notes: 'LLM raw verdict: fails for unrelated reasons',
    },
  ];

  const dimsAllPassed = [
    {
      name: 'Title and description vs task Summary',
      passed: true,
      notes: 'ok',
    },
    { name: 'Diff vs Context spec', passed: true, notes: 'ok' },
    { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'ok' },
    {
      name: 'Changed files vs Files/paths affected list',
      passed: true,
      notes: 'LLM raw verdict: looks fine to me',
    },
  ];

  function migrationDiff(path: string): string {
    return [
      `diff --git a/${path} b/${path}`,
      'new file mode 100644',
      `--- /dev/null`,
      `+++ b/${path}`,
      '@@ -0,0 +1,1 @@',
      '+select 1;',
    ].join('\n');
  }

  async function runReview(
    diff: string,
    payload: Record<string, unknown>,
    reservationNumber: number | undefined,
  ): Promise<import('./PRReviewService').PRReviewResult> {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);
    vi.mocked(getReservationForTaskDirSuffix).mockReturnValue(
      reservationNumber === undefined
        ? undefined
        : ({
            id: 'res-1',
            project: 'proj-1',
            number: reservationNumber,
            taskId: mockPRRow.task_id,
            dir: 'migrations/postgres/',
            suffix: 'widget_table.sql',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          } as any),
    );
    const mockSM = makeMockSessionManager();
    const github = makeMockGitHub();
    (github.listFilePathsAtRef as ReturnType<typeof vi.fn>).mockResolvedValue(
      [],
    );
    const notion = makeMockNotion();
    (notion.fetchTaskPage as ReturnType<typeof vi.fn>).mockResolvedValue(
      taskBodyWithReservation,
    );
    const service = new PRReviewService(
      github,
      notion,
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_a: string, _b: string, opts: { sessionId: string }) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(opts.sessionId, JSON.stringify(payload)),
          ),
        );
        return opts.sessionId;
      },
    );
    return service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(diff),
    );
  }

  it('a shipped migration number matching the reservation passes the dimension regardless of the LLM raw verdict', async () => {
    const result = await runReview(
      migrationDiff('migrations/postgres/0100_widget_table.sql'),
      {
        verdict: 'needs_changes',
        dimensions: dimsFailingFilesOnly,
        summary: 'LLM incorrectly flagged a matching migration number.',
      },
      100,
    );
    const dim = result.dimensions!.find(
      (d) => d.name === 'Changed files vs Files/paths affected list',
    )!;
    expect(dim.passed).toBe(true);
    expect(dim.notes).toMatch(/Deterministic migration-reservation check/);
    expect(result.verdict).toBe('approved');
  });

  it('a mismatching shipped number fails the dimension regardless of the LLM raw verdict, rendering expected/actual', async () => {
    const result = await runReview(
      migrationDiff('migrations/postgres/0105_widget_table.sql'),
      {
        verdict: 'approved',
        dimensions: dimsAllPassed,
        summary: 'LLM incorrectly approved a mismatching migration number.',
      },
      100,
    );
    const dim = result.dimensions!.find(
      (d) => d.name === 'Changed files vs Files/paths affected list',
    )!;
    expect(dim.passed).toBe(false);
    expect(dim.notes).toMatch(/Deterministic migration-reservation check/);
    expect(dim.notes).toMatch(/expected migration number 100/);
    expect(dim.notes).toMatch(/ships 105/);
    expect(result.verdict).toBe('needs_changes');
  });
});
