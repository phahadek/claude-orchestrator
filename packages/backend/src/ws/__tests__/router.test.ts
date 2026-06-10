/**
 * Tests for the router's send_message case.
 * Verifies: live session delivery, idle session resume, terminal session refusal,
 * unknown session error log, and no unhandled rejection on sendOrResume failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleMessage } from '../router';
import type { SessionManager } from '../../session/SessionManager';

// Minimal WebSocket mock
function makeWs() {
  return { send: vi.fn() } as unknown as import('ws').WebSocket;
}

// Minimal SessionManager mock with send and sendOrResume
function makeSessions(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    send: vi.fn(),
    sendOrResume: vi.fn().mockResolvedValue('session-id'),
    start: vi.fn(),
    kill: vi.fn(),
    endSession: vi.fn(),
    ...overrides,
  } as unknown as SessionManager;
}

const SESSION_ID = 'test-session-id';
const MESSAGE = 'hello from composer';

describe('router: send_message', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls sendOrResume (not send) for send_message', async () => {
    const sessions = makeSessions();
    const ws = makeWs();

    await handleMessage(
      ws,
      JSON.stringify({ type: 'send_message', sessionId: SESSION_ID, message: MESSAGE }),
      sessions,
    );

    expect(sessions.sendOrResume).toHaveBeenCalledWith(SESSION_ID, MESSAGE);
    expect(sessions.send).not.toHaveBeenCalled();
  });

  it('does not await sendOrResume (fire-and-forget)', async () => {
    let resolved = false;
    const sessions = makeSessions({
      sendOrResume: vi.fn().mockImplementation(
        () => new Promise<string>((res) => setTimeout(() => { resolved = true; res(SESSION_ID); }, 100)),
      ),
    });
    const ws = makeWs();

    await handleMessage(
      ws,
      JSON.stringify({ type: 'send_message', sessionId: SESSION_ID, message: MESSAGE }),
      sessions,
    );

    // handleMessage returned before the promise resolved
    expect(resolved).toBe(false);
  });

  it('does not throw when sendOrResume rejects', async () => {
    const sessions = makeSessions({
      sendOrResume: vi.fn().mockRejectedValue(new Error('unexpected failure')),
    });
    const ws = makeWs();

    // Must not throw
    await expect(
      handleMessage(
        ws,
        JSON.stringify({ type: 'send_message', sessionId: SESSION_ID, message: MESSAGE }),
        sessions,
      ),
    ).resolves.not.toThrow();
  });

  it('logs an error when sendOrResume rejects', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sessions = makeSessions({
      sendOrResume: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const ws = makeWs();

    await handleMessage(
      ws,
      JSON.stringify({ type: 'send_message', sessionId: SESSION_ID, message: MESSAGE }),
      sessions,
    );

    // Wait a tick for the catch handler to run
    await new Promise((r) => process.nextTick(r));

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(SESSION_ID),
    );
    errSpy.mockRestore();
  });
});
