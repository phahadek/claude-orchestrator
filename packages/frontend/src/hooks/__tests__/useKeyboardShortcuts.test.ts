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

function fireKey(
  key: string,
  opts?: {
    target?: EventTarget;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
  },
) {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    metaKey: opts?.metaKey ?? false,
    ctrlKey: opts?.ctrlKey ?? false,
    altKey: opts?.altKey ?? false,
  });
  if (opts?.target) {
    Object.defineProperty(event, 'target', {
      value: opts.target,
      writable: false,
    });
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
    fireKey('N', { target: input });
    fireKey('J', { target: input });

    expect(handlers.onOpenDispatch).not.toHaveBeenCalled();
    expect(handlers.onSelectNext).not.toHaveBeenCalled();
  });

  it('Escape fires onDismiss even when target is an input (clears search)', () => {
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey('Escape', { target: document.createElement('input') });
    expect(handlers.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('Escape passes fromInputField=true when fired from an input', () => {
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey('Escape', { target: document.createElement('input') });
    expect(handlers.onDismiss).toHaveBeenCalledWith(true);
  });

  it('Escape passes fromInputField=true when fired from a textarea', () => {
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey('Escape', { target: document.createElement('textarea') });
    expect(handlers.onDismiss).toHaveBeenCalledWith(true);
  });

  it('Escape passes fromInputField=false when fired outside a text field', () => {
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));
    fireKey('Escape', { target: document.createElement('div') });
    expect(handlers.onDismiss).toHaveBeenCalledWith(false);
  });

  it('does NOT call handlers when event.target is an HTMLTextAreaElement', () => {
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));

    const textarea = document.createElement('textarea');
    fireKey('N', { target: textarea });
    fireKey('K', { target: textarea });

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

  it('Enter with a focused <button> target does NOT call onConfirmSelection', () => {
    const handlers = makeHandlers();
    renderHook(() => useKeyboardShortcuts(handlers));
    const button = document.createElement('button');
    fireKey('Enter', { target: button });
    expect(handlers.onConfirmSelection).not.toHaveBeenCalled();
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

  describe('modifier guard', () => {
    const cases: Array<{
      key: string;
      modifier: 'metaKey' | 'ctrlKey' | 'altKey';
    }> = [
      { key: '1', modifier: 'metaKey' },
      { key: '2', modifier: 'metaKey' },
      { key: '3', modifier: 'metaKey' },
      { key: '4', modifier: 'metaKey' },
      { key: '5', modifier: 'metaKey' },
      { key: '1', modifier: 'ctrlKey' },
      { key: '2', modifier: 'ctrlKey' },
      { key: '3', modifier: 'ctrlKey' },
      { key: '4', modifier: 'ctrlKey' },
      { key: '5', modifier: 'ctrlKey' },
      { key: 'n', modifier: 'metaKey' },
      { key: 'n', modifier: 'ctrlKey' },
      { key: 'j', modifier: 'ctrlKey' },
      { key: 'j', modifier: 'metaKey' },
      { key: 'k', modifier: 'ctrlKey' },
      { key: 'k', modifier: 'metaKey' },
      { key: 'Enter', modifier: 'metaKey' },
      { key: 'Enter', modifier: 'ctrlKey' },
      { key: '/', modifier: 'metaKey' },
      { key: '/', modifier: 'ctrlKey' },
      { key: 'Escape', modifier: 'metaKey' },
      { key: 'Escape', modifier: 'ctrlKey' },
      { key: '1', modifier: 'altKey' },
      { key: 'n', modifier: 'altKey' },
    ];

    for (const { key, modifier } of cases) {
      it(`ignores ${key} when ${modifier} is held`, () => {
        const handlers = makeHandlers();
        renderHook(() => useKeyboardShortcuts(handlers));
        fireKey(key, { [modifier]: true });

        expect(handlers.onOpenDispatch).not.toHaveBeenCalled();
        expect(handlers.onDismiss).not.toHaveBeenCalled();
        expect(handlers.onSelectNext).not.toHaveBeenCalled();
        expect(handlers.onSelectPrev).not.toHaveBeenCalled();
        expect(handlers.onConfirmSelection).not.toHaveBeenCalled();
        expect(handlers.onSwitchView).not.toHaveBeenCalled();
        expect(handlers.onFocusSearch).not.toHaveBeenCalled();
      });
    }

    it('Cmd+1 through Cmd+5 do not change the active view', () => {
      const handlers = makeHandlers();
      renderHook(() => useKeyboardShortcuts(handlers));
      for (const key of ['1', '2', '3', '4', '5']) {
        fireKey(key, { metaKey: true });
      }
      expect(handlers.onSwitchView).not.toHaveBeenCalled();
    });

    it('Ctrl+1 through Ctrl+5 do not change the active view', () => {
      const handlers = makeHandlers();
      renderHook(() => useKeyboardShortcuts(handlers));
      for (const key of ['1', '2', '3', '4', '5']) {
        fireKey(key, { ctrlKey: true });
      }
      expect(handlers.onSwitchView).not.toHaveBeenCalled();
    });

    it('Cmd+N does not open the Dispatch modal', () => {
      const handlers = makeHandlers();
      renderHook(() => useKeyboardShortcuts(handlers));
      fireKey('n', { metaKey: true });
      expect(handlers.onOpenDispatch).not.toHaveBeenCalled();
    });

    it('Ctrl+N does not open the Dispatch modal', () => {
      const handlers = makeHandlers();
      renderHook(() => useKeyboardShortcuts(handlers));
      fireKey('n', { ctrlKey: true });
      expect(handlers.onOpenDispatch).not.toHaveBeenCalled();
    });

    it('unmodified 1-5, n, j, k, Enter and / still behave as before', () => {
      const handlers = makeHandlers();
      renderHook(() => useKeyboardShortcuts(handlers));

      fireKey('1');
      fireKey('2');
      fireKey('3');
      fireKey('4');
      fireKey('5');
      fireKey('n');
      fireKey('j');
      fireKey('k');
      fireKey('Enter');
      fireKey('/');

      expect(handlers.onSwitchView).toHaveBeenNthCalledWith(1, 'tasks');
      expect(handlers.onSwitchView).toHaveBeenNthCalledWith(2, 'sessions');
      expect(handlers.onSwitchView).toHaveBeenNthCalledWith(3, 'prs');
      expect(handlers.onSwitchView).toHaveBeenNthCalledWith(4, 'analytics');
      expect(handlers.onSwitchView).toHaveBeenNthCalledWith(5, 'settings');
      expect(handlers.onOpenDispatch).toHaveBeenCalledTimes(1);
      expect(handlers.onSelectNext).toHaveBeenCalledTimes(1);
      expect(handlers.onSelectPrev).toHaveBeenCalledTimes(1);
      expect(handlers.onConfirmSelection).toHaveBeenCalledTimes(1);
      expect(handlers.onFocusSearch).toHaveBeenCalledTimes(1);
    });
  });
});
