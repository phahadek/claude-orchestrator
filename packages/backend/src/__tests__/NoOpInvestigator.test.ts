import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../db/queries', () => ({
  getEventsBySession: vi.fn(() => []),
  getTaskNoOpAttempts: vi.fn(() => undefined),
  bumpTaskNoOpAttempts: vi.fn(),
}));

import {
  NoOpInvestigator,
  tryParseNoOpVerdict,
  type INoOpSessionManager,
  type NoOpInvestigatorContext,
} from '../github/NoOpInvestigator';
import {
  getEventsBySession,
  getTaskNoOpAttempts,
  bumpTaskNoOpAttempts,
} from '../db/queries';
import type { TaskBackend } from '../tasks/TaskBackend';
import type { GitHubClient } from '../github/GithubClient';
import type { ResolvedTask } from '../tasks/types';
import type { NonMilestoneSourceConfig } from '../tasks/TaskBackend';

// ── Helpers ─────────────────────────────────────────────────────────────────

function fakeSessionManager(): INoOpSessionManager & EventEmitter {
  const em = new EventEmitter() as INoOpSessionManager & EventEmitter;
  (em as unknown as Record<string, unknown>).start = vi.fn(() => 'session-id');
  return em;
}

function fakeTaskBackend(): TaskBackend {
  return {
    type: 'notion',
    fetchReadyTasks: vi.fn(async () => [] as ResolvedTask[]),
    attachPR: vi.fn(async () => {}),
    updateStatus: vi.fn(async () => {}),
    fetchTaskPage: vi.fn(async () => '# My Task\n\nTask markdown content'),
    fetchNonMilestoneReadyTasks: vi.fn(async () => [] as ResolvedTask[]),
    updateNotes: vi.fn(async () => {}),
    appendImplementationNote: vi.fn(async () => {}),
  } as unknown as TaskBackend;
}

function fakeGithubClient(): Partial<GitHubClient> {
  return {
    listMergedPRsSince: vi.fn(async () => []),
    listCommitsSince: vi.fn(async () => []),
    deleteBranch: vi.fn(async () => {}),
  };
}

function baseCtx(): NoOpInvestigatorContext {
  return {
    taskId: 'notion:abc123',
    taskUrl: 'https://notion.so/task',
    projectContextUrl: 'https://notion.so/ctx',
    projectId: 'proj-1',
    noOpSessionId: 'session-abc',
    baseBranch: 'dev',
    featureBranchName: 'feature/my-task',
    repo: 'owner/repo',
    taskCreatedAt: '2026-01-01T00:00:00Z',
  };
}

// ── tryParseNoOpVerdict ──────────────────────────────────────────────────────

describe('tryParseNoOpVerdict', () => {
  it('parses a resolved verdict', () => {
    const text =
      '{"kind":"resolved","resolvedByPrUrl":"https://github.com/owner/repo/pull/42","reason":"Already merged"}';
    const verdict = tryParseNoOpVerdict(text);
    expect(verdict).toEqual({
      kind: 'resolved',
      resolvedByPrUrl: 'https://github.com/owner/repo/pull/42',
      reason: 'Already merged',
    });
  });

  it('parses a retry verdict', () => {
    const verdict = tryParseNoOpVerdict(
      '{"kind":"retry","reason":"Session hit a transient error"}',
    );
    expect(verdict).toEqual({
      kind: 'retry',
      reason: 'Session hit a transient error',
    });
  });

  it('parses a human verdict', () => {
    const verdict = tryParseNoOpVerdict(
      '{"kind":"human","reason":"Needs human attention"}',
    );
    expect(verdict).toEqual({ kind: 'human', reason: 'Needs human attention' });
  });

  it('extracts verdict from mixed text', () => {
    const text =
      'Some analysis...\n{"kind":"retry","reason":"confusing"}\n...done';
    expect(tryParseNoOpVerdict(text)).toEqual({
      kind: 'retry',
      reason: 'confusing',
    });
  });

  it('returns null for invalid JSON', () => {
    expect(tryParseNoOpVerdict('not json')).toBeNull();
  });

  it('returns null for unknown kind', () => {
    expect(tryParseNoOpVerdict('{"kind":"unknown","reason":"x"}')).toBeNull();
  });

  it('returns null for resolved without resolvedByPrUrl', () => {
    expect(tryParseNoOpVerdict('{"kind":"resolved","reason":"x"}')).toBeNull();
  });
});

// ── NoOpInvestigator.investigate ─────────────────────────────────────────────

describe('NoOpInvestigator.investigate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns a review session with customPrompt containing task spec and no-op events', async () => {
    const sm = fakeSessionManager();
    const backend = fakeTaskBackend();
    const gh = fakeGithubClient();
    const investigator = new NoOpInvestigator(
      sm,
      backend,
      gh as unknown as GitHubClient,
    );

    // Simulate verdict via session_ended event
    vi.mocked(getEventsBySession)
      .mockReturnValueOnce([])
      .mockReturnValue([
        {
          id: 1,
          session_id: 'inv-session',
          event_type: 'text',
          payload: JSON.stringify({
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'text',
                  text: '{"kind":"resolved","resolvedByPrUrl":"https://github.com/owner/repo/pull/5","reason":"Already done"}',
                },
              ],
            },
          }),
          timestamp: Date.now(),
          message_id: null,
        },
      ]);

    const investigatePromise = investigator.investigate(baseCtx());

    // Let the event loop tick so the session is started and listener registered
    await new Promise((r) => setTimeout(r, 10));

    // Emit session_ended to trigger fallback verdict parsing from stored events
    const startFn = (sm as unknown as Record<string, unknown>)
      .start as ReturnType<typeof vi.fn>;
    const startCall = startFn.mock.calls[0];
    expect(startCall).toBeDefined();
    const sessionId = startCall[2].sessionId as string;
    expect(startCall[2].sessionType).toBe('review');
    expect(startCall[2].customPrompt).toContain('My Task'); // task title from markdown
    expect(startCall[2].customPrompt).toContain('no-op coding session');

    sm.emit('message', { type: 'session_ended', sessionId });

    await investigatePromise;

    expect(backend.updateStatus).toHaveBeenCalledWith(
      'notion:abc123',
      '✅ Done',
    );
    expect(backend.appendImplementationNote).toHaveBeenCalledWith(
      'notion:abc123',
      expect.stringContaining('Auto-resolved by investigator'),
    );
    expect(gh.deleteBranch).toHaveBeenCalledWith(
      'owner/repo',
      'feature/my-task',
    );
  });

  it('sets status to Ready on first retry verdict (retry_count === 0)', async () => {
    const sm = fakeSessionManager();
    const backend = fakeTaskBackend();
    const investigator = new NoOpInvestigator(sm, backend, undefined);

    vi.mocked(getTaskNoOpAttempts).mockReturnValue(undefined);
    vi.mocked(getEventsBySession).mockReturnValue([]);

    const investigatePromise = investigator.investigate(baseCtx());
    await new Promise((r) => setTimeout(r, 10));

    const startFn = (sm as unknown as Record<string, unknown>)
      .start as ReturnType<typeof vi.fn>;
    const sessionId = startFn.mock.calls[0][2].sessionId as string;

    // Emit verdict directly via session_event
    sm.emit('message', {
      type: 'session_event',
      sessionId,
      eventType: 'text',
      content: JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: '{"kind":"retry","reason":"Session was confused"}',
            },
          ],
        },
      }),
    });

    await investigatePromise;

    expect(bumpTaskNoOpAttempts).toHaveBeenCalledWith('notion:abc123');
    expect(backend.updateStatus).toHaveBeenCalledWith(
      'notion:abc123',
      '🗂️ Ready',
    );
  });

  it('sets status to Blocked when retry_count >= 1 (exhausted budget)', async () => {
    const sm = fakeSessionManager();
    const backend = fakeTaskBackend();
    const investigator = new NoOpInvestigator(sm, backend, undefined);

    vi.mocked(getTaskNoOpAttempts).mockReturnValue({
      task_id: 'notion:abc123',
      retry_count: 1,
      last_attempt_at: '2026-01-01T00:00:00Z',
    });
    vi.mocked(getEventsBySession).mockReturnValue([]);

    const investigatePromise = investigator.investigate(baseCtx());
    await new Promise((r) => setTimeout(r, 10));

    const startFn = (sm as unknown as Record<string, unknown>)
      .start as ReturnType<typeof vi.fn>;
    const sessionId = startFn.mock.calls[0][2].sessionId as string;

    sm.emit('message', {
      type: 'session_event',
      sessionId,
      eventType: 'text',
      content: JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: '{"kind":"retry","reason":"Again confused"}',
            },
          ],
        },
      }),
    });

    await investigatePromise;

    expect(bumpTaskNoOpAttempts).not.toHaveBeenCalled();
    expect(backend.updateStatus).toHaveBeenCalledWith(
      'notion:abc123',
      '🚫 Blocked',
    );
    expect(backend.updateNotes).toHaveBeenCalledWith(
      'notion:abc123',
      expect.stringContaining('Retry budget exhausted'),
    );
  });

  it('sets status to Blocked and writes Notes for human verdict', async () => {
    const sm = fakeSessionManager();
    const backend = fakeTaskBackend();
    const investigator = new NoOpInvestigator(sm, backend, undefined);

    vi.mocked(getEventsBySession).mockReturnValue([]);

    const investigatePromise = investigator.investigate(baseCtx());
    await new Promise((r) => setTimeout(r, 10));

    const startFn = (sm as unknown as Record<string, unknown>)
      .start as ReturnType<typeof vi.fn>;
    const sessionId = startFn.mock.calls[0][2].sessionId as string;

    sm.emit('message', {
      type: 'session_event',
      sessionId,
      eventType: 'text',
      content: JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: '{"kind":"human","reason":"Needs human review"}',
            },
          ],
        },
      }),
    });

    await investigatePromise;

    expect(backend.updateStatus).toHaveBeenCalledWith(
      'notion:abc123',
      '🚫 Blocked',
    );
    expect(backend.updateNotes).toHaveBeenCalledWith(
      'notion:abc123',
      'Needs human review',
    );
  });

  it('does not mutate task status when investigator session fails to start', async () => {
    const sm = fakeSessionManager();
    const backend = fakeTaskBackend();
    const investigator = new NoOpInvestigator(sm, backend, undefined);

    const startFn = (sm as unknown as Record<string, unknown>)
      .start as ReturnType<typeof vi.fn>;
    startFn.mockImplementation(() => {
      throw new Error('session start failed');
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await investigator.investigate(baseCtx());

    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(/sessionManager\.start failed.*notion:abc123/),
    );

    consoleSpy.mockRestore();
  });

  it('does not mutate task status when session_ended fires with no parseable verdict', async () => {
    const sm = fakeSessionManager();
    const backend = fakeTaskBackend();
    const investigator = new NoOpInvestigator(sm, backend, undefined);

    // getEventsBySession returns no events with a parseable verdict
    vi.mocked(getEventsBySession).mockReturnValue([]);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const investigatePromise = investigator.investigate(baseCtx());
    await new Promise((r) => setTimeout(r, 10));

    const startFn = (sm as unknown as Record<string, unknown>).start as ReturnType<typeof vi.fn>;
    const sessionId = startFn.mock.calls[0][2].sessionId as string;

    // Emit session_ended without any verdict events — simulates crash or malformed output
    sm.emit('message', { type: 'session_ended', sessionId });

    await investigatePromise;

    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(/no parseable verdict.*notion:abc123/),
    );

    consoleSpy.mockRestore();
  });
});
