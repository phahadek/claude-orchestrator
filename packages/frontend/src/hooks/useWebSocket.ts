import { useEffect, useRef, useCallback, useState } from 'react';
import type {
  ServerMessage,
  ClientMessage,
} from '@claude-orchestrator/backend/src/ws/types';

export type ConnectionState = 'connected' | 'disconnected' | 'reconnecting';

export function useWebSocket(
  onMessage: (msg: ServerMessage) => void,
  onOpen?: (send: (msg: ClientMessage) => boolean) => void,
) {
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(1000);
  const disposed = useRef(false);
  const onMessageRef = useRef(onMessage);
  const onOpenRef = useRef(onOpen);
  const connectRef = useRef<() => void>(null);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('disconnected');

  useEffect(() => {
    onMessageRef.current = onMessage;
  });
  useEffect(() => {
    onOpenRef.current = onOpen;
  });

  const connect = useCallback(() => {
    if (disposed.current) return;

    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }

    if (ws.current) {
      ws.current.onclose = null;
      ws.current.onmessage = null;
      ws.current.onopen = null;
      ws.current.close();
      ws.current = null;
    }

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
      if (disposed.current) return;
      setConnectionState('reconnecting');
      reconnectTimer.current = setTimeout(() => {
        reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30_000);
        connectRef.current?.();
      }, reconnectDelay.current);
    };

    socket.onopen = () => {
      reconnectDelay.current = 1000;
      setConnectionState('connected');
      onOpenRef.current?.((msg) => {
        socket.send(JSON.stringify(msg));
        return true;
      });
    };
  }, []);

  useEffect(() => {
    connectRef.current = connect;
  });

  useEffect(() => {
    disposed.current = false;
    connect();
    return () => {
      disposed.current = true;
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      if (ws.current) {
        ws.current.onclose = null;
        ws.current.onmessage = null;
        ws.current.onopen = null;
        ws.current.close();
        ws.current = null;
      }
    };
  }, [connect]);

  const send = useCallback((msg: ClientMessage): boolean => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }, []);

  return { send, connectionState };
}
