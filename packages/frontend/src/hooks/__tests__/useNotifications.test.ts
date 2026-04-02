import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useNotifications } from '../useNotifications';
import type { SessionState } from '../useSessionStore';

// Minimal SessionState factory
function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: 'sess-1',
    taskName: 'My Task',
    notionTaskUrl: 'https://notion.so/task',
    status: 'running',
    events: [],
    ...overrides,
  };
}

// Map-backed localStorage mock
function makeLocalStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
}

describe('useNotifications', () => {
  let NotificationSpy: ReturnType<typeof vi.fn>;
  let localStorageMock: ReturnType<typeof makeLocalStorageMock>;

  beforeEach(() => {
    // Provide a fresh localStorage mock for each test
    localStorageMock = makeLocalStorageMock();
    vi.stubGlobal('localStorage', localStorageMock);

    // Default: hidden tab
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });

    // Mock Notification — cast to any to allow setting static properties
    NotificationSpy = vi.fn();
    (NotificationSpy as unknown as { permission: string }).permission = 'granted';
    (NotificationSpy as unknown as { requestPermission: () => Promise<string> }).requestPermission = vi.fn().mockResolvedValue('granted');
    vi.stubGlobal('Notification', NotificationSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does NOT fire when document.visibilityState is visible', () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });

    const session = makeSession({ status: 'running' });
    const { rerender } = renderHook(({ s }) => useNotifications(s), {
      initialProps: { s: [session] },
    });

    act(() => {
      rerender({ s: [{ ...session, status: 'done' }] });
    });

    expect(NotificationSpy).not.toHaveBeenCalled();
  });

  it('fires notification when session transitions from running to done while tab is hidden', () => {
    const session = makeSession({ status: 'running' });
    const { rerender } = renderHook(({ s }) => useNotifications(s), {
      initialProps: { s: [session] },
    });

    act(() => {
      rerender({ s: [{ ...session, status: 'done' }] });
    });

    expect(NotificationSpy).toHaveBeenCalledWith(
      '✅ Session done',
      expect.objectContaining({ body: 'My Task finished successfully.' }),
    );
  });

  it('fires error notification when session transitions to error while tab is hidden', () => {
    const session = makeSession({ status: 'running' });
    const { rerender } = renderHook(({ s }) => useNotifications(s), {
      initialProps: { s: [session] },
    });

    act(() => {
      rerender({ s: [{ ...session, status: 'error' }] });
    });

    expect(NotificationSpy).toHaveBeenCalledWith(
      '❌ Session failed',
      expect.objectContaining({ body: 'My Task encountered an error.' }),
    );
  });

  it('fires permission notification when pendingPermission appears', () => {
    const session = makeSession({ status: 'running' });
    const { rerender } = renderHook(({ s }) => useNotifications(s), {
      initialProps: { s: [session] },
    });

    act(() => {
      rerender({
        s: [{ ...session, status: 'needs_permission', pendingPermission: { toolName: 'Bash', proposedAction: 'rm -rf' } }],
      });
    });

    expect(NotificationSpy).toHaveBeenCalledWith(
      '🔔 Approval needed',
      expect.objectContaining({ body: 'Bash requested in My Task. Click to review.' }),
    );
  });

  it('does not fire when Notification permission is denied', () => {
    const deniedSpy = vi.fn();
    (deniedSpy as unknown as { permission: string }).permission = 'denied';
    (deniedSpy as unknown as { requestPermission: () => Promise<string> }).requestPermission = vi.fn().mockResolvedValue('denied');
    vi.stubGlobal('Notification', deniedSpy);

    const session = makeSession({ status: 'running' });
    const { rerender } = renderHook(({ s }) => useNotifications(s), {
      initialProps: { s: [session] },
    });

    act(() => {
      rerender({ s: [{ ...session, status: 'done' }] });
    });

    expect(deniedSpy).not.toHaveBeenCalled();
  });

  it('degrades gracefully when Notification is not defined', () => {
    vi.stubGlobal('Notification', undefined);

    const session = makeSession({ status: 'running' });
    const { rerender } = renderHook(({ s }) => useNotifications(s), {
      initialProps: { s: [session] },
    });

    expect(() => {
      act(() => {
        rerender({ s: [{ ...session, status: 'done' }] });
      });
    }).not.toThrow();
  });

  it('does not fire again for an already-notified status', () => {
    const session = makeSession({ status: 'running' });
    const { rerender } = renderHook(({ s }) => useNotifications(s), {
      initialProps: { s: [session] },
    });

    act(() => {
      rerender({ s: [{ ...session, status: 'done' }] });
    });
    const firstCallCount = NotificationSpy.mock.calls.length;

    act(() => {
      rerender({ s: [{ ...session, status: 'done' }] });
    });

    expect(NotificationSpy.mock.calls.length).toBe(firstCallCount);
  });

  it('does not fire when notificationsEnabled is false in localStorage', () => {
    localStorage.setItem('notificationsEnabled', 'false');

    const session = makeSession({ status: 'running' });
    const { rerender } = renderHook(({ s }) => useNotifications(s), {
      initialProps: { s: [session] },
    });

    act(() => {
      rerender({ s: [{ ...session, status: 'done' }] });
    });

    expect(NotificationSpy).not.toHaveBeenCalled();
  });
});
