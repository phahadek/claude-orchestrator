import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks (must come before imports of the modules under test) ──────────────

vi.mock('../db/queries.js', () => ({
  getPRByNumber: vi.fn(),
  setPRReviewResult: vi.fn(),
  getEventsBySession: vi.fn(),
  setReviewSessionId: vi.fn(),
}));

import { PRReviewService } from './PRReviewService';
import { getPRByNumber, setPRReviewResult, getEventsBySession, setReviewSessionId } from '../db/queries';
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
  } as unknown as GitHubClient;
}

function makeMockNotion(): NotionClient {
  return {
    fetchTaskPage: vi.fn().mockResolvedValue(mockTask),
    fetchReadyTasks: vi.fn(),
    updateStatus: vi.fn(),
    attachPR: vi.fn(),
  } as unknown as NotionClient;
}

function makeMockSessionManager() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    start: vi.fn().mockReturnValue('review-session-id'),
    send: vi.fn(),
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
    startMock.mockImplementationOnce(() => {
      const id = 'review-session-id';
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

    expect(result.verdict).toBe('approved');
    expect(vi.mocked(setPRReviewResult)).toHaveBeenCalledOnce();
    expect(vi.mocked(setReviewSessionId)).toHaveBeenCalledWith(42, 'owner/repo', 'review-session-id');
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
    startMock.mockImplementationOnce(() => {
      const id = 'review-session-id';
      setImmediate(() =>
        mockSM.emit('message', { type: 'session_ended', sessionId: id, status: 'done' }),
      );
      return id;
    });

    const result = await service.reviewPR(42, 'owner/repo');

    expect(result.verdict).toBe('needs_changes');
    expect(vi.mocked(getEventsBySession)).toHaveBeenCalledWith('review-session-id');
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
