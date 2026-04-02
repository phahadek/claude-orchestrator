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

  it('does NOT call handlers when event.target is an HTMLInputElement', () => {
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));

    const input = document.createElement('input');
    fireKey('N', input);
    fireKey('J', input);
    fireKey('Escape', input);

    expect(handlers.onOpenDispatch).not.toHaveBeenCalled();
    expect(handlers.onSelectNext).not.toHaveBeenCalled();
    expect(handlers.onDismiss).not.toHaveBeenCalled();
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

  it('1 calls onSwitchView with "sessions"', () => {
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey('1');
    expect(handlers.onSwitchView).toHaveBeenCalledWith('sessions');
  });

  it('2 calls onSwitchView with "prs"', () => {
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey('2');
    expect(handlers.onSwitchView).toHaveBeenCalledWith('prs');
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
