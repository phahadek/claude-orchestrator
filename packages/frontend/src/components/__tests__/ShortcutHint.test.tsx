import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { ShortcutHint } from '../ShortcutHint';
import type { PanelKeyboardDeclaration } from '../../types/panelKeyboard';

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    writable: true,
    configurable: true,
    value: width,
  });
  window.dispatchEvent(new Event('resize'));
}

const panelDeclaration: PanelKeyboardDeclaration = {
  orderedItems: () => [],
  hints: [
    { key: 'j', description: 'Next decision' },
    { key: 'k', description: 'Previous decision' },
    { key: 'a', description: 'Approve highlighted card' },
    { key: 'r', description: 'Focus reason field' },
  ],
};

describe('ShortcutHint', () => {
  afterEach(() => {
    setViewportWidth(1024);
  });

  it('renders the trigger button', () => {
    render(<ShortcutHint />);
    expect(
      screen.getByRole('button', { name: /keyboard shortcuts/i }),
    ).toBeDefined();
  });

  it('renders the active panel hints plus the fixed global bindings, including Focus Search when the view has a search target', () => {
    render(<ShortcutHint activePanel={panelDeclaration} canFocusSearch />);
    fireEvent.click(
      screen.getByRole('button', { name: /keyboard shortcuts/i }),
    );

    const dialog = screen.getByRole('dialog');

    for (const { key, description } of panelDeclaration.hints) {
      expect(
        screen.getByText(key, { selector: 'kbd', exact: true }),
      ).toBeDefined();
      expect(screen.getByText(description)).toBeDefined();
    }

    // Fixed global bindings.
    expect(screen.getByText('Close modal / panel')).toBeDefined();
    expect(screen.getByText('Focus search')).toBeDefined();

    // Panel-scoped J/K/Enter should not be duplicated by a stale global entry.
    expect(screen.queryByText('Next session')).toBeNull();

    expect(dialog).toBeDefined();
  });

  it('omits panel hints when no panel is active', () => {
    render(<ShortcutHint activePanel={null} canFocusSearch />);
    fireEvent.click(
      screen.getByRole('button', { name: /keyboard shortcuts/i }),
    );
    expect(screen.queryByText('Approve highlighted card')).toBeNull();
    expect(screen.getByText('Close modal / panel')).toBeDefined();
  });

  it('omits the Focus Search hint when the active view mounts no search input (e.g. Milestones)', () => {
    render(
      <ShortcutHint activePanel={panelDeclaration} canFocusSearch={false} />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: /keyboard shortcuts/i }),
    );
    expect(screen.queryByText('Focus search')).toBeNull();
    // Everything else is still advertised.
    expect(screen.getByText('Close modal / panel')).toBeDefined();
  });

  it('opens on "?" and closes on Escape at a desktop viewport width', () => {
    setViewportWidth(1280);
    render(<ShortcutHint />);

    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(window, { key: '?' });
    expect(screen.getByRole('dialog')).toBeDefined();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens on "?" and closes on Escape at a mobile viewport width', () => {
    setViewportWidth(375);
    render(<ShortcutHint />);

    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(window, { key: '?' });
    expect(screen.getByRole('dialog')).toBeDefined();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
