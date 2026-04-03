import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks (must come before imports of the modules under test) ──────────────

vi.mock('../db/queries.js', () => ({
  getPRByNumber: vi.fn(),
  setPRReviewResult: vi.fn(),
  getEventsBySession: vi.fn(),
  setReviewSessionId: vi.fn(),
  updatePRDraftStatus: vi.fn(),
}));

import { PRReviewService } from './PRReviewService';
import { getPRByNumber, setPRReviewResult, getEventsBySession, setReviewSessionId, updatePRDraftStatus } from '../db/queries';
import type { GitHubClient } from './GitHubClient';
import type { NotionClient } from '../notion/NotionClient';
import type { PullRequest, PRDiff } from './types';
import type { NotionTaskPage } from '../notion/NotionClient';
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

const mockTask: NotionTaskPage = {
  taskId: 'task-abc123',
  name: 'Add something cool',
  summarySection: 'Implement the something cool feature for users',
  contextSection: 'The implementation should add bar export to foo.ts using the existing pattern',
  acceptanceCriteria: '- [ ] bar export is added\n- [ ] tsc passes',
  filesSection: '- src/foo.ts (update)',
  rawMarkdown: '## Summary\nImplement...\n## Context\n...\n## Acceptance Criteria\n...\n## Files\n...',
};

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
    fetchDiff: vi.fn().mockResolvedValue(mockDiff),
    mergePR: vi.fn(),
    getMergeability: vi.fn().mockResolvedValue({ mergeable: true, mergeableState: 'clean' }),
    markPRReady: vi.fn().mockResolvedValue(undefined),
  } as unknown as GitHubClient;
}

function makeMockNotion(): NotionClient {
  return {
    fetchTaskPage: vi.fn().mockResolvedValue(mockTask),
    fetchReadyTasks: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    attachPR: vi.fn(),
  } as unknown as NotionClient;
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
  it('includes PR diff, all four Notion spec sections, and the JSON schema instruction', () => {
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    const prompt = service.buildPrompt(mockPR, mockDiff, mockTask);

    expect(prompt).toContain(mockPR.title);
    expect(prompt).toContain(mockDiff.diff);
    expect(prompt).toContain(mockTask.summarySection);
    expect(prompt).toContain(mockTask.contextSection);
    expect(prompt).toContain(mockTask.acceptanceCriteria);
    expect(prompt).toContain(mockTask.filesSection);
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
    const prompt = service.buildPrompt(mockPR, mockDiff, mockTask);

    expect(prompt).toContain('necessary downstream updates caused by the listed changes');
    expect(prompt).toContain('Fail only if the PR touches files unrelated to the task');
  });

  it('truncates diffs longer than 12000 characters and appends a truncation notice', () => {
    const longDiff: PRDiff = { ...mockDiff, diff: 'A'.repeat(13000) };
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      makeMockSessionManager() as any,
      'proj-1',
      'https://notion.so/ctx',
    );
    const prompt = service.buildPrompt(mockPR, longDiff, mockTask);

    expect(prompt).toContain('[diff truncated');
    expect(prompt).not.toContain('A'.repeat(13000));
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

  it('treats mergeable=null as failed (GitHub still computing — unknown is not passing)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);

    const mockSM = makeMockSessionManager();
    const mockGH = makeMockGitHub();
    vi.mocked(mockGH.getMergeability).mockResolvedValue({ mergeable: null, mergeableState: null });

    const service = new PRReviewService(mockGH, makeMockNotion(), mockSM as any, 'proj-1', 'https://notion.so/ctx');

    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce((_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
      const id = opts.sessionId;
      setImmediate(() => mockSM.emit('message', makeSessionEventMessage(id, JSON.stringify(allPassedAIPayload))));
      return id;
    });

    const result = await service.reviewPR(42, 'owner/repo');

    const conflictDim = result.dimensions!.find((d) => d.name === 'Merge conflicts');
    expect(conflictDim!.passed).toBe(false);
    expect(result.verdict).toBe('needs_changes');
  });

  it('preserves incomplete verdict when session killed with mergeable=null (killed-session bug)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);
    // Empty events → parseReviewResult returns incomplete (JSON parse failure)
    vi.mocked(getEventsBySession).mockReturnValue([]);

    const mockSM = makeMockSessionManager();
    const mockGH = makeMockGitHub();
    vi.mocked(mockGH.getMergeability).mockResolvedValue({ mergeable: null, mergeableState: null });

    const service = new PRReviewService(mockGH, makeMockNotion(), mockSM as any, 'proj-1', 'https://notion.so/ctx');

    (mockSM.start as ReturnType<typeof vi.fn>).mockImplementationOnce((_taskUrl: string, _ctxUrl: string, opts: { sessionId: string }) => {
      const id = opts.sessionId;
      // Simulate killed session: session_ended fires with no prior verdict
      setImmediate(() => mockSM.emit('message', { type: 'session_ended', sessionId: id, status: 'killed' }));
      return id;
    });

    const result = await service.reviewPR(42, 'owner/repo');

    expect(result.verdict).toBe('incomplete');
    const conflictDim = result.dimensions!.find((d) => d.name === 'Merge conflicts');
    expect(conflictDim!.passed).toBe(false);
  });

  it('preserves incomplete verdict when session killed with mergeable=true', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any);
    vi.mocked(getEventsBySession).mockReturnValue([]);

    const mockSM = makeMockSessionManager();
    const mockGH = makeMockGitHub();
    vi.mocked(mockGH.getMergeability).mockResolvedValue({ mergeable: true, mergeableState: 'clean' });

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

  it('does NOT call markPRReady when PR is not a draft', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(mockPRRow as any); // draft: 0

    const mockGH = makeMockGitHub();
    const service = new PRReviewService(mockGH, makeMockNotion(), makeMockSessionManager() as any, 'proj-1', 'https://notion.so/ctx');

    const result = await service.handleApprovedVerdict(42, 'owner/repo', 'task-abc123');

    expect(vi.mocked(mockGH.markPRReady)).not.toHaveBeenCalled();
    expect(vi.mocked(updatePRDraftStatus)).not.toHaveBeenCalled();
    expect(result).toBe(false);
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

// ── sendReReview() ────────────────────────────────────────────────────────────

describe('PRReviewService.sendReReview()', () => {
  it('sends follow-up message to review session and waits for next verdict', async () => {
    const claudePayload = {
      verdict: 'approved',
      dimensions: [
        { name: 'Diff vs Context spec', passed: true, notes: 'Fixed.' },
      ],
      summary: 'Issues addressed.',
    };

    const mockSM = makeMockSessionManager();
    const service = new PRReviewService(
      makeMockGitHub(),
      makeMockNotion(),
      mockSM as any,
      'proj-1',
      'https://notion.so/ctx',
    );

    const sendMock = mockSM.send as ReturnType<typeof vi.fn>;
    sendMock.mockImplementationOnce(() => {
      setImmediate(() =>
        mockSM.emit('message', makeSessionEventMessage('review-session-id', JSON.stringify(claudePayload))),
      );
    });

    const result = await service.sendReReview('review-session-id', 42, 'owner/repo', 2, 3);

    expect(sendMock).toHaveBeenCalledOnce();
    const [sessionId, msg] = sendMock.mock.calls[0];
    expect(sessionId).toBe('review-session-id');
    expect(msg).toContain('re-review');
    expect(msg).toContain('2/3');

    expect(result.verdict).toBe('approved');
    expect(vi.mocked(setPRReviewResult)).toHaveBeenCalledOnce();
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
