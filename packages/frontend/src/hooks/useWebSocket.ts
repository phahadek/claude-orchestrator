import { useEffect, useRef, useCallback } from 'react';
import type { ServerMessage, ClientMessage } from '@claude-dashboard/backend/src/ws/types';

export function useWebSocket(
  onMessage: (msg: ServerMessage) => void,
  onOpen?: (send: (msg: ClientMessage) => void) => void
) {
  const ws = useRef<WebSocket | null>(null);
  const reconnectDelay = useRef(1000);
  // Stable refs so connect closure doesn't capture stale callbacks
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  const connect = useCallback(() => {
    const socket = new WebSocket(`ws://${window.location.host}/ws`);
    ws.current = socket;

    socket.onmessage = (e) => {
      try {
        onMessageRef.current(JSON.parse(e.data) as ServerMessage);
      } catch {
        /* ignore malformed frames */
      }
    };

    socket.onclose = () => {
      setTimeout(() => {
        reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30_000);
        connect();
      }, reconnectDelay.current);
    };

    socket.onopen = () => {
      reconnectDelay.current = 1000;
      onOpenRef.current?.((msg) => socket.send(JSON.stringify(msg)));
    };
  }, []);

  useEffect(() => {
    connect();
    return () => ws.current?.close();
  }, [connect]);

  const send = useCallback((msg: ClientMessage) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(msg));
    }
  }, []);

  return { send };
}
