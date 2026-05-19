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
}));

import { PRReviewService } from './PRReviewService';
import { getPRByNumber, setPRReviewResult, getEventsBySession, setReviewSessionId, updatePRDraftStatus, incrementReviewIteration } from '../db/queries';
import type { GitHubClient } from './GitHubClient';
import type { TaskTrackerBackend } from '../tasks/TaskTrackerBackend';
import type { PullRequest, PRDiff } from './types';
import type { SessionEvent } from '../db/types';

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
  notion_task_id: 'task-abc123',
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
    getMergeability: vi.fn().mockResolvedValue({ mergeable: true, mergeableState: 'clean' }),
    getMergeabilityWithRetry: vi.fn().mockResolvedValue({ mergeable: true, mergeableState: 'clean' }),
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
    const withPreamble = 'Here is my review:\n' + JSON.stringify(validPayload) + '\nPlease let me know if you need changes.';
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
      dimensions: [{ name: 'Diff vs Acceptance Criteria', passed: false, notes: 'Missing test.' }],
      summary: 'One dimension failed.',
    };
    const verdictEvent = makeAssistantEvent(JSON.stringify(verdictPayload));

    const result = service.parseReviewResult([toolCallEvent, verdictEvent], 42, 'owner/repo');
    expect(result.verdict).toBe('needs_changes');
    expect(result.summary).toBe('One dimension failed.');
  });

  it('succeeds when JSON is split across multiple text blocks in last assistant message', () => {
    const service = makeService();

    const fullPayload = {
      verdict: 'approved',
      dimensions: [{ name: 'Title and description vs task Summary', passed: true, notes: 'Matches.' }],
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

    expect(prompt).toContain('necessary downstream updates caused by the listed changes');
    expect(prompt).toContain('Fail only if the PR touches files unrelated to the task');
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
        { name: 'Title and description vs task Summary', passed: true, notes: 'Good.' },
        { name: 'Diff vs Context spec', passed: true, notes: 'Good.' },
        { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'Good.' },
        { name: 'Changed files vs Files/paths affected list', passed: true, notes: 'Good.' },
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
        { name: 'Title and description vs task Summary', passed: true, notes: 'Matches.' },
        { name: 'Diff vs Context spec', passed: true, notes: 'Matches.' },
        { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'Matches.' },
        { name: 'Changed files vs Files/paths affected list', passed: true, notes: 'Matches.' },
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
    startMock.mockImplementationOnce((_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
      const id = opts.sessionId;
      // Emit verdict via session_event — session stays alive (no session_ended)
      setImmediate(() =>
        mockSM.emit('message', makeSessionEventMessage(id, JSON.stringify(claudePayload))),
      );
      return id;
    });

    const result = await service.reviewPR(42, 'owner/repo');

    expect(startMock).toHaveBeenCalledOnce();
    const [, , opts] = startMock.mock.calls[0];
    expect(opts.sessionType).toBe('review');
    expect(typeof opts.customPrompt).toBe('string');
    expect(typeof opts.sessionId).toBe('string');

    expect(result.verdict).toBe('approved');
    expect(vi.mocked(setPRReviewResult)).toHaveBeenCalledOnce();
    expect(vi.mocked(setReviewSessionId)).toHaveBeenCalledWith(42, 'owner/repo', opts.sessionId);
  });

  it('falls back to stored events when session_ended fires before verdict', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const claudePayload = {
      verdict: 'needs_changes',
      dimensions: [{ name: 'Diff vs Context spec', passed: false, notes: 'Missing export.' }],
      summary: 'One dimension failed.',
    };
    vi.mocked(getEventsBySession).mockReturnValue([makeAssistantEvent(JSON.stringify(claudePayload))]);

    const mockSM = makeMockSessionManager();
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    const startMock = mockSM.start as ReturnType<typeof vi.fn>;
    startMock.mockImplementationOnce((_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
      const id = opts.sessionId;
      setImmediate(() =>
        mockSM.emit('message', { type: 'session_ended', sessionId: id, status: 'done' }),
      );
      return id;
    });

    const result = await service.reviewPR(42, 'owner/repo');

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
    startMock.mockImplementationOnce((_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
      // Check how many 'message' listeners are attached at the moment start() is called.
      // With the fix, waitForVerdict() has already subscribed, so count must be >= 1.
      listenerCountAtStart = mockSM.listenerCount('message');
      // Emit verdict synchronously inside start() — will only be captured if listener
      // was already attached before start() was called.
      mockSM.emit('message', makeSessionEventMessage(opts.sessionId, JSON.stringify(claudePayload)));
      return opts.sessionId;
    });

    const result = await service.reviewPR(42, 'owner/repo');

    expect(listenerCountAtStart).toBeGreaterThanOrEqual(1);
    expect(result.verdict).toBe('approved');
  });

  it('fast review: verdict emitted synchronously during start() is captured, not missed', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const claudePayload = {
      verdict: 'approved',
      dimensions: [{ name: 'Diff vs Acceptance Criteria', passed: true, notes: 'ok' }],
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
    startMock.mockImplementationOnce((_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
      const id = opts.sessionId;
      // Emit SYNCHRONOUSLY inside start() — simulates the CLI completing the
      // review before start() even returns (the original race condition).
      mockSM.emit('message', makeSessionEventMessage(id, JSON.stringify(claudePayload)));
      return id;
    });

    const result = await service.reviewPR(42, 'owner/repo');

    expect(result.verdict).toBe('approved');
    expect(result.summary).toBe('Approved immediately.');
    expect(vi.mocked(setPRReviewResult)).toHaveBeenCalledOnce();
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

    await expect(service.reviewPR(99, 'owner/repo')).rejects.toThrow('not found in database');
  });
});

// ── Merge conflict dimension ──────────────────────────────────────────────────

describe('PRReviewService — merge conflict dimension', () => {
  const allPassedAIPayload = {
    verdict: 'approved',
    dimensions: [
      { name: 'Title and description vs task Summary', passed: true, notes: 'ok' },
      { name: 'Diff vs Context spec', passed: true, notes: 'ok' },
      { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'ok' },
      { name: 'Changed files vs Files/paths affected list', passed: true, notes: 'ok' },
    ],
    summary: 'All four AI dimensions passed.',
  };

  it('includes 5th Merge conflicts dimension with passed=true when mergeable=true', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const mockSM = makeMockSessionManager();
    const mockGH = makeMockGitHub();
    vi.mocked(mockGH.getMergeability).mockResolvedValue({ mergeable: true, mergeableState: 'clean' });
    vi.mocked(mockGH.getMergeabilityWithRetry).mockResolvedValue({ mergeable: true, mergeableState: 'clean' });

    const service = new PRReviewService(mockGH, makeMockNotion(), mockSM as any, 'proj-1', 'https://notion.so/ctx');

    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce((_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
      const id = opts.sessionId;
      setImmediate(() => mockSM.emit('message', makeSessionEventMessage(id, JSON.stringify(allPassedAIPayload))));
      return id;
    });

    const result = await service.reviewPR(42, 'owner/repo');

    expect(result.dimensions).toHaveLength(5);
    const conflictDim = result.dimensions!.find((d) => d.name === 'Merge conflicts');
    expect(conflictDim).toBeDefined();
    expect(conflictDim!.passed).toBe(true);
    expect(result.verdict).toBe('approved');
  });

  it('includes 5th Merge conflicts dimension with passed=false when mergeable=false, downgrading verdict to needs_changes', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const mockSM = makeMockSessionManager();
    const mockGH = makeMockGitHub();
    vi.mocked(mockGH.getMergeability).mockResolvedValue({ mergeable: false, mergeableState: 'dirty' });
    vi.mocked(mockGH.getMergeabilityWithRetry).mockResolvedValue({ mergeable: false, mergeableState: 'dirty' });

    const service = new PRReviewService(mockGH, makeMockNotion(), mockSM as any, 'proj-1', 'https://notion.so/ctx');

    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce((_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
      const id = opts.sessionId;
      setImmediate(() => mockSM.emit('message', makeSessionEventMessage(id, JSON.stringify(allPassedAIPayload))));
      return id;
    });

    const result = await service.reviewPR(42, 'owner/repo');

    expect(result.dimensions).toHaveLength(5);
    const conflictDim = result.dimensions!.find((d) => d.name === 'Merge conflicts');
    expect(conflictDim).toBeDefined();
    expect(conflictDim!.passed).toBe(false);
    expect(conflictDim!.notes).toContain('merge conflicts');
    expect(result.verdict).toBe('needs_changes');
  });

  it('skips Merge conflicts dimension when mergeable=null (GitHub still computing), preserving AI verdict', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const mockSM = makeMockSessionManager();
    const mockGH = makeMockGitHub();
    vi.mocked(mockGH.getMergeability).mockResolvedValue({ mergeable: null, mergeableState: null });
    vi.mocked(mockGH.getMergeabilityWithRetry).mockResolvedValue({ mergeable: null, mergeableState: null });

    const service = new PRReviewService(mockGH, makeMockNotion(), mockSM as any, 'proj-1', 'https://notion.so/ctx');

    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce((_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
      const id = opts.sessionId;
      setImmediate(() => mockSM.emit('message', makeSessionEventMessage(id, JSON.stringify(allPassedAIPayload))));
      return id;
    });

    const result = await service.reviewPR(42, 'owner/repo');

    // No Merge conflicts dimension appended — GitHub hasn't computed it yet
    const conflictDim = result.dimensions!.find((d) => d.name === 'Merge conflicts');
    expect(conflictDim).toBeUndefined();
    // AI verdict (approved) is preserved — not downgraded to needs_changes
    expect(result.verdict).toBe('approved');
    expect(result.dimensions).toHaveLength(4);
  });

  it('preserves incomplete verdict when session killed with mergeable=null, no conflict dim appended', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);
    // Empty events → parseReviewResult returns incomplete (JSON parse failure)
    vi.mocked(getEventsBySession).mockReturnValue([]);

    const mockSM = makeMockSessionManager();
    const mockGH = makeMockGitHub();
    vi.mocked(mockGH.getMergeability).mockResolvedValue({ mergeable: null, mergeableState: null });
    vi.mocked(mockGH.getMergeabilityWithRetry).mockResolvedValue({ mergeable: null, mergeableState: null });

    const service = new PRReviewService(mockGH, makeMockNotion(), mockSM as any, 'proj-1', 'https://notion.so/ctx');

    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce((_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
      const id = opts.sessionId;
      // Simulate killed session: session_ended fires with no prior verdict
      setImmediate(() => mockSM.emit('message', { type: 'session_ended', sessionId: id, status: 'killed' }));
      return id;
    });

    const result = await service.reviewPR(42, 'owner/repo');

    expect(result.verdict).toBe('incomplete');
    // mergeable=null → dimension is skipped entirely
    const conflictDim = result.dimensions?.find((d) => d.name === 'Merge conflicts');
    expect(conflictDim).toBeUndefined();
  });

  it('preserves incomplete verdict when session killed with mergeable=true', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);
    vi.mocked(getEventsBySession).mockReturnValue([]);

    const mockSM = makeMockSessionManager();
    const mockGH = makeMockGitHub();
    vi.mocked(mockGH.getMergeability).mockResolvedValue({ mergeable: true, mergeableState: 'clean' });
    vi.mocked(mockGH.getMergeabilityWithRetry).mockResolvedValue({ mergeable: true, mergeableState: 'clean' });

    const service = new PRReviewService(mockGH, makeMockNotion(), mockSM as any, 'proj-1', 'https://notion.so/ctx');

    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce((_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
      const id = opts.sessionId;
      setImmediate(() => mockSM.emit('message', { type: 'session_ended', sessionId: id, status: 'killed' }));
      return id;
    });

    const result = await service.reviewPR(42, 'owner/repo');

    expect(result.verdict).toBe('incomplete');
  });
});

// ── handleApprovedVerdict() ───────────────────────────────────────────────────

describe('PRReviewService.handleApprovedVerdict()', () => {
  it('calls markPRReady and updatePRDraftStatus when PR is a draft', async () => {
    const draftPRRow = { ...mockPRRow, draft: 1 };
    vi.mocked(getPRByNumber).mockReturnValue(draftPRRow as any);

    const mockGH = makeMockGitHub();
    const service = new PRReviewService(mockGH, makeMockNotion(), makeMockSessionManager() as any, 'proj-1', 'https://notion.so/ctx');

    const result = await service.handleApprovedVerdict(42, 'owner/repo', 'task-abc123');

    expect(vi.mocked(mockGH.markPRReady)).toHaveBeenCalledWith('owner/repo', 42);
    expect(vi.mocked(updatePRDraftStatus)).toHaveBeenCalledWith(42, 'owner/repo', 0);
    expect(result).toBe(true);
  });

  it('calls markPRReady even when PR is not a draft (draft=0) — eliminates stale-field race', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any); // draft: 0

    const mockGH = makeMockGitHub();
    const service = new PRReviewService(mockGH, makeMockNotion(), makeMockSessionManager() as any, 'proj-1', 'https://notion.so/ctx');

    const result = await service.handleApprovedVerdict(42, 'owner/repo', 'task-abc123');

    expect(vi.mocked(mockGH.markPRReady)).toHaveBeenCalledWith('owner/repo', 42);
    expect(vi.mocked(updatePRDraftStatus)).toHaveBeenCalledWith(42, 'owner/repo', 0);
    expect(result).toBe(true);
  });

  it('handles markPRReady failure gracefully — does not throw, returns false', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const mockGH = makeMockGitHub();
    vi.mocked(mockGH.markPRReady).mockRejectedValue(new Error('PR is not a draft'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new PRReviewService(mockGH, makeMockNotion(), makeMockSessionManager() as any, 'proj-1', 'https://notion.so/ctx');

    const result = await service.handleApprovedVerdict(42, 'owner/repo', 'task-abc123');

    expect(vi.mocked(mockGH.markPRReady)).toHaveBeenCalledWith('owner/repo', 42);
    expect(vi.mocked(updatePRDraftStatus)).not.toHaveBeenCalled();
    expect(result).toBe(false);
    warnSpy.mockRestore();
  });

  it('updates Notion status to In Review when taskId is provided', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const mockNotion = makeMockNotion();
    const service = new PRReviewService(makeMockGitHub(), mockNotion, makeMockSessionManager() as any, 'proj-1', 'https://notion.so/ctx');

    await service.handleApprovedVerdict(42, 'owner/repo', 'task-abc123');

    expect(vi.mocked(mockNotion.updateStatus)).toHaveBeenCalledWith('task-abc123', '👀 In Review');
  });

  it('does NOT call Notion updateStatus when taskId is null', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const mockNotion = makeMockNotion();
    const service = new PRReviewService(makeMockGitHub(), mockNotion, makeMockSessionManager() as any, 'proj-1', 'https://notion.so/ctx');

    await service.handleApprovedVerdict(42, 'owner/repo', null);

    expect(vi.mocked(mockNotion.updateStatus)).not.toHaveBeenCalled();
  });
});

// ── reviewPR() — approved verdict triggers handleApprovedVerdict ──────────────

describe('PRReviewService.reviewPR() — approved verdict calls handleApprovedVerdict', () => {
  const claudeApprovedPayload = {
    verdict: 'approved',
    dimensions: [
      { name: 'Title and description vs task Summary', passed: true, notes: 'ok' },
      { name: 'Diff vs Context spec', passed: true, notes: 'ok' },
      { name: 'Diff vs Acceptance Criteria', passed: true, notes: 'ok' },
      { name: 'Changed files vs Files/paths affected list', passed: true, notes: 'ok' },
    ],
    summary: 'All dimensions passed.',
  };

  it('calls markPRReady when approved verdict and PR is a draft', async () => {
    const draftPRRow = { ...mockPRRow, draft: 1 };
    vi.mocked(getPRByNumber).mockReturnValue(draftPRRow as any);

    const mockGH = makeMockGitHub();
    const mockSM = makeMockSessionManager();
    const service = new PRReviewService(mockGH, makeMockNotion(), mockSM as any, 'proj-1', 'https://notion.so/ctx');

    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce((_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
      setImmediate(() => mockSM.emit('message', makeSessionEventMessage(opts.sessionId, JSON.stringify(claudeApprovedPayload))));
      return opts.sessionId;
    });

    const result = await service.reviewPR(42, 'owner/repo');

    expect(result.verdict).toBe('approved');
    expect(vi.mocked(mockGH.markPRReady)).toHaveBeenCalledWith('owner/repo', 42);
    expect(vi.mocked(updatePRDraftStatus)).toHaveBeenCalledWith(42, 'owner/repo', 0);
  });

  it('does NOT call markPRReady when verdict is needs_changes', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({ ...mockPRRow, draft: 1 } as any);

    const needsChangesPayload = {
      verdict: 'needs_changes',
      dimensions: [{ name: 'Diff vs Context spec', passed: false, notes: 'Missing export.' }],
      summary: 'One dimension failed.',
    };

    const mockGH = makeMockGitHub();
    vi.mocked(mockGH.getMergeability).mockResolvedValue({ mergeable: true, mergeableState: 'clean' });
    vi.mocked(mockGH.getMergeabilityWithRetry).mockResolvedValue({ mergeable: true, mergeableState: 'clean' });
    const mockSM = makeMockSessionManager();
    const service = new PRReviewService(mockGH, makeMockNotion(), mockSM as any, 'proj-1', 'https://notion.so/ctx');

    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce((_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
      setImmediate(() => mockSM.emit('message', makeSessionEventMessage(opts.sessionId, JSON.stringify(needsChangesPayload))));
      return opts.sessionId;
    });

    const result = await service.reviewPR(42, 'owner/repo');

    expect(result.verdict).toBe('needs_changes');
    expect(vi.mocked(mockGH.markPRReady)).not.toHaveBeenCalled();
    expect(vi.mocked(updatePRDraftStatus)).not.toHaveBeenCalled();
  });

  it('updates Notion to In Review when approved verdict and PR has notion_task_id', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any); // notion_task_id: 'task-abc123'

    const mockGH = makeMockGitHub();
    const mockNotion = makeMockNotion();
    const mockSM = makeMockSessionManager();
    const service = new PRReviewService(mockGH, mockNotion, mockSM as any, 'proj-1', 'https://notion.so/ctx');

    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce((_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
      setImmediate(() => mockSM.emit('message', makeSessionEventMessage(opts.sessionId, JSON.stringify(claudeApprovedPayload))));
      return opts.sessionId;
    });

    await service.reviewPR(42, 'owner/repo');

    expect(vi.mocked(mockNotion.updateStatus)).toHaveBeenCalledWith('task-abc123', '👀 In Review');
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
    const prRowWithLiveSession = { ...mockPRRow, review_session_id: 'existing-review-session-id' };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithLiveSession as any);

    const mockSM = makeMockSessionManager();
    (mockSM.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const sendMock = mockSM.send as ReturnType<typeof vi.fn>;
    sendMock.mockImplementationOnce(() => {
      setImmediate(() =>
        mockSM.emit('message', makeSessionEventMessage('existing-review-session-id', JSON.stringify(claudePayload))),
      );
    });

    const service = new PRReviewService(makeMockGitHub(), makeMockNotion(), mockSM as any, 'proj-1', 'https://notion.so/ctx');
    const result = await service.reviewPR(42, 'owner/repo');

    expect(mockSM.start).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledWith('existing-review-session-id', expect.any(String));
    expect(vi.mocked(setReviewSessionId)).not.toHaveBeenCalled();
    expect(result.verdict).toBe('approved');
  });

  it('resumes a dead review session via sendOrResume with the original session ID', async () => {
    const prRowWithDeadSession = { ...mockPRRow, review_session_id: 'dead-review-session-id' };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithDeadSession as any);

    const mockSM = makeMockSessionManager();
    (mockSM.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const resumedId = 'new-resumed-session-id';
    (mockSM.sendOrResume as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      setImmediate(() =>
        mockSM.emit('message', makeSessionEventMessage(resumedId, JSON.stringify(claudePayload))),
      );
      return resumedId;
    });

    const service = new PRReviewService(makeMockGitHub(), makeMockNotion(), mockSM as any, 'proj-1', 'https://notion.so/ctx');
    const result = await service.reviewPR(42, 'owner/repo');

    expect(mockSM.start).not.toHaveBeenCalled();
    expect(mockSM.sendOrResume).toHaveBeenCalledWith('dead-review-session-id', expect.any(String));
    expect(vi.mocked(setReviewSessionId)).toHaveBeenCalledWith(42, 'owner/repo', resumedId);
    expect(result.verdict).toBe('approved');
  });

  it('spawns a new session only when no prior review_session_id exists on the PR', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any); // review_session_id: null

    const mockSM = makeMockSessionManager();
    const startMock = mockSM.start as ReturnType<typeof vi.fn>;
    startMock.mockImplementationOnce((_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
      const id = opts.sessionId;
      setImmediate(() =>
        mockSM.emit('message', makeSessionEventMessage(id, JSON.stringify(claudePayload))),
      );
      return id;
    });

    const service = new PRReviewService(makeMockGitHub(), makeMockNotion(), mockSM as any, 'proj-1', 'https://notion.so/ctx');
    const result = await service.reviewPR(42, 'owner/repo');

    expect(startMock).toHaveBeenCalledOnce();
    expect(mockSM.send).not.toHaveBeenCalled();
    expect(mockSM.sendOrResume).not.toHaveBeenCalled();
    const [, , opts] = startMock.mock.calls[0];
    expect(vi.mocked(setReviewSessionId)).toHaveBeenCalledWith(42, 'owner/repo', opts.sessionId);
    expect(result.verdict).toBe('approved');
  });

  it('live-session follow-up inlines the full JSON schema (not a reference to "same format")', async () => {
    const prRowWithLiveSession = { ...mockPRRow, review_session_id: 'existing-review-session-id' };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithLiveSession as any);

    const mockSM = makeMockSessionManager();
    (mockSM.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);

    (mockSM.send as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      setImmediate(() =>
        mockSM.emit('message', makeSessionEventMessage('existing-review-session-id', JSON.stringify(claudePayload))),
      );
    });

    const service = new PRReviewService(makeMockGitHub(), makeMockNotion(), mockSM as any, 'proj-1', 'https://notion.so/ctx');
    await service.reviewPR(42, 'owner/repo');

    const [, followUp] = (mockSM.send as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(followUp).not.toContain('same JSON review format as before');
    expect(followUp).toContain('"verdict"');
    expect(followUp).toContain('"dimensions"');
    expect(followUp).toContain('Title and description vs task Summary');
    expect(followUp).toContain('Diff vs Context spec');
    expect(followUp).toContain('Diff vs Acceptance Criteria');
    expect(followUp).toContain('Changed files vs Files/paths affected list');
    expect(followUp).toContain('verdict rules:');
    expect(followUp).toContain('necessary downstream updates caused by the listed changes');
  });

  it('does not overwrite review_session_id when reusing an existing live session', async () => {
    const prRowWithLiveSession = { ...mockPRRow, review_session_id: 'existing-review-session-id' };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithLiveSession as any);

    const mockSM = makeMockSessionManager();
    (mockSM.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);

    (mockSM.send as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      setImmediate(() =>
        mockSM.emit('message', makeSessionEventMessage('existing-review-session-id', JSON.stringify(claudePayload))),
      );
    });

    const service = new PRReviewService(makeMockGitHub(), makeMockNotion(), mockSM as any, 'proj-1', 'https://notion.so/ctx');
    await service.reviewPR(42, 'owner/repo');

    expect(vi.mocked(setReviewSessionId)).not.toHaveBeenCalled();
  });
});

// ── reReviewPR() ──────────────────────────────────────────────────────────────

describe('PRReviewService.reReviewPR()', () => {
  const claudePayload = {
    verdict: 'approved',
    dimensions: [{ name: 'Diff vs Context spec', passed: true, notes: 'Fixed.' }],
    summary: 'Issues addressed.',
  };

  it('calls sendOrResume with the existing review_session_id', async () => {
    const prRowWithSession = { ...mockPRRow, review_session_id: 'existing-review-session-abc' };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithSession as any);

    const mockSM = makeMockSessionManager();
    (mockSM.sendOrResume as ReturnType<typeof vi.fn>).mockImplementationOnce(async (sessionId: string) => {
      setImmediate(() =>
        mockSM.emit('message', makeSessionEventMessage(sessionId, JSON.stringify(claudePayload))),
      );
      return sessionId;
    });

    const service = new PRReviewService(makeMockGitHub(), makeMockNotion(), mockSM as any, 'proj-1', 'https://notion.so/ctx');
    const result = await service.reReviewPR(42, 'owner/repo');

    expect(mockSM.sendOrResume).toHaveBeenCalledOnce();
    const [calledSessionId] = (mockSM.sendOrResume as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledSessionId).toBe('existing-review-session-abc');
    expect(result.verdict).toBe('approved');
  });

  it('falls back to reviewPR() when PR has no review_session_id', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any); // review_session_id: null

    const mockSM = makeMockSessionManager();
    const startMock = mockSM.start as ReturnType<typeof vi.fn>;
    startMock.mockImplementationOnce((_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
      const id = opts.sessionId;
      setImmediate(() =>
        mockSM.emit('message', makeSessionEventMessage(id, JSON.stringify(claudePayload))),
      );
      return id;
    });

    const service = new PRReviewService(makeMockGitHub(), makeMockNotion(), mockSM as any, 'proj-1', 'https://notion.so/ctx');
    const result = await service.reReviewPR(42, 'owner/repo');

    expect(startMock).toHaveBeenCalledOnce();
    expect(mockSM.sendOrResume).not.toHaveBeenCalled();
    expect(result.verdict).toBe('approved');
  });

  it('increments review_iteration in DB before calling sendOrResume', async () => {
    const prRowWithSession = { ...mockPRRow, review_session_id: 'review-session-xyz', review_iteration: 1 };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithSession as any);

    const mockSM = makeMockSessionManager();
    (mockSM.sendOrResume as ReturnType<typeof vi.fn>).mockImplementationOnce(async (sessionId: string) => {
      setImmediate(() =>
        mockSM.emit('message', makeSessionEventMessage(sessionId, JSON.stringify(claudePayload))),
      );
      return sessionId;
    });

    const service = new PRReviewService(makeMockGitHub(), makeMockNotion(), mockSM as any, 'proj-1', 'https://notion.so/ctx');
    await service.reReviewPR(42, 'owner/repo');

    expect(vi.mocked(incrementReviewIteration)).toHaveBeenCalledWith(42, 'owner/repo');
  });

  it('updates review_session_id when sendOrResume returns a new session ID', async () => {
    const prRowWithSession = { ...mockPRRow, review_session_id: 'old-review-session' };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithSession as any);

    const mockSM = makeMockSessionManager();
    (mockSM.sendOrResume as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      setImmediate(() =>
        mockSM.emit('message', makeSessionEventMessage('new-review-session', JSON.stringify(claudePayload))),
      );
      return 'new-review-session';
    });

    const service = new PRReviewService(makeMockGitHub(), makeMockNotion(), mockSM as any, 'proj-1', 'https://notion.so/ctx');
    await service.reReviewPR(42, 'owner/repo');

    expect(vi.mocked(setReviewSessionId)).toHaveBeenCalledWith(42, 'owner/repo', 'new-review-session');
  });

  it('follow-up inlines the full JSON schema (not a reference to "same format")', async () => {
    const prRowWithSession = { ...mockPRRow, review_session_id: 'review-session-abc' };
    vi.mocked(getPRByNumber).mockReturnValue(prRowWithSession as any);

    const mockSM = makeMockSessionManager();
    (mockSM.sendOrResume as ReturnType<typeof vi.fn>).mockImplementationOnce(async (sessionId: string) => {
      setImmediate(() =>
        mockSM.emit('message', makeSessionEventMessage(sessionId, JSON.stringify(claudePayload))),
      );
      return sessionId;
    });

    const service = new PRReviewService(makeMockGitHub(), makeMockNotion(), mockSM as any, 'proj-1', 'https://notion.so/ctx');
    await service.reReviewPR(42, 'owner/repo');

    const [, followUp] = (mockSM.sendOrResume as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(followUp).not.toContain('same JSON review format as before');
    expect(followUp).toContain('"verdict"');
    expect(followUp).toContain('"dimensions"');
    expect(followUp).toContain('Title and description vs task Summary');
    expect(followUp).toContain('Diff vs Context spec');
    expect(followUp).toContain('Diff vs Acceptance Criteria');
    expect(followUp).toContain('Changed files vs Files/paths affected list');
    expect(followUp).toContain('verdict rules:');
    expect(followUp).toContain('necessary downstream updates caused by the listed changes');
  });
});
