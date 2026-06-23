/**
 * Tests for hardened verdict parsing: near-miss recovery so genuinely-completed
 * reviews are not mislabeled incomplete.
 *
 * Acceptance criteria covered:
 * 1. A review_ready result with a verdict token present but dimensions missing
 *    parses to that verdict (not incomplete).
 * 2. A final tool-call-only message with an earlier text-block verdict is recovered.
 * 3. Repairable near-miss JSON (trailing comma / code-fence wrapper) is recovered.
 * 4. Genuinely-absent verdict still yields incomplete.
 * 5. An explicit request-changes/reject is never upgraded to approved.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () => ({
  getEventsBySession: vi.fn().mockReturnValue([]),
  setPRReviewResult: vi.fn(),
  getPRByNumber: vi.fn(),
  setReviewSessionId: vi.fn(),
  updatePRDraftStatus: vi.fn(),
  incrementReviewIteration: vi.fn(),
  setLastReviewedSha: vi.fn(),
  setLocalBranchReviewResult: vi.fn(),
  getLocalBranchById: vi.fn(),
  getSession: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    fetchTaskPage: vi.fn().mockResolvedValue(''),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  }),
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import { PRReviewService } from '../github/PRReviewService.js';
import type { SessionEvent } from '../db/types.js';
import type { GitHubClient } from '../github/GitHubClient.js';
import type { DiffSource } from '../github/DiffSource.js';
import type { TaskTrackerBackend } from '../tasks/TaskTrackerBackend.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeService() {
  const github = {
    fetchPR: vi.fn().mockResolvedValue({
      headSha: 'abc123',
      title: 'feat: test',
      body: 'body',
      id: 42,
    }),
    fetchDiff: vi.fn().mockResolvedValue(''),
    markPRReady: vi.fn().mockResolvedValue(undefined),
  } as unknown as GitHubClient;

  const taskBackend = {
    type: 'local',
    fetchTaskPage: vi.fn().mockResolvedValue(''),
    updateStatus: vi.fn(),
    fetchTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    fetchTaskTitle: vi.fn().mockResolvedValue(''),
  } as unknown as TaskTrackerBackend;

  const sessionManager = { on: vi.fn(), off: vi.fn(), emit: vi.fn() };

  return new PRReviewService(
    github,
    taskBackend,
    sessionManager as never,
    'proj-1',
    'https://notion.so/ctx',
  );
}

/** Build a stored assistant text event containing the given text. */
function assistantTextEvent(text: string): SessionEvent {
  return {
    id: 1,
    session_id: 'sess',
    event_type: 'text',
    payload: JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    }),
    created_at: '2024-01-01T00:00:00Z',
  } as unknown as SessionEvent;
}

/** Build a stored assistant event that contains only tool_use blocks (no text). */
function assistantToolCallOnlyEvent(): SessionEvent {
  return {
    id: 2,
    session_id: 'sess',
    event_type: 'text',
    payload: JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu1', name: 'read_file', input: {} },
        ],
      },
    }),
    created_at: '2024-01-01T00:00:01Z',
  } as unknown as SessionEvent;
}

/** Build a stored system event simulating a successful result with status_category. */
function resultEvent(statusCategory: string): SessionEvent {
  return {
    id: 3,
    session_id: 'sess',
    event_type: 'system',
    payload: JSON.stringify({
      type: 'result',
      subtype: 'success',
      status_category: statusCategory,
    }),
    created_at: '2024-01-01T00:00:02Z',
  } as unknown as SessionEvent;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// AC1 — review_ready result with verdict present but dimensions missing
describe('AC1: review_ready result + verdict token present but dimensions missing', () => {
  it('parses to that verdict rather than incomplete', () => {
    const service = makeService();
    const events = [
      assistantTextEvent(
        JSON.stringify({ verdict: 'approved', summary: 'Looks good.' }),
      ),
      resultEvent('review_ready'),
    ];
    const result = service.parseReviewResult(events, 42, 'owner/repo');
    expect(result.verdict).toBe('approved');
    expect(result.summary).toBe('Looks good.');
  });

  it('needs_changes near-miss with dimensions missing still parses correctly', () => {
    const service = makeService();
    const events = [
      assistantTextEvent(
        JSON.stringify({
          verdict: 'needs_changes',
          summary: 'Some issues found.',
        }),
      ),
      resultEvent('review_ready'),
    ];
    const result = service.parseReviewResult(events, 42, 'owner/repo');
    expect(result.verdict).toBe('needs_changes');
    expect(result.summary).toBe('Some issues found.');
  });

  it('verdict absent in events still yields incomplete even with review_ready signal', () => {
    const service = makeService();
    const events = [resultEvent('review_ready')];
    const result = service.parseReviewResult(events, 42, 'owner/repo');
    expect(result.verdict).toBe('incomplete');
  });
});

// AC2 — final tool-call-only message, earlier text-block verdict recovered
describe('AC2: tool-call-only final message — recover verdict from earlier event', () => {
  it('recovers an approved verdict from an earlier text event', () => {
    const service = makeService();
    const verdictJson = JSON.stringify({
      verdict: 'approved',
      dimensions: [{ name: 'Diff vs Context spec', passed: true, notes: '' }],
      summary: 'All good.',
    });
    const events = [
      assistantTextEvent(verdictJson),
      assistantToolCallOnlyEvent(), // last message — no text blocks
    ];
    const result = service.parseReviewResult(events, 42, 'owner/repo');
    expect(result.verdict).toBe('approved');
    expect(result.summary).toBe('All good.');
  });

  it('recovers a needs_changes verdict from an earlier text event', () => {
    const service = makeService();
    const verdictJson = JSON.stringify({
      verdict: 'needs_changes',
      dimensions: [{ name: 'Diff vs Context spec', passed: false, notes: 'x' }],
      summary: 'Needs work.',
    });
    const events = [
      assistantTextEvent(verdictJson),
      assistantToolCallOnlyEvent(),
    ];
    const result = service.parseReviewResult(events, 42, 'owner/repo');
    expect(result.verdict).toBe('needs_changes');
  });

  it('yields incomplete when all messages have no verdict text', () => {
    const service = makeService();
    const events = [
      assistantTextEvent('Reading the diff...'),
      assistantToolCallOnlyEvent(),
    ];
    const result = service.parseReviewResult(events, 42, 'owner/repo');
    expect(result.verdict).toBe('incomplete');
  });
});

// AC3 — repairable near-miss JSON
describe('AC3: repairable near-miss JSON', () => {
  it('recovers from trailing comma before closing brace', () => {
    const service = makeService();
    // Trailing comma after last property
    const trailingCommaJson =
      '{"verdict": "approved", "dimensions": [], "summary": "done",}';
    const events = [assistantTextEvent(trailingCommaJson)];
    const result = service.parseReviewResult(events, 42, 'owner/repo');
    expect(result.verdict).toBe('approved');
    expect(result.summary).toBe('done');
  });

  it('recovers from trailing comma inside nested array', () => {
    const service = makeService();
    const json =
      '{"verdict":"needs_changes","dimensions":[{"name":"x","passed":false,"notes":"y"},],"summary":"issues"}';
    const events = [assistantTextEvent(json)];
    const result = service.parseReviewResult(events, 42, 'owner/repo');
    expect(result.verdict).toBe('needs_changes');
  });

  it('recovers from json wrapped in ```json code fence', () => {
    const service = makeService();
    const fenced = `\`\`\`json\n{"verdict":"approved","dimensions":[],"summary":"ok"}\n\`\`\``;
    const events = [assistantTextEvent(fenced)];
    const result = service.parseReviewResult(events, 42, 'owner/repo');
    expect(result.verdict).toBe('approved');
  });

  it('recovers from json wrapped in plain ``` code fence', () => {
    const service = makeService();
    const fenced = `\`\`\`\n{"verdict":"needs_changes","dimensions":[],"summary":"nope"}\n\`\`\``;
    const events = [assistantTextEvent(fenced)];
    const result = service.parseReviewResult(events, 42, 'owner/repo');
    expect(result.verdict).toBe('needs_changes');
  });
});

// AC4 — genuinely absent verdict still yields incomplete
describe('AC4: genuinely absent verdict yields incomplete', () => {
  it('returns incomplete when no assistant events exist', () => {
    const service = makeService();
    const result = service.parseReviewResult([], 42, 'owner/repo');
    expect(result.verdict).toBe('incomplete');
  });

  it('returns incomplete when assistant text is plain prose with no JSON', () => {
    const service = makeService();
    const events = [assistantTextEvent('This PR looks mostly fine overall.')];
    const result = service.parseReviewResult(events, 42, 'owner/repo');
    expect(result.verdict).toBe('incomplete');
  });

  it('returns incomplete when JSON has no verdict key', () => {
    const service = makeService();
    const events = [
      assistantTextEvent(
        JSON.stringify({ result: 'success', status: 'review_ready' }),
      ),
    ];
    const result = service.parseReviewResult(events, 42, 'owner/repo');
    expect(result.verdict).toBe('incomplete');
  });
});

// AC5 — explicit needs_changes/reject never upgraded to approved
describe('AC5: explicit needs_changes never upgraded to approved', () => {
  it('needs_changes with no dimensions stays needs_changes after size-dim append', () => {
    const service = makeService();
    // Near-miss: verdict present but dimensions absent
    const events = [
      assistantTextEvent(
        JSON.stringify({
          verdict: 'needs_changes',
          summary: 'Several issues found.',
        }),
      ),
    ];
    const result = service.parseReviewResult(events, 42, 'owner/repo');
    // parseReviewResult result — size dim appended externally by reviewPR;
    // but we can verify parseReviewResult alone doesn't flip the verdict.
    expect(result.verdict).toBe('needs_changes');
    expect(result.verdict).not.toBe('approved');
  });

  it('needs_changes verdict from tool-call-only recovery stays needs_changes', () => {
    const service = makeService();
    const events = [
      assistantTextEvent(
        JSON.stringify({ verdict: 'needs_changes', summary: 'Issues.' }),
      ),
      assistantToolCallOnlyEvent(),
    ];
    const result = service.parseReviewResult(events, 42, 'owner/repo');
    expect(result.verdict).toBe('needs_changes');
    expect(result.verdict).not.toBe('approved');
  });
});
