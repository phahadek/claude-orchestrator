import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useKeyboardShortcuts } from '../useKeyboardShortcuts';
import type { ShortcutHandlers } from '../useKeyboardShortcuts';

function makeHandlers(overrides?: Partial<ShortcutHandlers>): ShortcutHandlers {
  return {
    onOpenDispatch: vi.fn(),
    onDismiss: vi.fn(),
    onSelectNext: vi.fn(),
    onSelectPrev: vi.fn(),
    onConfirmSelection: vi.fn(),
    onSwitchView: vi.fn(),
    onFocusSearch: vi.fn(),
    ...overrides,
  };
}

function fireKey(key: string, target?: EventTarget) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true });
  if (target) {
    Object.defineProperty(event, 'target', { value: target, writable: false });
  }
  window.dispatchEvent(event);
}

describe('useKeyboardShortcuts', () => {
  beforeEach(() => {
    // clean up any lingering listeners between tests
  });

  it('does NOT call most handlers when event.target is an HTMLInputElement', () => {
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));

    const input = document.createElement('input');
    fireKey('N', input);
    fireKey('J', input);

    expect(handlers.onOpenDispatch).not.toHaveBeenCalled();
    expect(handlers.onSelectNext).not.toHaveBeenCalled();
  });

  it('Escape fires onDismiss even when target is an input (clears search)', () => {
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey('Escape', document.createElement('input'));
    expect(handlers.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does NOT call handlers when event.target is an HTMLTextAreaElement', () => {
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));

    const textarea = document.createElement('textarea');
    fireKey('N', textarea);
    fireKey('K', textarea);

    expect(handlers.onOpenDispatch).not.toHaveBeenCalled();
    expect(handlers.onSelectPrev).not.toHaveBeenCalled();
  });

  it('N key calls onOpenDispatch', () => {
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey('N');
    expect(handlers.onOpenDispatch).toHaveBeenCalledTimes(1);
  });

  it('Escape calls onDismiss', () => {
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey('Escape');
    expect(handlers.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('J calls onSelectNext', () => {
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey('J');
    expect(handlers.onSelectNext).toHaveBeenCalledTimes(1);
  });

  it('K calls onSelectPrev', () => {
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey('K');
    expect(handlers.onSelectPrev).toHaveBeenCalledTimes(1);
  });

  it('Enter calls onConfirmSelection', () => {
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey('Enter');
    expect(handlers.onConfirmSelection).toHaveBeenCalledTimes(1);
  });

  it('1 calls onSwitchView with "tasks"', () => {
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey('1');
    expect(handlers.onSwitchView).toHaveBeenCalledWith('tasks');
  });

  it('2 calls onSwitchView with "sessions"', () => {
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey('2');
    expect(handlers.onSwitchView).toHaveBeenCalledWith('sessions');
  });

  it('3 calls onSwitchView with "prs"', () => {
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey('3');
    expect(handlers.onSwitchView).toHaveBeenCalledWith('prs');
  });

  it('4 calls onSwitchView with "analytics"', () => {
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey('4');
    expect(handlers.onSwitchView).toHaveBeenCalledWith('analytics');
  });

  it('5 calls onSwitchView with "settings"', () => {
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey('5');
    expect(handlers.onSwitchView).toHaveBeenCalledWith('settings');
  });

  it('1-5 map to the rendered nav order of shortcut-bearing items (Tasks, Sessions, PRs, Analytics, Settings)', () => {
    // Keep in sync with Header's nav order test: only these 5 of the 8 nav
    // items carry number-key shortcuts, matching their left-to-right order.
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));
    ['1', '2', '3', '4', '5'].forEach((key) => fireKey(key));
    expect(
      (handlers.onSwitchView as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => call[0],
      ),
    ).toEqual(['tasks', 'sessions', 'prs', 'analytics', 'settings']);
  });

  it('/ calls onFocusSearch', () => {
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey('/');
    expect(handlers.onFocusSearch).toHaveBeenCalledTimes(1);
  });

  it('removes keydown listener on unmount', () => {
    const handlers = makeHandlers();
    const { unmount } = renderHook(() => useKeyboardShortcuts(handlers));
    unmount();
    fireKey('N');
    expect(handlers.onOpenDispatch).not.toHaveBeenCalled();
  });
});
