import { useEffect, useRef, useCallback } from 'react';
import type { ServerMessage, ClientMessage } from '@claude-dashboard/backend/src/ws/types';

export function useWebSocket(onMessage: (msg: ServerMessage) => void) {
  const ws = useRef<WebSocket | null>(null);
  const reconnectDelay = useRef(1000);
  // Stable ref so connect closure doesn't capture a stale onMessage
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

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
