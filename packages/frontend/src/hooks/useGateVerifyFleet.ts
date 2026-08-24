import { useCallback, useEffect, useRef, useState } from 'react';
import { gateApi, type GateVerifyFleetState } from '../api/gate';

const POLL_INTERVAL_MS = 30000;

export interface UseGateVerifyFleetResult {
  fleetState: GateVerifyFleetState | null;
  loading: boolean;
  error: string | null;
}

/**
 * REST-polls the cross-project gate-verify fleet snapshot (GET
 * /api/gate/fleet) and re-fetches on a caller-supplied invalidation event
 * (mirrors useMilestoneConvergence's poll-plus-invalidation-key shape) plus
 * a 30s poll backstop. No new WS message type — the caller composes
 * `invalidationKey` from the session_started/session_status/session_ended/
 * staged_intent_changed events already surfaced by useSessionStore.
 */
export function useGateVerifyFleet(
  invalidationKey?: unknown,
): UseGateVerifyFleetResult {
  const [fleetState, setFleetState] = useState<GateVerifyFleetState | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const fetchFleetState = useCallback(() => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    gateApi
      .getFleetState()
      .then((data) => {
        if (requestIdRef.current !== requestId) return;
        setFleetState(data);
        setError(null);
      })
      .catch((err) => {
        if (requestIdRef.current !== requestId) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (requestIdRef.current !== requestId) return;
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchFleetState();
  }, [fetchFleetState, invalidationKey]);

  useEffect(() => {
    const interval = setInterval(fetchFleetState, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchFleetState]);

  return { fleetState, loading, error };
}
