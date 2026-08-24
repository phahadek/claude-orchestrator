import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../api/projects';

const POLL_INTERVAL_MS = 30000;

export type Tier3ClassifierErrorKind = 'errored' | 'usage_limited';

export interface Tier3ClassifierErrorRateEntry {
  project: string;
  kind: Tier3ClassifierErrorKind;
  windowSeconds: number;
  total: number;
  matched: number;
  rate: number | null;
  threshold: number;
  chronic: boolean;
}

export interface UseTier3ErrorRateResult {
  rates: Tier3ClassifierErrorRateEntry[];
  loading: boolean;
  error: string | null;
}

/**
 * REST-polls the Tier-3 classifier chronic-error-rate signal — mirrors
 * useProjectTestRuns's poll shape. Project-scoped only, no invalidation bus:
 * this signal has no push event of its own, so a plain interval is enough.
 */
export function useTier3ErrorRate(
  projectId: string | null,
): UseTier3ErrorRateResult {
  const [rates, setRates] = useState<Tier3ClassifierErrorRateEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const fetchRates = useCallback(() => {
    if (!projectId) {
      setRates([]);
      setError(null);
      setLoading(false);
      return;
    }
    const requestId = ++requestIdRef.current;
    setLoading(true);
    apiRequest<Tier3ClassifierErrorRateEntry[]>(
      `/api/gate/tier3-error-rate?project=${encodeURIComponent(projectId)}`,
    )
      .then((data) => {
        if (requestIdRef.current !== requestId) return;
        setRates(data);
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
  }, [projectId]);

  useEffect(() => {
    fetchRates();
  }, [fetchRates]);

  useEffect(() => {
    const interval = setInterval(fetchRates, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchRates]);

  return { rates, loading, error };
}
