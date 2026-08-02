import { useState } from 'react';
import styles from './ShortcutHint.module.css';
import { KEYBOARD_SHORTCUTS } from '../hooks/useKeyboardShortcuts';

// Shift+Enter is handled locally by the Composer's textarea (see
// Composer.tsx), not by useKeyboardShortcuts — documented here by hand since
// it isn't part of that shared key map.
const EXTRA_SHORTCUTS = [
  { key: 'Shift+Enter', desc: 'Insert newline in the composer' },
];

const SHORTCUTS = [
  ...KEYBOARD_SHORTCUTS.map(({ key, desc }) => ({ key, desc })),
  ...EXTRA_SHORTCUTS,
];

export function ShortcutHint() {
  const [open, setOpen] = useState(false);

  return (
    <div className={styles.container}>
      {open && (
        <div className={styles.card}>
          <div className={styles.title}>Keyboard shortcuts</div>
          <table className={styles.table}>
            <tbody>
              {SHORTCUTS.map(({ key, desc }) => (
                <tr key={key}>
                  <td className={styles.key}>
                    <kbd>{key}</kbd>
                  </td>
                  <td className={styles.desc}>{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        aria-label="Keyboard shortcuts"
        type="button"
      >
        ?
      </button>
    </div>
  );
}
