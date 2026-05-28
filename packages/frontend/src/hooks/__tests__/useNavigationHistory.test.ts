import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useNavigationHistory } from '../useNavigationHistory';

function makeHandlers() {
  return {
    setSelectedTaskId: vi.fn(),
    setSelectedId: vi.fn(),
    setSessionOverlayOpen: vi.fn(),
  };
}

function firePopState(state: unknown) {
  window.dispatchEvent(new PopStateEvent('popstate', { state }));
}

beforeEach(() => {
  vi.spyOn(window.history, 'pushState');
  vi.spyOn(window.history, 'back').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useNavigationHistory', () => {
  it('pushView calls history.pushState with the correct state shape', () => {
    const handlers = makeHandlers();
    const { result } = renderHook(() => useNavigationHistory(handlers));

    result.current.pushView({ type: 'task', id: 'task-1' });
    expect(window.history.pushState).toHaveBeenCalledWith({ type: 'task', id: 'task-1' }, '');

    result.current.pushView({ type: 'session', id: 'sess-1' });
    expect(window.history.pushState).toHaveBeenCalledWith({ type: 'session', id: 'sess-1' }, '');

    result.current.pushView({ type: 'sessionOverlay', taskId: 'task-1' });
    expect(window.history.pushState).toHaveBeenCalledWith({ type: 'sessionOverlay', taskId: 'task-1' }, '');
  });

  it('popView calls history.back', () => {
    const handlers = makeHandlers();
    const { result } = renderHook(() => useNavigationHistory(handlers));

    result.current.popView();
    expect(window.history.back).toHaveBeenCalledOnce();
  });

  it('installs a single popstate listener on mount', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const handlers = makeHandlers();
    renderHook(() => useNavigationHistory(handlers));

    const popstateCalls = addSpy.mock.calls.filter(([event]) => event === 'popstate');
    expect(popstateCalls).toHaveLength(1);
    addSpy.mockRestore();
  });

  it('removes the popstate listener on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const handlers = makeHandlers();
    const { unmount } = renderHook(() => useNavigationHistory(handlers));

    unmount();

    const popstateCalls = removeSpy.mock.calls.filter(([event]) => event === 'popstate');
    expect(popstateCalls).toHaveLength(1);
    removeSpy.mockRestore();
  });

  it('popstate with task state calls setSelectedTaskId, clears others', () => {
    const handlers = makeHandlers();
    renderHook(() => useNavigationHistory(handlers));

    firePopState({ type: 'task', id: 'task-42' });

    expect(handlers.setSelectedTaskId).toHaveBeenCalledWith('task-42');
    expect(handlers.setSelectedId).toHaveBeenCalledWith(null);
    expect(handlers.setSessionOverlayOpen).toHaveBeenCalledWith(false);
  });

  it('popstate with session state calls setSelectedId, clears others', () => {
    const handlers = makeHandlers();
    renderHook(() => useNavigationHistory(handlers));

    firePopState({ type: 'session', id: 'sess-99' });

    expect(handlers.setSelectedId).toHaveBeenCalledWith('sess-99');
    expect(handlers.setSelectedTaskId).toHaveBeenCalledWith(null);
    expect(handlers.setSessionOverlayOpen).toHaveBeenCalledWith(false);
  });

  it('popstate with sessionOverlay state calls setSelectedTaskId and opens overlay', () => {
    const handlers = makeHandlers();
    renderHook(() => useNavigationHistory(handlers));

    firePopState({ type: 'sessionOverlay', taskId: 'task-1' });

    expect(handlers.setSelectedTaskId).toHaveBeenCalledWith('task-1');
    expect(handlers.setSelectedId).toHaveBeenCalledWith(null);
    expect(handlers.setSessionOverlayOpen).toHaveBeenCalledWith(true);
  });

  it('popstate with null state clears all navigation state', () => {
    const handlers = makeHandlers();
    renderHook(() => useNavigationHistory(handlers));

    firePopState(null);

    expect(handlers.setSelectedTaskId).toHaveBeenCalledWith(null);
    expect(handlers.setSelectedId).toHaveBeenCalledWith(null);
    expect(handlers.setSessionOverlayOpen).toHaveBeenCalledWith(false);
  });

  it('popstate with unknown type clears all navigation state', () => {
    const handlers = makeHandlers();
    renderHook(() => useNavigationHistory(handlers));

    firePopState({});

    expect(handlers.setSelectedTaskId).toHaveBeenCalledWith(null);
    expect(handlers.setSelectedId).toHaveBeenCalledWith(null);
    expect(handlers.setSessionOverlayOpen).toHaveBeenCalledWith(false);
  });

  it('does not fire after unmount', () => {
    const handlers = makeHandlers();
    const { unmount } = renderHook(() => useNavigationHistory(handlers));

    unmount();
    firePopState({ type: 'task', id: 'task-1' });

    expect(handlers.setSelectedTaskId).not.toHaveBeenCalled();
  });

  it('uses latest handlers from ref (no stale closures)', () => {
    const handlers1 = makeHandlers();
    const handlers2 = makeHandlers();
    const { rerender } = renderHook(
      ({ h }) => useNavigationHistory(h),
      { initialProps: { h: handlers1 } },
    );

    rerender({ h: handlers2 });
    firePopState({ type: 'task', id: 'task-x' });

    expect(handlers1.setSelectedTaskId).not.toHaveBeenCalled();
    expect(handlers2.setSelectedTaskId).toHaveBeenCalledWith('task-x');
  });
});
