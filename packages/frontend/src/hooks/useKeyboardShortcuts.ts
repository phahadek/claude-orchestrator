import { useEffect, useRef } from 'react';

export interface ShortcutHandlers {
  onOpenDispatch: () => void;
  onDismiss: () => void;
  onSelectNext: () => void;
  onSelectPrev: () => void;
  onConfirmSelection: () => void;
  onSwitchView: (view: 'sessions' | 'prs') => void;
  onFocusSearch: () => void;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const isInputField =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable);

      const h = handlersRef.current;

      // ESC fires even from input fields (e.g. to clear search and blur)
      if (event.key === 'Escape') {
        h.onDismiss();
        return;
      }

      if (isInputField) return;

      switch (event.key) {
        case 'n':
        case 'N':
          event.preventDefault();
          h.onOpenDispatch();
          break;
        case 'j':
        case 'J':
          event.preventDefault();
          h.onSelectNext();
          break;
        case 'k':
        case 'K':
          event.preventDefault();
          h.onSelectPrev();
          break;
        case 'Enter':
          h.onConfirmSelection();
          break;
        case '1':
          h.onSwitchView('sessions');
          break;
        case '2':
          h.onSwitchView('prs');
          break;
        case '/':
          event.preventDefault();
          h.onFocusSearch();
          break;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
