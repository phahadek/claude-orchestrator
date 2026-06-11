import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks (must come before imports of the modules under test) ──────────────

vi.mock('../db/queries.js', () => ({
  getPRByNumber: vi.fn(),
  setPRReviewResult: vi.fn(),
  getEventsBySession: vi.fn(),
  setReviewSessionId: vi.fn(),
  updatePRDraftStatus: vi.fn(),
  incrementReviewIteration: vi.fn(),
  setLastReviewedSha: vi.fn(),
  setHeadSha: vi.fn(),
  setLocalBranchReviewResult: vi.fn(),
  getLocalBranchById: vi.fn(),
  getSession: vi.fn().mockReturnValue(null),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

import { PRReviewService, FetchRetryExhaustedError } from './PRReviewService';
import {
  getPRByNumber,
  setPRReviewResult,
  getEventsBySession,
  setReviewSessionId,
  updatePRDraftStatus,
  incrementReviewIteration,
  setLocalBranchReviewResult,
  getLocalBranchById,
  setLastReviewedSha,
} from '../db/queries';
import { recordEvent } from '../audit/AuditLog';
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

  it('resumes a dead review session via sendOrResume with the original session ID', async () => {
    const prRowWithDeadSession = {
      ...mockPRRow,
      review_session_id: 'dead-review-session-id',
    };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithDeadSession as any);

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
    vi.mocked(mockGH.markPRReady).mockRejectedValue(
      new Error('GitHub outage'),
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

    const autoMergerAttempt = vi.fn();
    service.setAutoMerger({ attempt: autoMergerAttempt } as any);

    await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );

    expect(autoMergerAttempt).toHaveBeenCalledWith(42, 'owner/repo');
  });
});

// ── Size proportionality dimension ────────────────────────────────────────────

describe('PRReviewService — Size proportionality dimension', () => {
  // Build a large diff that blows past the 800-LOC absolute floor.
  function makeOversizedDiff(addedLines: number): string {
    const out: string[] = [
      'diff --git a/packages/backend/src/foo.ts b/packages/backend/src/foo.ts',
      '--- a/packages/backend/src/foo.ts',
      '+++ b/packages/backend/src/foo.ts',
      `@@ -1,1 +1,${addedLines + 1} @@`,
      ' keep me',
    ];
    for (let i = 0; i < addedLines; i++) out.push(`+added line ${i}`);
    return out.join('\n');
  }

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

  it('in-budget PR (no LLM size dim emitted) → synthesized Size dim passed:true, verdict approved', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const payload = {
      verdict: 'approved',
      dimensions: fourPassedDims,
      summary: 'All four passed; LLM omitted size dim.',
    };

    const mockSM = makeMockSessionManager();
    const mockGH = makeMockGitHub(); // returns the small mockDiff

    const service = new PRReviewService(
      mockGH,
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

    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );
    const sizeDim = result.dimensions!.find(
      (d) => d.name === 'Size proportionality',
    );
    expect(sizeDim).toBeDefined();
    expect(sizeDim!.passed).toBe(true);
    expect(result.verdict).toBe('approved');
  });

  it('oversized PR (no LLM size dim emitted) → synthesized Size dim passed:false, verdict needs_changes', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const payload = {
      verdict: 'approved',
      dimensions: fourPassedDims,
      summary: 'AI thinks it is fine; size heuristic disagrees.',
    };

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

    // Pass the oversized diff through the DiffSource (not github.fetchDiff)
    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(makeOversizedDiff(1500)),
    );
    const sizeDim = result.dimensions!.find(
      (d) => d.name === 'Size proportionality',
    );
    expect(sizeDim).toBeDefined();
    expect(sizeDim!.passed).toBe(false);
    expect(sizeDim!.notes).toMatch(/size budget|added\+deleted/);
    expect(result.verdict).toBe('needs_changes');
  });

  it('oversized-but-justified PR (LLM emits passed:true with cleanup rationale) → verdict approved', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const payload = {
      verdict: 'approved',
      dimensions: [
        ...fourPassedDims,
        {
          name: 'Size proportionality',
          passed: true,
          notes:
            'Diff is 1,500 lines but ~1,200 of those are deleting dead code paths the spec implicitly retires.',
        },
      ],
      summary: 'Oversized but justified — necessary corollary cleanup.',
    };

    const mockSM = makeMockSessionManager();
    const mockGH = makeMockGitHub();
    vi.mocked(mockGH.fetchDiff).mockResolvedValue({
      prId: 42,
      diff: makeOversizedDiff(1500),
      filesChanged: ['packages/backend/src/foo.ts'],
    });

    const service = new PRReviewService(
      mockGH,
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

    const result = await service.reviewPR(
      { type: 'pr', prNumber: 42, repo: 'owner/repo' },
      makeMockDiffSource(),
    );
    const sizeDim = result.dimensions!.find(
      (d) => d.name === 'Size proportionality',
    );
    expect(sizeDim).toBeDefined();
    expect(sizeDim!.passed).toBe(true);
    expect(sizeDim!.notes).toContain('1,200');
    expect(result.verdict).toBe('approved');
  });

  it('re-review path recomputes size signal against the FULL refreshed PR diff and injects it into the follow-up prompt', async () => {
    const prRowWithSession = {
      ...mockPRRow,
      review_session_id: 'live-review-session',
    };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithSession as any);

    const payload = {
      verdict: 'needs_changes',
      dimensions: [
        ...fourPassedDims,
        { name: 'Size proportionality', passed: false, notes: 'too large' },
      ],
      summary: 'Oversized, no justification.',
    };

    const mockSM = makeMockSessionManager();
    const mockGH = makeMockGitHub();
    vi.mocked(mockGH.fetchDiff).mockResolvedValue({
      prId: 42,
      diff: makeOversizedDiff(1500),
      filesChanged: ['packages/backend/src/foo.ts'],
    });

    (mockSM.sendOrResume as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (sessionId: string) => {
        setImmediate(() =>
          mockSM.emit(
            'message',
            makeSessionEventMessage(sessionId, JSON.stringify(payload)),
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
    const result = await service.reReviewPR(42, 'owner/repo');

    // Confirm the follow-up sent to the existing session contains refreshed size numbers
    const [, followUpMessage] = (
      mockSM.sendOrResume as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(followUpMessage).toContain('Refreshed Size Signal');
    expect(followUpMessage).toContain('Lines added:');
    expect(followUpMessage).toContain('Oversized: YES');
    expect(result.verdict).toBe('needs_changes');
  });
});

// ── buildPrompt() — size proportionality directive ───────────────────────────

describe('PRReviewService.buildPrompt() — size proportionality', () => {
  it('includes the size signal section with computed numbers', () => {
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    const prompt = service.buildPrompt(mockPR, mockDiff, mockTaskBody);
    expect(prompt).toContain('## Size Signal');
    expect(prompt).toContain('Lines added:');
    expect(prompt).toContain('Lines deleted:');
    expect(prompt).toContain('Files touched:');
    expect(prompt).toContain('Files listed in task spec:');
    expect(prompt).toContain('Absolute LOC floor');
  });

  it('flags an oversized diff with ⚠️ in the signal section', () => {
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    const bigDiffLines: string[] = [
      'diff --git a/src/big.ts b/src/big.ts',
      '--- a/src/big.ts',
      '+++ b/src/big.ts',
      '@@ -1,1 +1,1500 @@',
    ];
    for (let i = 0; i < 1500; i++) bigDiffLines.push(`+l${i}`);
    const bigDiff: PRDiff = {
      prId: 42,
      diff: bigDiffLines.join('\n'),
      filesChanged: ['src/big.ts'],
    };
    const prompt = service.buildPrompt(mockPR, bigDiff, mockTaskBody);
    expect(prompt).toContain('OVERSIZED');
    expect(prompt).toContain('exceeds floor of 800');
  });

  it('includes the Size proportionality dimension in the JSON schema and its directive', () => {
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    const prompt = service.buildPrompt(mockPR, mockDiff, mockTaskBody);
    expect(prompt).toContain('Size proportionality');
    // Reviewer is told to pass only when overflow is necessary corollary work
    expect(prompt).toContain('necessary corollary work');
    // Verdict math updated to 5 dimensions
    expect(prompt).toContain('all 5 passed');
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

  it('passes https://www.notion.so/task-abc123 (not notion:task-abc123) to sessionManager.start', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any); // task_id: 'notion:task-abc123'

    const mockSM = makeMockSessionManager();
    let capturedTaskUrl = '';
    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
        capturedTaskUrl = taskUrl;
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

    expect(capturedTaskUrl).toBe('https://www.notion.so/task-abc123');
    expect(capturedTaskUrl).not.toContain('notion:task-abc123');
  });
});
