import { useEffect, useState } from 'react';
import type { PanelKeyboardDeclaration } from '../types/panelKeyboard';
import { KEYBOARD_SHORTCUTS } from '../hooks/useKeyboardShortcuts';
import styles from './ShortcutHint.module.css';

type Binding = { key: string; description: string };

// The fixed bindings that hold across every surface, regardless of which
// panel (if any) is active — view-switch digits and dismiss. J/K/Enter are
// deliberately excluded: those are context-sensitive and come from the
// active panel's own declared hints instead. '/' (search focus) is excluded
// too — it only applies to views that actually mount a search input, so
// it's appended conditionally below rather than unconditionally advertised
// everywhere.
const GLOBAL_KEYS = new Set(['Esc', '1', '2', '3', '4', '5']);

const FOCUS_SEARCH_SHORTCUT = KEYBOARD_SHORTCUTS.find((s) => s.key === '/');

// Shift+Enter is handled locally by the Composer's textarea (see
// Composer.tsx), not by useKeyboardShortcuts — documented here by hand since
// it isn't part of that shared key map.
const GLOBAL_SHORTCUTS: Binding[] = [
  ...KEYBOARD_SHORTCUTS.filter((s) => GLOBAL_KEYS.has(s.key)).map((s) => ({
    key: s.key,
    description: s.desc,
  })),
  { key: 'Shift+Enter', description: 'Insert newline in the composer' },
];

export interface ShortcutHintProps {
  /** The currently active panel's keyboard declaration, or null/undefined when none is active. */
  activePanel?: PanelKeyboardDeclaration | null;
  /** True only while the active view actually mounts a search input — see useKeyboardShortcuts' canFocusSearch. Gates whether the Focus Search hint is advertised at all. */
  canFocusSearch?: boolean;
}

export function ShortcutHint({
  activePanel,
  canFocusSearch,
}: ShortcutHintProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const isInputField =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable);

      if (event.key === '?' && !isInputField) {
        event.preventDefault();
        // Prevent this keypress from also reaching the app-wide shortcut
        // dispatcher.
        event.stopImmediatePropagation();
        setOpen(true);
      } else if (event.key === 'Escape' && open) {
        event.stopImmediatePropagation();
        setOpen(false);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const bindings: Binding[] = [
    ...(activePanel?.hints.map((h) => ({
      key: h.key,
      description: h.description,
    })) ?? []),
    ...GLOBAL_SHORTCUTS,
    ...(canFocusSearch && FOCUS_SEARCH_SHORTCUT
      ? [
          {
            key: FOCUS_SEARCH_SHORTCUT.key,
            description: FOCUS_SEARCH_SHORTCUT.desc,
          },
        ]
      : []),
  ];

  return (
    <div className={styles.container}>
      <button
        className={styles.trigger}
        onClick={() => setOpen(true)}
        aria-label="Keyboard shortcuts"
        type="button"
      >
        ?
      </button>
      {open && (
        <div className={styles['modal-overlay']} onClick={() => setOpen(false)}>
          <div
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
            onClick={(event) => event.stopPropagation()}
          >
            <div className={styles.title}>Keyboard shortcuts</div>
            <table className={styles.table}>
              <tbody>
                {bindings.map(({ key, description }) => (
                  <tr key={key}>
                    <td className={styles.key}>
                      <kbd>{key}</kbd>
                    </td>
                    <td className={styles.desc}>{description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
