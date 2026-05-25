import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ShortcutHint } from '../ShortcutHint';
import styles from '../ShortcutHint.module.css';

describe('ShortcutHint', () => {
  it('renders the trigger button at desktop viewport (regression)', () => {
    render(<ShortcutHint />);
    expect(screen.getByRole('button', { name: /keyboard shortcuts/i })).toBeDefined();
  });

  it('container uses the CSS class that hides at mobile via media query', () => {
    const { container } = render(<ShortcutHint />);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain(styles.container);
  });
});
