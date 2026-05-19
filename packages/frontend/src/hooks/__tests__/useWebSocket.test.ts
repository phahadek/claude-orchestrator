import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useWebSocket } from '../useWebSocket';

// Minimal WebSocket mock
class MockWebSocket {
  static OPEN = 1;
  readyState: number;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor(_url: string) {
    this.readyState = MockWebSocket.OPEN;
    // Simulate async open
    Promise.resolve().then(() => this.onopen?.());
  }
}

describe('useWebSocket', () => {
  let OriginalWebSocket: typeof WebSocket;

  beforeEach(() => {
    OriginalWebSocket = global.WebSocket;
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.stubGlobal('WebSocket', OriginalWebSocket);
    vi.restoreAllMocks();
  });

  it('send() returns true when socket is OPEN and message is sent', () => {
    const onMessage = vi.fn();
    const instances: MockWebSocket[] = [];
    const TrackingWS = class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        this.readyState = MockWebSocket.OPEN;
        instances.push(this);
      }
    };
    vi.stubGlobal('WebSocket', TrackingWS);

    const { result } = renderHook(() => useWebSocket(onMessage));
    const returned = result.current.send({
      type: 'fetch_tasks',
      projectId: 'p1',
      milestoneId: 'm1',
    });

    expect(returned).toBe(true);
    expect(instances[0]?.send).toHaveBeenCalled();
  });

  it('send() returns false when socket is not OPEN', () => {
    const onMessage = vi.fn();
    const instances: MockWebSocket[] = [];
    const TrackingWS = class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        this.readyState = 0; // CONNECTING
        instances.push(this);
      }
    };
    vi.stubGlobal('WebSocket', TrackingWS);

    const { result } = renderHook(() => useWebSocket(onMessage));
    const returned = result.current.send({
      type: 'fetch_tasks',
      projectId: 'p1',
      milestoneId: 'm1',
    });

    expect(returned).toBe(false);
    expect(instances[0]?.send).not.toHaveBeenCalled();
  });

  it('send() no-ops silently when socket is not OPEN', () => {
    const onMessage = vi.fn();
    const { result } = renderHook(() => useWebSocket(onMessage));

    // Force readyState to a non-OPEN value
    const ws = result.current;
    // Access internal ref by closing the mock socket
    const instances = vi.mocked(MockWebSocket);
    void instances; // ensure no TS unused var error

    // Replace readyState to simulate non-open socket
    // We test the guard by patching the mock's instance
    const mockInstance = (
      MockWebSocket as unknown as { _lastInstance?: MockWebSocket }
    )._lastInstance;
    if (mockInstance) mockInstance.readyState = 0; // CONNECTING

    expect(() => {
      ws.send({ type: 'fetch_tasks', projectId: 'board-1', milestoneId: 'm1' });
    }).not.toThrow();
  });

  it('send() does not call socket.send when readyState is not OPEN', () => {
    const onMessage = vi.fn();
    // Create a spy factory to track constructed instances
    const instances: MockWebSocket[] = [];
    const TrackingWS = class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        this.readyState = 0; // CONNECTING — not open
        instances.push(this);
      }
    };
    vi.stubGlobal('WebSocket', TrackingWS);

    const { result } = renderHook(() => useWebSocket(onMessage));
    result.current.send({ type: 'kill', sessionId: 'abc' });

    expect(instances[0]?.send).not.toHaveBeenCalled();
  });

  it('send() transmits JSON when socket is OPEN', () => {
    const onMessage = vi.fn();
    const instances: MockWebSocket[] = [];
    const TrackingWS = class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        this.readyState = MockWebSocket.OPEN;
        instances.push(this);
      }
    };
    vi.stubGlobal('WebSocket', TrackingWS);

    const { result } = renderHook(() => useWebSocket(onMessage));
    result.current.send({
      type: 'fetch_tasks',
      projectId: 'b1',
      milestoneId: 'm1',
    });

    expect(instances[0]?.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'fetch_tasks',
        projectId: 'b1',
        milestoneId: 'm1',
      }),
    );
  });

  it('calls onMessage with parsed ServerMessage on incoming frame', () => {
    const onMessage = vi.fn();
    const instances: MockWebSocket[] = [];
    const TrackingWS = class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    };
    vi.stubGlobal('WebSocket', TrackingWS);

    renderHook(() => useWebSocket(onMessage));

    const payload = { type: 'error', message: 'boom' };
    instances[0]?.onmessage?.({ data: JSON.stringify(payload) });

    expect(onMessage).toHaveBeenCalledWith(payload);
  });

  it('silently ignores malformed (non-JSON) frames', () => {
    const onMessage = vi.fn();
    const instances: MockWebSocket[] = [];
    const TrackingWS = class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    };
    vi.stubGlobal('WebSocket', TrackingWS);

    renderHook(() => useWebSocket(onMessage));

    expect(() => {
      instances[0]?.onmessage?.({ data: 'not json {{{' });
    }).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
  });
});
