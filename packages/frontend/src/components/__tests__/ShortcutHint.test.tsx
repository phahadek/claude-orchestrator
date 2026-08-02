import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ShortcutHint } from '../ShortcutHint';
import styles from '../ShortcutHint.module.css';
import { KEYBOARD_SHORTCUTS } from '../../hooks/useKeyboardShortcuts';

describe('ShortcutHint', () => {
  it('renders the trigger button at desktop viewport (regression)', () => {
    render(<ShortcutHint />);
    expect(
      screen.getByRole('button', { name: /keyboard shortcuts/i }),
    ).toBeDefined();
  });

  it('container uses the CSS class that hides at mobile via media query', () => {
    const { container } = render(<ShortcutHint />);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain(styles.container);
  });

  it('drift guard: every key handled by useKeyboardShortcuts is documented in the cheatsheet', () => {
    // Rendering (not visibility) is what matters here — the mobile-hiding
    // media query only affects CSS display, not whether the rows exist in
    // the DOM, so this assertion holds regardless of viewport.
    render(<ShortcutHint />);
    fireEvent.click(screen.getByRole('button', { name: /keyboard shortcuts/i }));

    for (const { key, desc } of KEYBOARD_SHORTCUTS) {
      const row = screen.getByText(key, { selector: 'kbd' }).closest('tr');
      expect(row).not.toBeNull();
      expect(row?.textContent).toContain(desc);
    }
  });

  it('drift guard: the cheatsheet documents no key that useKeyboardShortcuts does not handle', () => {
    const { container } = render(<ShortcutHint />);
    fireEvent.click(screen.getByRole('button', { name: /keyboard shortcuts/i }));

    const knownKeys = new Set(KEYBOARD_SHORTCUTS.map((s) => s.key));
    // Shift+Enter is the one documented binding not owned by
    // useKeyboardShortcuts — it's handled locally by the Composer.
    knownKeys.add('Shift+Enter');

    const kbdEls = container.querySelectorAll('kbd');
    expect(kbdEls.length).toBeGreaterThan(0);
    kbdEls.forEach((el) => {
      expect(knownKeys.has(el.textContent ?? '')).toBe(true);
    });
  });

  it('does not document the removed Rules view shortcut', () => {
    render(<ShortcutHint />);
    fireEvent.click(screen.getByRole('button', { name: /keyboard shortcuts/i }));
    expect(screen.queryByText('Rules view')).toBeNull();
  });
});
