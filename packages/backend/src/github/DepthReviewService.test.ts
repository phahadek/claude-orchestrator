import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Module mocks (must come before imports of the module under test) ────────

vi.mock('../db/queries', () => ({
  getEventsBySession: vi.fn().mockReturnValue([]),
  markSessionDone: vi.fn(),
  getSession: vi.fn(),
  TERMINAL_SESSION_STATUSES: new Set(['done', 'error', 'killed']),
}));
vi.mock('./GitHubClient', () => ({
  computeSizeSignal: vi.fn().mockReturnValue({
    linesAdded: 1,
    linesDeleted: 0,
    filesTouched: 1,
    specFileCount: 1,
    oversizeRatio: 1,
    exceededAbsoluteFloor: false,
  }),
  isOversized: vi.fn().mockReturnValue(false),
  SIZE_ABSOLUTE_FLOOR: 800,
  SIZE_FILE_RATIO_LIMIT: 3,
}));
vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    fetchTaskPage: vi.fn().mockResolvedValue('## Files\n- src/foo.ts\n'),
  }),
}));
vi.mock('../notion/NotionClient', () => ({
  parseSection: vi.fn().mockReturnValue(''),
  parseExpectedSize: vi.fn().mockReturnValue(undefined),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { DepthReviewService } from './DepthReviewService';
import { markSessionDone, getSession } from '../db/queries';
import type { SessionManager } from '../session/SessionManager';
import type { DiffSource } from './DiffSource';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockSessionManager() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    start: vi.fn().mockResolvedValue('depth-session-id'),
    endSession: vi.fn(),
  });
}

function makeMockDiffSource(diff: string = 'diff --git a/x b/x'): DiffSource {
  return { fetchDiff: vi.fn().mockResolvedValue(diff) };
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

const fourPassedDims = [
  { name: 'Security', passed: true, notes: 'ok' },
  { name: 'Concurrency', passed: true, notes: 'ok' },
  { name: 'Reliability / crash', passed: true, notes: 'ok' },
  { name: 'Data integrity & parsing correctness', passed: true, notes: 'ok' },
  { name: 'Size proportionality', passed: true, notes: 'ok' },
];

/** Wires a SessionManager mock so start() emits `payload` as the depth-review verdict. */
function wireVerdict(
  sm: ReturnType<typeof makeMockSessionManager>,
  payload: unknown,
) {
  (sm.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
    (_a: string, _b: string, opts: { sessionId: string }) => {
      setImmediate(() =>
        sm.emit(
          'message',
          makeSessionEventMessage(opts.sessionId, JSON.stringify(payload)),
        ),
      );
      return Promise.resolve(opts.sessionId);
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── runDepthReview() — dimension classification ──────────────────────────────

describe('DepthReviewService.runDepthReview() — dimension classification', () => {
  it('returns hasNonSizeFailure:false and sizeOnlyFailure:false when every dimension passes', async () => {
    const sm = makeMockSessionManager();
    wireVerdict(sm, {
      verdict: 'pass',
      dimensions: fourPassedDims,
      summary: 'Nothing found.',
    });

    const service = new DepthReviewService(
      sm as unknown as SessionManager,
      undefined,
    );
    const result = await service.runDepthReview(
      1,
      'owner/repo',
      makeMockDiffSource(),
      'proj-1',
      'https://notion.so/ctx',
      'notion:task-abc',
    );

    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('pass');
    expect(result!.hasNonSizeFailure).toBe(false);
    expect(result!.sizeOnlyFailure).toBe(false);
  });

  it('sets hasNonSizeFailure:true when the Security dimension fails', async () => {
    const sm = makeMockSessionManager();
    wireVerdict(sm, {
      verdict: 'fail',
      dimensions: [
        {
          name: 'Security',
          passed: false,
          notes: 'Unsanitized input reaches a shell command.',
        },
        ...fourPassedDims.slice(1),
      ],
      summary: 'Found a security defect.',
    });

    const service = new DepthReviewService(
      sm as unknown as SessionManager,
      undefined,
    );
    const result = await service.runDepthReview(
      1,
      'owner/repo',
      makeMockDiffSource(),
      'proj-1',
      'https://notion.so/ctx',
      'notion:task-abc',
    );

    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('fail');
    expect(result!.hasNonSizeFailure).toBe(true);
    expect(result!.sizeOnlyFailure).toBe(false);
  });

  it('sets hasNonSizeFailure:true when the Concurrency dimension fails', async () => {
    const sm = makeMockSessionManager();
    wireVerdict(sm, {
      verdict: 'fail',
      dimensions: [
        fourPassedDims[0],
        {
          name: 'Concurrency',
          passed: false,
          notes: 'Unsynchronized shared state.',
        },
        ...fourPassedDims.slice(2),
      ],
      summary: 'Found a race.',
    });

    const service = new DepthReviewService(
      sm as unknown as SessionManager,
      undefined,
    );
    const result = await service.runDepthReview(
      1,
      'owner/repo',
      makeMockDiffSource(),
      'proj-1',
      'https://notion.so/ctx',
      null,
    );

    expect(result!.hasNonSizeFailure).toBe(true);
    expect(result!.sizeOnlyFailure).toBe(false);
  });

  it('sets sizeOnlyFailure:true when only Size proportionality fails', async () => {
    const sm = makeMockSessionManager();
    wireVerdict(sm, {
      verdict: 'fail',
      dimensions: [
        ...fourPassedDims.slice(0, 4),
        {
          name: 'Size proportionality',
          passed: false,
          notes: 'Diff is far larger than the task scope demands.',
        },
      ],
      summary: 'Scope creep detected.',
    });

    const service = new DepthReviewService(
      sm as unknown as SessionManager,
      undefined,
    );
    const result = await service.runDepthReview(
      1,
      'owner/repo',
      makeMockDiffSource(),
      'proj-1',
      'https://notion.so/ctx',
      'notion:task-abc',
    );

    expect(result).not.toBeNull();
    expect(result!.hasNonSizeFailure).toBe(false);
    expect(result!.sizeOnlyFailure).toBe(true);
  });

  it('prefers hasNonSizeFailure over sizeOnlyFailure when both a non-size and the size dimension fail', async () => {
    const sm = makeMockSessionManager();
    wireVerdict(sm, {
      verdict: 'fail',
      dimensions: [
        { name: 'Security', passed: false, notes: 'Unsafe input.' },
        ...fourPassedDims.slice(1, 4),
        {
          name: 'Size proportionality',
          passed: false,
          notes: 'Also oversized.',
        },
      ],
      summary: 'Multiple findings.',
    });

    const service = new DepthReviewService(
      sm as unknown as SessionManager,
      undefined,
    );
    const result = await service.runDepthReview(
      1,
      'owner/repo',
      makeMockDiffSource(),
      'proj-1',
      'https://notion.so/ctx',
      'notion:task-abc',
    );

    expect(result!.hasNonSizeFailure).toBe(true);
    expect(result!.sizeOnlyFailure).toBe(false);
  });
});

// ── runDepthReview() — fails open ────────────────────────────────────────────

describe('DepthReviewService.runDepthReview() — fails open', () => {
  it('resolves null when diff fetch throws, instead of propagating the error', async () => {
    const sm = makeMockSessionManager();
    const throwingDiffSource: DiffSource = {
      fetchDiff: vi.fn().mockRejectedValue(new Error('GitHub outage')),
    };

    const service = new DepthReviewService(
      sm as unknown as SessionManager,
      undefined,
    );
    const result = await service.runDepthReview(
      1,
      'owner/repo',
      throwingDiffSource,
      'proj-1',
      'https://notion.so/ctx',
      'notion:task-abc',
    );

    expect(result).toBeNull();
    expect(sm.start).not.toHaveBeenCalled();
  });

  it('resolves null when the session ends without ever producing a parseable verdict', async () => {
    const sm = makeMockSessionManager();
    (sm.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_a: string, _b: string, opts: { sessionId: string }) => {
        setImmediate(() =>
          sm.emit('message', {
            type: 'session_ended',
            sessionId: opts.sessionId,
          }),
        );
        return Promise.resolve(opts.sessionId);
      },
    );

    const service = new DepthReviewService(
      sm as unknown as SessionManager,
      undefined,
    );
    const result = await service.runDepthReview(
      1,
      'owner/repo',
      makeMockDiffSource(),
      'proj-1',
      'https://notion.so/ctx',
      'notion:task-abc',
    );

    expect(result).toBeNull();
  });

  it('resolves null on timeout without ever throwing', async () => {
    const sm = makeMockSessionManager();
    // start() never emits a verdict message — the short timeoutMs below
    // forces waitForVerdict's timeout branch instead of hanging the test.
    (sm.start as ReturnType<typeof vi.fn>).mockResolvedValue(
      'depth-session-id',
    );

    const service = new DepthReviewService(
      sm as unknown as SessionManager,
      undefined,
      25,
    );
    const result = await service.runDepthReview(
      1,
      'owner/repo',
      makeMockDiffSource(),
      'proj-1',
      'https://notion.so/ctx',
      'notion:task-abc',
    );

    expect(result).toBeNull();
  });

  it('resolves null when session.start() itself throws', async () => {
    const sm = makeMockSessionManager();
    (sm.start as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('spawn failed'),
    );

    const service = new DepthReviewService(
      sm as unknown as SessionManager,
      undefined,
    );
    const result = await service.runDepthReview(
      1,
      'owner/repo',
      makeMockDiffSource(),
      'proj-1',
      'https://notion.so/ctx',
      'notion:task-abc',
    );

    expect(result).toBeNull();
  });
});

// ── runDepthReview() — session dispatch ──────────────────────────────────────

describe('DepthReviewService.runDepthReview() — session dispatch', () => {
  it('starts a depth_review session carrying the PR number, project, and task id', async () => {
    const sm = makeMockSessionManager();
    wireVerdict(sm, {
      verdict: 'pass',
      dimensions: fourPassedDims,
      summary: 'Nothing found.',
    });

    const service = new DepthReviewService(
      sm as unknown as SessionManager,
      undefined,
    );
    await service.runDepthReview(
      7,
      'owner/repo',
      makeMockDiffSource(),
      'proj-1',
      'https://notion.so/ctx',
      'notion:task-abc',
    );

    expect(sm.start).toHaveBeenCalledOnce();
    const [, , opts] = (sm.start as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.sessionType).toBe('depth_review');
    expect(opts.taskId).toBe('notion:task-abc');
    expect(opts.taskName).toContain('7');
    expect(opts.customPrompt).toContain('PR #7');
  });
});

// ── runDepthReview() — session conclusion ────────────────────────────────────

describe('DepthReviewService.runDepthReview() — session conclusion', () => {
  it('marks the session done once it actually exits cleanly (session_ended status idle), after its verdict text was already parsed', async () => {
    const sm = makeMockSessionManager();
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 'idle',
    });
    (sm.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_a: string, _b: string, opts: { sessionId: string }) => {
        setImmediate(() => {
          sm.emit(
            'message',
            makeSessionEventMessage(
              opts.sessionId,
              JSON.stringify({
                verdict: 'pass',
                dimensions: fourPassedDims,
                summary: 'Nothing found.',
              }),
            ),
          );
          // The process exits (session_ended) only after the verdict text
          // was already emitted and parsed — waitForVerdict's own listener
          // has unsubscribed by this point.
          sm.emit('message', {
            type: 'session_ended',
            sessionId: opts.sessionId,
            status: 'idle',
          });
        });
        return Promise.resolve(opts.sessionId);
      },
    );

    const service = new DepthReviewService(
      sm as unknown as SessionManager,
      undefined,
    );
    const result = await service.runDepthReview(
      1,
      'owner/repo',
      makeMockDiffSource(),
      'proj-1',
      'https://notion.so/ctx',
      'notion:task-abc',
    );

    expect(result).not.toBeNull();
    // Flush the microtask/macrotask the second emit is queued on.
    await new Promise((resolve) => setImmediate(resolve));
    const usedSessionId = (sm.start as ReturnType<typeof vi.fn>).mock
      .calls[0][2].sessionId;
    expect(markSessionDone).toHaveBeenCalledWith(
      usedSessionId,
      expect.any(Number),
      null,
      'depth_review_service',
      { skipInFlightGuard: true },
    );
    expect(sm.endSession).toHaveBeenCalledWith(usedSessionId);
  });

  it('does not mark the session done merely from a parsed verdict text event, before the session has actually exited', async () => {
    const sm = makeMockSessionManager();
    wireVerdict(sm, {
      verdict: 'pass',
      dimensions: fourPassedDims,
      summary: 'Nothing found.',
    });

    const service = new DepthReviewService(
      sm as unknown as SessionManager,
      undefined,
    );
    await service.runDepthReview(
      1,
      'owner/repo',
      makeMockDiffSource(),
      'proj-1',
      'https://notion.so/ctx',
      'notion:task-abc',
    );

    expect(markSessionDone).not.toHaveBeenCalled();
  });

  it('does not mark the session done when it is destroyed mid-work (row already terminal at killed, not idle)', async () => {
    const sm = makeMockSessionManager();
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 'killed',
    });
    (sm.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_a: string, _b: string, opts: { sessionId: string }) => {
        setImmediate(() =>
          sm.emit('message', {
            type: 'session_ended',
            sessionId: opts.sessionId,
            status: 'killed',
          }),
        );
        return Promise.resolve(opts.sessionId);
      },
    );

    const service = new DepthReviewService(
      sm as unknown as SessionManager,
      undefined,
    );
    await service.runDepthReview(
      1,
      'owner/repo',
      makeMockDiffSource(),
      'proj-1',
      'https://notion.so/ctx',
      'notion:task-abc',
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(markSessionDone).not.toHaveBeenCalled();
    // Still reaped — a terminal-status writer that ran first (e.g. the
    // session was destroyed) may not have reaped the subprocess either.
    expect(sm.endSession).toHaveBeenCalled();
  });
});
