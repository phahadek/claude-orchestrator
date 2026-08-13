/**
 * Focused coverage for DepthReviewService's session-conclusion path
 * (watchForSessionEnd). A depth-review session never opens a PR, so
 * session_ended — the signal the old implementation bound to — never
 * fires for it; the session must instead conclude off the turn-boundary
 * 'result' session_event, mirroring PlanningOrchestrator's identical
 * distinction for planning sessions. See DepthReviewService.ts's
 * watchForSessionEnd docstring for the full rationale.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../db/queries', () => ({
  getEventsBySession: vi.fn().mockReturnValue([]),
  markSessionDone: vi.fn(),
  getSession: vi.fn(),
  TERMINAL_SESSION_STATUSES: new Set(['done', 'error', 'killed']),
}));
vi.mock('../GitHubClient', () => ({
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
vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    fetchTaskPage: vi.fn().mockResolvedValue('## Files\n- src/foo.ts\n'),
  }),
}));
vi.mock('../../notion/NotionClient', () => ({
  parseSection: vi.fn().mockReturnValue(''),
  parseExpectedSize: vi.fn().mockReturnValue(undefined),
}));

import { DepthReviewService } from '../DepthReviewService';
import { markSessionDone, getSession } from '../../db/queries';
import type { SessionManager } from '../../session/SessionManager';
import type { DiffSource } from '../DiffSource';

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

const fourPassedDims = [
  { name: 'Security', passed: true, notes: 'ok' },
  { name: 'Concurrency', passed: true, notes: 'ok' },
  { name: 'Reliability / crash', passed: true, notes: 'ok' },
  { name: 'Data integrity & parsing correctness', passed: true, notes: 'ok' },
  { name: 'Size proportionality', passed: true, notes: 'ok' },
];

function makeVerdictTextMessage(sessionId: string, payload: unknown) {
  return {
    type: 'session_event' as const,
    sessionId,
    eventType: 'text' as const,
    content: JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      },
    }),
  };
}

function makeResultMessage(sessionId: string) {
  return {
    type: 'session_event' as const,
    sessionId,
    eventType: 'result' as const,
    content: '',
  };
}

const passingVerdict = {
  verdict: 'pass',
  dimensions: fourPassedDims,
  summary: 'Nothing found.',
};

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DepthReviewService — turn-boundary conclusion', () => {
  it('reaches done off the result event even though the session parks alive (no session_ended)', async () => {
    const sm = makeMockSessionManager();
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 'running',
    });
    (sm.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_a: string, _b: string, opts: { sessionId: string }) => {
        setImmediate(() => {
          sm.emit(
            'message',
            makeVerdictTextMessage(opts.sessionId, passingVerdict),
          );
          sm.emit('message', makeResultMessage(opts.sessionId));
          // No session_ended — the session parks alive, exactly like the
          // deployed bug's 49-idle census.
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
    await flush();

    expect(result).not.toBeNull();
    const usedSessionId = (sm.start as ReturnType<typeof vi.fn>).mock
      .calls[0][2].sessionId;
    // skipInFlightGuard is required here: the row still reads 'running' at
    // the turn boundary, and without the override markSessionDone would
    // just defer onto pending_done_* again rather than writing 'done'.
    expect(markSessionDone).toHaveBeenCalledWith(
      usedSessionId,
      expect.any(Number),
      null,
      'depth_review_service',
      { skipInFlightGuard: true },
    );
  });

  it('reaps the subprocess after terminalizing', async () => {
    const sm = makeMockSessionManager();
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 'running',
    });
    (sm.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_a: string, _b: string, opts: { sessionId: string }) => {
        setImmediate(() => {
          sm.emit(
            'message',
            makeVerdictTextMessage(opts.sessionId, passingVerdict),
          );
          sm.emit('message', makeResultMessage(opts.sessionId));
        });
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
    await flush();

    const usedSessionId = (sm.start as ReturnType<typeof vi.fn>).mock
      .calls[0][2].sessionId;
    expect(sm.endSession).toHaveBeenCalledWith(usedSessionId);
  });

  it('does not stomp a session already terminal (error) but still reaps it', async () => {
    const sm = makeMockSessionManager();
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 'error',
    });
    (sm.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_a: string, _b: string, opts: { sessionId: string }) => {
        setImmediate(() => {
          sm.emit(
            'message',
            makeVerdictTextMessage(opts.sessionId, passingVerdict),
          );
          sm.emit('message', makeResultMessage(opts.sessionId));
        });
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
    await flush();

    expect(markSessionDone).not.toHaveBeenCalled();
    expect(sm.endSession).toHaveBeenCalled();
  });

  it('removes the registered listener once terminalized off the result event (no leak)', async () => {
    const sm = makeMockSessionManager();
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 'running',
    });
    const baseline = sm.listenerCount('message');
    (sm.start as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_a: string, _b: string, opts: { sessionId: string }) => {
        setImmediate(() => {
          sm.emit(
            'message',
            makeVerdictTextMessage(opts.sessionId, passingVerdict),
          );
          sm.emit('message', makeResultMessage(opts.sessionId));
        });
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
    await flush();

    expect(sm.listenerCount('message')).toBe(baseline);
  });

  it('removes the registered listener on timeout even with no result/session_ended ever arriving', async () => {
    const sm = makeMockSessionManager();
    const baseline = sm.listenerCount('message');
    // start() never emits anything — forces both waitForVerdict's and
    // watchForSessionEnd's own timeout branches via the short timeoutMs.
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
    // waitForVerdict's own timeout (registered first) resolves runDepthReview
    // before watchForSessionEnd's identical-duration timeout fires — wait
    // out that second timer explicitly rather than racing it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sm.listenerCount('message')).toBe(baseline);
  });

  it('still concludes the session on the fail-open/timeout path even without a terminal-row precondition', async () => {
    const sm = makeMockSessionManager();
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 'running',
    });
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
    // See the comment in the previous test — same two-timer race.
    await new Promise((resolve) => setTimeout(resolve, 50));
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
});
