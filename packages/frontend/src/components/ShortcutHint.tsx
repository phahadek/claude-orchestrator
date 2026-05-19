import { useState } from "react";
import styles from "./ShortcutHint.module.css";

const SHORTCUTS = [
  { key: "N", desc: "New session" },
  { key: "Esc", desc: "Close modal / panel" },
  { key: "J", desc: "Next session" },
  { key: "K", desc: "Previous session" },
  { key: "Enter", desc: "Open selected session" },
  { key: "1", desc: "Sessions view" },
  { key: "2", desc: "PRs view" },
  { key: "R", desc: "Rules view" },
  { key: "/", desc: "Focus search" },
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
