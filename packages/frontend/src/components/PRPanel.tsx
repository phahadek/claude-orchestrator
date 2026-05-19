import { useState, useEffect, useCallback, useRef } from 'react';
import { PRCard } from './PRCard';
import type { PRListItem, PRReviewResult } from './PRCard';
import { ErrorBoundary } from './ErrorBoundary';
import styles from './PRPanel.module.css';

interface Props {
  activeProjectId: string | null;
  onViewSession?: (sessionId: string) => void;
  onCollapse?: () => void;
  refreshTrigger?: number;
  prReviewEvent?: { prNumber: number; verdict: string; summary: string } | null;
}

export function PRPanel({ activeProjectId, onViewSession, onCollapse, refreshTrigger, prReviewEvent }: Props) {
  const [prs, setPRs] = useState<PRListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [networkError, setNetworkError] = useState(false);
  const [noRepo, setNoRepo] = useState(false);

  const [reviewInFlight, setReviewInFlight] = useState<Set<number>>(new Set());
  const [reviewElapsed, setReviewElapsed] = useState<Map<number, number>>(new Map());
  const [mergeInFlight, setMergeInFlight] = useState<Set<number>>(new Set());
  const [checkingMergeability, setCheckingMergeability] = useState<Set<number>>(new Set());
  const [reReviewInFlight, setReReviewInFlight] = useState<Set<number>>(new Set());
  const [fixConflictsInFlight, setFixConflictsInFlight] = useState<Set<number>>(new Set());
  const [approveInFlight, setApproveInFlight] = useState<Set<number>>(new Set());
  const [removeInFlight, setRemoveInFlight] = useState<Set<number>>(new Set());
  const [clearInFlight, setClearInFlight] = useState(false);
  const [clearableCount, setClearableCount] = useState(0);
  const [cardErrors, setCardErrors] = useState<Map<number, string>>(new Map());

  const elapsedTimers = useRef<Map<number, ReturnType<typeof setInterval>>>(new Map());
  const isInitialLoad = useRef(true);

  const fetchPRs = useCallback(async () => {
    if (!activeProjectId) return;
    if (isInitialLoad.current) setIsLoading(true);
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
    } finally {
      isInitialLoad.current = false;
      setIsLoading(false);
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

  useEffect(() => {
    if (!prReviewEvent) return;
    setPRs((prev) =>
      prev.map((pr) =>
        pr.prNumber === prReviewEvent.prNumber
          ? {
              ...pr,
              reviewResult: { verdict: prReviewEvent.verdict as PRReviewResult['verdict'], summary: prReviewEvent.summary },
              reviewedAt: new Date().toISOString(),
            }
          : pr,
      ),
    );
  }, [prReviewEvent]);

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
    const pr = prs.find((p) => p.prNumber === prNumber);
    if (!pr) return;
    const [owner, repoName] = pr.repo.split('/');
    setError(prNumber, null);
    // Pre-merge mergeability check: ask the backend to query GitHub (with retry)
    // right before opening the merge. Shows a "checking mergeability..." state
    // so the user gets immediate feedback instead of an opaque merge failure.
    setCheckingMergeability((prev) => new Set(prev).add(prNumber));
    try {
      const checkRes = await fetch(
        `/api/prs/${owner}/${repoName}/${prNumber}/mergeability`,
      );
      if (checkRes.ok) {
        const { mergeable } = await checkRes.json() as { mergeable: boolean | null; mergeState: string | null };
        if (mergeable === false) {
          setError(prNumber, 'PR has merge conflicts — use Fix Conflicts to have the code session rebase.');
          await fetchPRs();
          return;
        }
        // mergeable === null after retries: proceed and let the merge endpoint handle it
      }
    } catch {
      // Pre-check is best-effort; fall through to the actual merge call
    } finally {
      setCheckingMergeability((prev) => {
        const next = new Set(prev);
        next.delete(prNumber);
        return next;
      });
    }
    setMergeInFlight((prev) => new Set(prev).add(prNumber));
    try {
      const res = await fetch(
        `/api/prs/${owner}/${repoName}/${prNumber}/merge`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
        let errorMsg = body.error ?? 'Unknown error';
        try { errorMsg = (JSON.parse(errorMsg) as { message?: string }).message ?? errorMsg; } catch { /* not JSON */ }
        setError(prNumber, `Merge failed: ${errorMsg}`);
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

  const handleReReview = async (prNumber: number) => {
    const pr = prs.find((p) => p.prNumber === prNumber);
    if (!pr) return;
    const [owner, repoName] = pr.repo.split('/');
    setReReviewInFlight((prev) => new Set(prev).add(prNumber));
    setError(prNumber, null);
    try {
      const res = await fetch(
        `/api/prs/${owner}/${repoName}/${prNumber}/re-review`,
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

  const handleFixConflicts = async (prNumber: number) => {
    const pr = prs.find((p) => p.prNumber === prNumber);
    if (!pr) return;
    const [owner, repoName] = pr.repo.split('/');
    setFixConflictsInFlight((prev) => new Set(prev).add(prNumber));
    setError(prNumber, null);
    try {
      const res = await fetch(
        `/api/prs/${owner}/${repoName}/${prNumber}/fix-conflicts`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
        setError(prNumber, `Fix conflicts failed: ${body.error ?? 'Unknown error'}`);
        return;
      }
      await fetchPRs();
    } catch {
      setError(prNumber, 'Fix conflicts failed: network error');
    } finally {
      setFixConflictsInFlight((prev) => {
        const next = new Set(prev);
        next.delete(prNumber);
        return next;
      });
    }
  };

  const handleApprove = async (prNumber: number) => {
    const pr = prs.find((p) => p.prNumber === prNumber);
    if (!pr) return;
    const [owner, repoName] = pr.repo.split('/');
    setApproveInFlight((prev) => new Set(prev).add(prNumber));
    setError(prNumber, null);
    try {
      const res = await fetch(
        `/api/prs/${owner}/${repoName}/${prNumber}/approve`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
        setError(prNumber, `Approve failed: ${body.error ?? 'Unknown error'}`);
        return;
      }
      await fetchPRs();
    } catch {
      setError(prNumber, 'Approve failed: network error');
    } finally {
      setApproveInFlight((prev) => {
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

      {!noRepo && isLoading && prs.length === 0 && (
        <div className={styles.loadingState}>Loading PRs…</div>
      )}

      {!noRepo && !isLoading && (prs.length === 0 && !networkError ? (
        <div className={styles.emptyState}>No open pull requests.</div>
      ) : (
        <div className={styles.prList}>
          {prs.map((pr) => (
            <ErrorBoundary
              key={pr.prNumber}
              name={`PRCard:${pr.prNumber}`}
              fallback={(_error, reset) => (
                <div className={styles.cardError} role="alert">
                  <span>PR card failed to render</span>
                  <button type="button" onClick={reset}>Retry</button>
                </div>
              )}
            >
              <PRCard
                pr={pr}
                onReview={handleReview}
                onMerge={handleMerge}
                onRemove={handleRemovePR}
                onViewSession={onViewSession}
                onReReview={handleReReview}
                onFixConflicts={handleFixConflicts}
                onApprove={handleApprove}
                reviewInFlight={reviewInFlight.has(pr.prNumber)}
                mergeInFlight={mergeInFlight.has(pr.prNumber)}
                checkingMergeability={checkingMergeability.has(pr.prNumber)}
                removeInFlight={removeInFlight.has(pr.prNumber)}
                reReviewInFlight={reReviewInFlight.has(pr.prNumber)}
                fixConflictsInFlight={fixConflictsInFlight.has(pr.prNumber)}
                approveInFlight={approveInFlight.has(pr.prNumber)}
                reviewElapsed={reviewElapsed.get(pr.prNumber) ?? 0}
                error={cardErrors.get(pr.prNumber) ?? null}
              />
            </ErrorBoundary>
          ))}
        </div>
      ))}
    </div>
  );
}
