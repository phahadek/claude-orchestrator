import { useEffect, useRef } from 'react';
import type { PanelKeyboardDeclaration } from '../types/panelKeyboard';
import { useKeyboardRing } from '../types/panelKeyboard';

export interface ShortcutHandlers {
  onDismiss: (fromInputField: boolean) => void;
  onSelectNext: () => void;
  onSelectPrev: () => void;
  onConfirmSelection: () => void;
  onSwitchView: (
    view:
      | 'milestone'
      | 'tasks'
      | 'sessions'
      | 'prs'
      | 'gate'
      | 'architecture'
      | 'analytics'
      | 'settings',
  ) => void;
  onFocusSearch: () => void;
  /**
   * True only while the active view actually mounts a search input for
   * onFocusSearch to focus (today: the Sessions view's SessionFilterBar).
   * The '/' binding is a no-op — and ShortcutHint hides its hint — whenever
   * this is false, so the shortcut is never advertised somewhere it can't
   * act.
   */
  canFocusSearch?: boolean;
  /**
   * The currently-active panel's keyboard declaration (e.g. the milestone
   * decision-card ring). When present, J/K/Enter dispatch against its
   * ordered item list — moving an id-anchored ring highlight and firing
   * approve on Enter — instead of the legacy onSelectNext/onSelectPrev/
   * onConfirmSelection triple, which stays session-grid-only. Omit or pass
   * null on views with no declared ring (e.g. Sessions).
   */
  activePanel?: PanelKeyboardDeclaration | null;
}

export interface KeyboardShortcutsResult {
  /** The active panel's ring highlight, or null when no panel is active or nothing is highlighted. */
  highlightedItemId: string | null;
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
    desc: 'Milestone view',
    matches: (e) => e.key === '1',
    invoke: (h) => h.onSwitchView('milestone'),
  },
  {
    key: '2',
    desc: 'Tasks view',
    matches: (e) => e.key === '2',
    invoke: (h) => h.onSwitchView('tasks'),
  },
  {
    key: '3',
    desc: 'Sessions view',
    matches: (e) => e.key === '3',
    invoke: (h) => h.onSwitchView('sessions'),
  },
  {
    key: '4',
    desc: 'PRs view',
    matches: (e) => e.key === '4',
    invoke: (h) => h.onSwitchView('prs'),
  },
  {
    key: '5',
    desc: 'Gate view',
    matches: (e) => e.key === '5',
    invoke: (h) => h.onSwitchView('gate'),
  },
  {
    key: '6',
    desc: 'Architecture view',
    matches: (e) => e.key === '6',
    invoke: (h) => h.onSwitchView('architecture'),
  },
  {
    key: '7',
    desc: 'Analytics view',
    matches: (e) => e.key === '7',
    invoke: (h) => h.onSwitchView('analytics'),
  },
  {
    key: '8',
    desc: 'Settings view',
    matches: (e) => e.key === '8',
    invoke: (h) => h.onSwitchView('settings'),
  },
  {
    key: '/',
    desc: 'Focus search',
    matches: (e) => e.key === '/',
    invoke: (h) => {
      if (h.canFocusSearch) h.onFocusSearch();
    },
    preventDefault: true,
  },
];

export function useKeyboardShortcuts(
  handlers: ShortcutHandlers,
): KeyboardShortcutsResult {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  const activePanel = handlers.activePanel ?? null;
  const ringItems = activePanel ? activePanel.orderedItems() : [];
  const ring = useKeyboardRing(ringItems);
  const ringRef = useRef(ring);
  useEffect(() => {
    ringRef.current = ring;
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Never hijack modified chords (browser/OS shortcuts like Cmd+1, Ctrl+N, Ctrl+J).
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const isInputField = Boolean(
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable),
      );

      const panel = handlersRef.current.activePanel ?? null;

      if (panel && !isInputField) {
        if (event.key === 'j' || event.key === 'J') {
          event.preventDefault();
          ringRef.current.selectNext();
          return;
        }
        if (event.key === 'k' || event.key === 'K') {
          event.preventDefault();
          ringRef.current.selectPrev();
          return;
        }
        if (event.key === 'Enter') {
          const highlighted = ringRef.current.highlightedId;
          const item = panel.orderedItems().find((i) => i.id === highlighted);
          if (item) panel.onApprove?.(item);
          return;
        }
      }

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

  return { highlightedItemId: ring.highlightedId };
}
