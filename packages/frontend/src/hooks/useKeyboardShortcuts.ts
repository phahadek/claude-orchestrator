import { useEffect, useRef } from 'react';

export interface ShortcutHandlers {
  onOpenDispatch: () => void;
  onDismiss: (fromInputField: boolean) => void;
  onSelectNext: () => void;
  onSelectPrev: () => void;
  onConfirmSelection: () => void;
  onSwitchView: (
    view: 'tasks' | 'sessions' | 'prs' | 'analytics' | 'settings',
  ) => void;
  onFocusSearch: () => void;
}

export interface ShortcutDefinition {
  /** Label shown in the cheatsheet, e.g. "N", "Esc", "1". */
  key: string;
  /** Description shown in the cheatsheet. */
  desc: string;
  /** Whether this key is handled even when focus is in an input/textarea. */
  allowInInput?: boolean;
  matches: (event: KeyboardEvent) => boolean;
  invoke: (
    handlers: ShortcutHandlers,
    event: KeyboardEvent,
    isInputField: boolean,
  ) => void;
  preventDefault?: boolean;
}

// Single source of truth for both the keydown dispatcher below and the
// on-screen cheatsheet (ShortcutHint.tsx) — add a binding here and both
// stay in sync automatically.
export const KEYBOARD_SHORTCUTS: ShortcutDefinition[] = [
  {
    key: 'Esc',
    desc: 'Close modal / panel',
    allowInInput: true,
    matches: (e) => e.key === 'Escape',
    // The input's own field context is passed through so the caller can
    // skip navigating away and discarding an in-progress draft.
    invoke: (h, _event, isInputField) => h.onDismiss(isInputField),
  },
  {
    key: 'N',
    desc: 'Open Dispatch modal',
    matches: (e) => e.key === 'n' || e.key === 'N',
    invoke: (h) => h.onOpenDispatch(),
    preventDefault: true,
  },
  {
    key: 'J',
    desc: 'Next session',
    matches: (e) => e.key === 'j' || e.key === 'J',
    invoke: (h) => h.onSelectNext(),
    preventDefault: true,
  },
  {
    key: 'K',
    desc: 'Previous session',
    matches: (e) => e.key === 'k' || e.key === 'K',
    invoke: (h) => h.onSelectPrev(),
    preventDefault: true,
  },
  {
    key: 'Enter',
    desc: 'Open selected session',
    matches: (e) => e.key === 'Enter',
    invoke: (h, event) => {
      // Don't let an unrelated focused button's Enter activation also
      // mutate session selection.
      if (event.target instanceof HTMLButtonElement) return;
      h.onConfirmSelection();
    },
  },
  {
    key: '1',
    desc: 'Tasks view',
    matches: (e) => e.key === '1',
    invoke: (h) => h.onSwitchView('tasks'),
  },
  {
    key: '2',
    desc: 'Sessions view',
    matches: (e) => e.key === '2',
    invoke: (h) => h.onSwitchView('sessions'),
  },
  {
    key: '3',
    desc: 'PRs view',
    matches: (e) => e.key === '3',
    invoke: (h) => h.onSwitchView('prs'),
  },
  {
    key: '4',
    desc: 'Analytics view',
    matches: (e) => e.key === '4',
    invoke: (h) => h.onSwitchView('analytics'),
  },
  {
    key: '5',
    desc: 'Settings view',
    matches: (e) => e.key === '5',
    invoke: (h) => h.onSwitchView('settings'),
  },
  {
    key: '/',
    desc: 'Focus search',
    matches: (e) => e.key === '/',
    invoke: (h) => h.onFocusSearch(),
    preventDefault: true,
  },
];

export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Never hijack modified chords (browser/OS shortcuts like Cmd+1, Ctrl+N, Ctrl+J).
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const isInputField = Boolean(
        event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement ||
          (event.target instanceof HTMLElement &&
            event.target.isContentEditable),
      );

      const shortcut = KEYBOARD_SHORTCUTS.find((s) => s.matches(event));
      if (!shortcut) return;

      // ESC fires even from input fields (e.g. to clear search and blur)
      if (isInputField && !shortcut.allowInInput) return;

      if (shortcut.preventDefault) event.preventDefault();
      shortcut.invoke(handlersRef.current, event, isInputField);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
