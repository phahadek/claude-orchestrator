import { useEffect, useRef, useCallback } from 'react';

export type NavState =
  | { type: 'task'; id: string }
  | { type: 'session'; id: string }
  | { type: 'sessionOverlay'; taskId: string };

interface Handlers {
  setSelectedTaskId: (id: string | null) => void;
  setSelectedId: (id: string | null) => void;
  setSessionOverlayOpen: (open: boolean) => void;
}

export function useNavigationHistory(handlers: Handlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    function onPopState(event: PopStateEvent) {
      const state = event.state as NavState | null;
      if (!state?.type) {
        handlersRef.current.setSelectedTaskId(null);
        handlersRef.current.setSelectedId(null);
        handlersRef.current.setSessionOverlayOpen(false);
        return;
      }
      switch (state.type) {
        case 'task':
          handlersRef.current.setSelectedTaskId(state.id);
          handlersRef.current.setSelectedId(null);
          handlersRef.current.setSessionOverlayOpen(false);
          break;
        case 'session':
          handlersRef.current.setSelectedId(state.id);
          handlersRef.current.setSelectedTaskId(null);
          handlersRef.current.setSessionOverlayOpen(false);
          break;
        case 'sessionOverlay':
          handlersRef.current.setSelectedTaskId(state.taskId);
          handlersRef.current.setSelectedId(null);
          handlersRef.current.setSessionOverlayOpen(true);
          break;
      }
    }

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const pushView = useCallback((state: NavState) => {
    window.history.pushState(state, '');
  }, []);

  const popView = useCallback(() => {
    window.history.back();
  }, []);

  return { pushView, popView };
}
