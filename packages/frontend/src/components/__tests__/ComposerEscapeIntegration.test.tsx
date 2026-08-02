import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Composer } from '../Composer';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';

// Wires the real useKeyboardShortcuts hook to a dismiss ladder that mirrors
// App.tsx's: navigate away via history.back() unless the Escape originated
// from a text field, in which case the draft must be left alone.
function Harness() {
  useKeyboardShortcuts({
    onOpenDispatch: () => {},
    onDismiss: (fromInputField) => {
      if (!fromInputField) {
        window.history.back();
      }
    },
    onSelectNext: () => {},
    onSelectPrev: () => {},
    onConfirmSelection: () => {},
    onSwitchView: () => {},
    onFocusSearch: () => {},
  });

  return <Composer sessionId="sess-1" send={vi.fn()} />;
}

describe('Composer + useKeyboardShortcuts integration — Escape', () => {
  beforeEach(() => {
    vi.spyOn(window.history, 'back').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('typing a draft and pressing Escape leaves the draft intact and does not navigate away', () => {
    render(<Harness />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'work in progress' } });
    expect(textarea.value).toBe('work in progress');

    fireEvent.keyDown(textarea, { key: 'Escape', bubbles: true });

    expect(textarea.value).toBe('work in progress');
    expect(window.history.back).not.toHaveBeenCalled();
  });

  it('pressing Escape outside the composer still navigates away', () => {
    render(<Harness />);

    fireEvent.keyDown(document.body, { key: 'Escape', bubbles: true });

    expect(window.history.back).toHaveBeenCalledTimes(1);
  });
});
