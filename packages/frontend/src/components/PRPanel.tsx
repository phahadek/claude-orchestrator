import { useState, useEffect, useCallback, useRef } from 'react';
import { PRCard } from './PRCard';
import type { PRListItem } from './PRCard';
import styles from './PRPanel.module.css';

interface Props {
  activeProjectId: string | null;
  onFixSession: (sessionId: string) => void;
  onViewSession?: (sessionId: string) => void;
  onCollapse?: () => void;
  refreshTrigger?: number;
}

export function PRPanel({ activeProjectId, onFixSession, onViewSession, onCollapse, refreshTrigger }: Props) {
  const [prs, setPRs] = useState<PRListItem[]>([]);
  const [networkError, setNetworkError] = useState(false);
  const [noRepo, setNoRepo] = useState(false);

  const [reviewInFlight, setReviewInFlight] = useState<Set<number>>(new Set());
  const [reviewElapsed, setReviewElapsed] = useState<Map<number, number>>(new Map());
  const [mergeInFlight, setMergeInFlight] = useState<Set<number>>(new Set());
  const [fixInFlight, setFixInFlight] = useState<Set<number>>(new Set());
  const [reReviewInFlight, setReReviewInFlight] = useState<Set<number>>(new Set());
  const [removeInFlight, setRemoveInFlight] = useState<Set<number>>(new Set());
  const [clearInFlight, setClearInFlight] = useState(false);
  const [clearableCount, setClearableCount] = useState(0);
  const [cardErrors, setCardErrors] = useState<Map<number, string>>(new Map());

  const elapsedTimers = useRef<Map<number, ReturnType<typeof setInterval>>>(new Map());

  const fetchPRs = useCallback(async () => {
    if (!activeProjectId) return;
    try {
      const [prsRes, countRes] = await Promise.all([
        fetch(`/api/prs?projectId=${encodeURIComponent(activeProjectId)}`),
        fetch(`/api/prs/clear/count?projectId=${encodeURIComponent(activeProjectId)}`),
      ]);
      if (prsRes.status === 422) {
        setNoRepo(true);
        return;
      }
      if (!prsRes.ok) {
        setNetworkError(true);
        return;
      }
      const data = await prsRes.json() as PRListItem[];
      setPRs(data);
      setNetworkError(false);
      setNoRepo(false);
      if (countRes.ok) {
        const { count } = await countRes.json() as { count: number };
        setClearableCount(count);
      }
    } catch {
      setNetworkError(true);
    }
  }, [activeProjectId]);

  useEffect(() => {
    fetchPRs();
    const interval = setInterval(fetchPRs, 30_000);
    return () => clearInterval(interval);
  }, [fetchPRs, activeProjectId]);

  useEffect(() => {
    if (refreshTrigger) fetchPRs();
  }, [refreshTrigger, fetchPRs]);

  const setError = (prNumber: number, msg: string | null) => {
    setCardErrors((prev) => {
      const next = new Map(prev);
      if (msg === null) next.delete(prNumber);
      else next.set(prNumber, msg);
      return next;
    });
  };

  const startElapsed = (prNumber: number) => {
    setReviewElapsed((prev) => new Map(prev).set(prNumber, 0));
    const timer = setInterval(() => {
      setReviewElapsed((prev) => new Map(prev).set(prNumber, (prev.get(prNumber) ?? 0) + 1));
    }, 1000);
    elapsedTimers.current.set(prNumber, timer);
  };

  const stopElapsed = (prNumber: number) => {
    const timer = elapsedTimers.current.get(prNumber);
    if (timer !== undefined) {
      clearInterval(timer);
      elapsedTimers.current.delete(prNumber);
    }
    setReviewElapsed((prev) => {
      const next = new Map(prev);
      next.delete(prNumber);
      return next;
    });
  };

  const handleReview = async (prNumber: number) => {
    if (!activeProjectId) return;
    setReviewInFlight((prev) => new Set(prev).add(prNumber));
    setError(prNumber, null);
    startElapsed(prNumber);
    try {
      const res = await fetch(
        `/api/prs/${prNumber}/review?projectId=${encodeURIComponent(activeProjectId)}`,
        { method: 'POST' },
      );
      if (res.status === 504) {
        setError(prNumber, 'Review timed out — try again.');
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
        setError(prNumber, `Review failed: ${body.error ?? 'Unknown error'}`);
        return;
      }
      await fetchPRs();
    } catch {
      setError(prNumber, 'Review failed: network error');
    } finally {
      setReviewInFlight((prev) => {
        const next = new Set(prev);
        next.delete(prNumber);
        return next;
      });
      stopElapsed(prNumber);
    }
  };

  const handleMerge = async (prNumber: number) => {
    if (!activeProjectId) return;
    setMergeInFlight((prev) => new Set(prev).add(prNumber));
    setError(prNumber, null);
    try {
      const res = await fetch(
        `/api/prs/${prNumber}/merge?projectId=${encodeURIComponent(activeProjectId)}`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
        setError(prNumber, `Merge failed: ${body.error ?? 'Unknown error'}`);
        return;
      }
      await fetchPRs();
    } catch {
      setError(prNumber, 'Merge failed: network error');
    } finally {
      setMergeInFlight((prev) => {
        const next = new Set(prev);
        next.delete(prNumber);
        return next;
      });
    }
  };

  const handleFix = async (prNumber: number) => {
    if (!activeProjectId) return;
    setFixInFlight((prev) => new Set(prev).add(prNumber));
    setError(prNumber, null);
    try {
      const res = await fetch(
        `/api/prs/${prNumber}/fix?projectId=${encodeURIComponent(activeProjectId)}`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
        setError(prNumber, `Fix failed: ${body.error ?? 'Unknown error'}`);
        return;
      }
      const { sessionId } = await res.json() as { sessionId: string };
      onFixSession(sessionId);
    } catch {
      setError(prNumber, 'Fix failed: network error');
    } finally {
      setFixInFlight((prev) => {
        const next = new Set(prev);
        next.delete(prNumber);
        return next;
      });
    }
  };

  const handleReReview = async (prNumber: number) => {
    if (!activeProjectId) return;
    setReReviewInFlight((prev) => new Set(prev).add(prNumber));
    setError(prNumber, null);
    try {
      const res = await fetch(
        `/api/prs/${prNumber}/re-review?projectId=${encodeURIComponent(activeProjectId)}`,
        { method: 'POST' },
      );
      if (res.status === 504) {
        setError(prNumber, 'Re-review timed out — try again.');
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
        setError(prNumber, `Re-review failed: ${body.error ?? 'Unknown error'}`);
        return;
      }
      await fetchPRs();
    } catch {
      setError(prNumber, 'Re-review failed: network error');
    } finally {
      setReReviewInFlight((prev) => {
        const next = new Set(prev);
        next.delete(prNumber);
        return next;
      });
    }
  };

  const handleRemovePR = async (prNumber: number) => {
    if (!activeProjectId) return;
    setRemoveInFlight((prev) => new Set(prev).add(prNumber));
    setError(prNumber, null);
    try {
      const res = await fetch(
        `/api/prs/${prNumber}?projectId=${encodeURIComponent(activeProjectId)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
        setError(prNumber, `Remove failed: ${body.error ?? 'Unknown error'}`);
        return;
      }
      await fetchPRs();
    } catch {
      setError(prNumber, 'Remove failed: network error');
    } finally {
      setRemoveInFlight((prev) => {
        const next = new Set(prev);
        next.delete(prNumber);
        return next;
      });
    }
  };

  const handleClearMergedClosed = async () => {
    if (!activeProjectId) return;
    setClearInFlight(true);
    try {
      const res = await fetch(
        `/api/prs/clear?projectId=${encodeURIComponent(activeProjectId)}`,
        { method: 'DELETE' },
      );
      if (res.ok) {
        await fetchPRs();
      }
    } finally {
      setClearInFlight(false);
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.headerBar}>
        <span className={styles.panelTitle}>Open Pull Requests</span>
        {clearableCount > 0 && (
          <button
            type="button"
            className={styles.clearButton}
            onClick={handleClearMergedClosed}
            disabled={clearInFlight}
            title={`Remove ${clearableCount} merged/closed PR${clearableCount !== 1 ? 's' : ''}`}
          >
            {clearInFlight ? 'Clearing...' : `Clear merged/closed (${clearableCount})`}
          </button>
        )}
        <button type="button" className={styles.refreshButton} onClick={fetchPRs}>
          ↻ Refresh
        </button>
        {onCollapse && (
          <button type="button" className={styles.collapseButton} onClick={onCollapse} title="Collapse PR panel">
            ✕
          </button>
        )}
      </div>

      {noRepo && (
        <div className={styles.emptyState}>
          No GitHub repo configured for this project.
        </div>
      )}

      {!noRepo && networkError && (
        <div className={styles.networkBanner}>
          ⚠️ Could not reach server — retrying...
        </div>
      )}

      {!noRepo && (prs.length === 0 && !networkError ? (
        <div className={styles.emptyState}>No open pull requests.</div>
      ) : (
        <div className={styles.prList}>
          {prs.map((pr) => (
            <PRCard
              key={pr.prNumber}
              pr={pr}
              onReview={handleReview}
              onMerge={handleMerge}
              onFix={handleFix}
              onRemove={handleRemovePR}
              onViewSession={onViewSession}
              onReReview={handleReReview}
              reviewInFlight={reviewInFlight.has(pr.prNumber)}
              mergeInFlight={mergeInFlight.has(pr.prNumber)}
              fixInFlight={fixInFlight.has(pr.prNumber)}
              removeInFlight={removeInFlight.has(pr.prNumber)}
              reReviewInFlight={reReviewInFlight.has(pr.prNumber)}
              reviewElapsed={reviewElapsed.get(pr.prNumber) ?? 0}
              error={cardErrors.get(pr.prNumber) ?? null}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
