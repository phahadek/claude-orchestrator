import { useState, useEffect, useCallback, useRef } from 'react';
import { authedFetch } from '../api/projects';
import { WorkItemCard } from './WorkItemCard';
import type {
  WorkItemListItem,
  PRWorkItem,
  PRReviewResult,
} from './WorkItemCard';
import { PRHistoryRow } from './PRHistoryRow';
import { ErrorBoundary } from './ErrorBoundary';
import { PipelineStageBadge } from './CIBadges';
import styles from './PRPanel.module.css';

interface Props {
  activeProjectId: string | null;
  onViewSession?: (sessionId: string) => void;
  onCollapse?: () => void;
  refreshTrigger?: number;
  prReviewEvent?: { prNumber: number; verdict: string; summary: string } | null;
  prMergedEvent?: { prNumber: number; repo: string; sha: string } | null;
  prClosedEvent?: { prNumber: number; repo: string } | null;
  prStateChangedEvent?: {
    prNumber: number;
    repo: string;
    mergeable: boolean | null;
    mergeState: string | null;
  } | null;
  prMergeabilityChangedEvent?: {
    prNumber: number;
    repo: string;
    mergeable: boolean | null;
    mergeState: string | null;
  } | null;
  autofixEvent?: {
    type: 'autofix_started' | 'autofix_complete';
    prNumber: number;
    success?: boolean;
    summary?: string;
    receivedAt: number;
  } | null;
  reviewStartedEvent?: {
    prNumber: number;
    sessionId: string;
    receivedAt: number;
  } | null;
  /** Live pipeline stage per PR number, driven by WS events from useSessionStore */
  prPipelineStages?: Map<number, string | null>;
  /** Failed command per PR number for blocked stage hover tooltip */
  prPipelineFailedCommands?: Map<number, string | undefined>;
}

export function PRPanel({
  activeProjectId,
  onViewSession,
  onCollapse,
  refreshTrigger,
  prReviewEvent,
  prMergedEvent,
  prClosedEvent,
  prStateChangedEvent,
  prMergeabilityChangedEvent,
  autofixEvent,
  reviewStartedEvent,
  prPipelineStages,
  prPipelineFailedCommands,
}: Props) {
  const [prs, setPRs] = useState<WorkItemListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [networkError, setNetworkError] = useState(false);
  const [noRepo, setNoRepo] = useState(false);
  /** Local pipeline stage overrides: seeded from REST data, then updated by WS events */
  const [localPipelineStages, setLocalPipelineStages] = useState<
    Map<number, string | null>
  >(new Map());
  const [localFailedCommands, setLocalFailedCommands] = useState<
    Map<number, string | undefined>
  >(new Map());

  const [reviewInFlight, setReviewInFlight] = useState<Set<number>>(new Set());
  const [reviewElapsed, setReviewElapsed] = useState<Map<number, number>>(
    new Map(),
  );
  const [mergeInFlight, setMergeInFlight] = useState<Set<number>>(new Set());
  const [checkingMergeability, setCheckingMergeability] = useState<Set<number>>(
    new Set(),
  );
  const [reReviewInFlight, setReReviewInFlight] = useState<Set<number>>(
    new Set(),
  );
  const [fixConflictsInFlight, setFixConflictsInFlight] = useState<Set<number>>(
    new Set(),
  );
  const [approveInFlight, setApproveInFlight] = useState<Set<number>>(
    new Set(),
  );
  const [removeInFlight, setRemoveInFlight] = useState<Set<number>>(new Set());
  const [cardErrors, setCardErrors] = useState<Map<number, string>>(new Map());
  const [autofixStatus, setAutofixStatus] = useState<
    Map<number, 'running' | 'done' | 'failed'>
  >(new Map());

  const elapsedTimers = useRef<Map<number, ReturnType<typeof setInterval>>>(
    new Map(),
  );
  const isInitialLoad = useRef(true);

  const fetchPRs = useCallback(async () => {
    if (!activeProjectId) return;
    if (isInitialLoad.current) setIsLoading(true);
    try {
      const prsRes = await authedFetch(
        `/api/prs?projectId=${encodeURIComponent(activeProjectId)}`,
      );
      if (prsRes.status === 422) {
        setNoRepo(true);
        return;
      }
      if (!prsRes.ok) {
        setNetworkError(true);
        return;
      }
      const data = (await prsRes.json()) as WorkItemListItem[];
      setPRs(data);
      // Seed pipeline stages from REST data for initial-state hydration
      setLocalPipelineStages((prev) => {
        const next = new Map(prev);
        for (const item of data) {
          if (item.type === 'pr' && 'preReviewStage' in item) {
            const stage = (item as PRWorkItem).preReviewStage ?? null;
            if (!next.has(item.prNumber)) {
              next.set(item.prNumber, stage);
            }
          }
        }
        return next;
      });
      setNetworkError(false);
      setNoRepo(false);
    } catch {
      setNetworkError(true);
    } finally {
      isInitialLoad.current = false;
      setIsLoading(false);
    }
  }, [activeProjectId]);

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
      setReviewElapsed((prev) =>
        new Map(prev).set(prNumber, (prev.get(prNumber) ?? 0) + 1),
      );
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

  // Merge WS-driven pipeline stages from store into local map
  useEffect(() => {
    if (!prPipelineStages || prPipelineStages.size === 0) return;
    setLocalPipelineStages((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [prNumber, stage] of prPipelineStages) {
        if (next.get(prNumber) !== stage) {
          next.set(prNumber, stage);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [prPipelineStages]);

  // Merge WS-driven failed commands from store into local map
  useEffect(() => {
    if (!prPipelineFailedCommands || prPipelineFailedCommands.size === 0)
      return;
    setLocalFailedCommands((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [prNumber, cmd] of prPipelineFailedCommands) {
        if (next.get(prNumber) !== cmd) {
          next.set(prNumber, cmd);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [prPipelineFailedCommands]);

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
      prev.map((item) =>
        item.type === 'pr' && item.prNumber === prReviewEvent.prNumber
          ? {
              ...item,
              reviewResult: {
                verdict: prReviewEvent.verdict as PRReviewResult['verdict'],
                summary: prReviewEvent.summary,
              },
              reviewedAt: new Date().toISOString(),
            }
          : item,
      ),
    );
    setReviewInFlight((prev) => {
      const next = new Set(prev);
      next.delete(prReviewEvent.prNumber);
      return next;
    });
    stopElapsed(prReviewEvent.prNumber);
    setAutofixStatus((prev) => {
      const next = new Map(prev);
      next.delete(prReviewEvent.prNumber);
      return next;
    });
  }, [prReviewEvent]);

  useEffect(() => {
    if (!prMergedEvent) return;
    setMergeInFlight((prev) => {
      const next = new Set(prev);
      next.delete(prMergedEvent.prNumber);
      return next;
    });
  }, [prMergedEvent]);

  useEffect(() => {
    if (!prClosedEvent) return;
    setRemoveInFlight((prev) => {
      const next = new Set(prev);
      next.delete(prClosedEvent.prNumber);
      return next;
    });
  }, [prClosedEvent]);

  useEffect(() => {
    if (!prStateChangedEvent) return;
    setApproveInFlight((prev) => {
      const next = new Set(prev);
      next.delete(prStateChangedEvent.prNumber);
      return next;
    });
    setFixConflictsInFlight((prev) => {
      const next = new Set(prev);
      next.delete(prStateChangedEvent.prNumber);
      return next;
    });
  }, [prStateChangedEvent]);

  useEffect(() => {
    if (!prMergeabilityChangedEvent) return;
    setCheckingMergeability((prev) => {
      const next = new Set(prev);
      next.delete(prMergeabilityChangedEvent.prNumber);
      return next;
    });
  }, [prMergeabilityChangedEvent]);

  useEffect(() => {
    if (!autofixEvent) return;
    setAutofixStatus((prev) => {
      const next = new Map(prev);
      if (autofixEvent.type === 'autofix_started') {
        next.set(autofixEvent.prNumber, 'running');
      } else {
        next.set(
          autofixEvent.prNumber,
          autofixEvent.success ? 'done' : 'failed',
        );
      }
      return next;
    });
  }, [autofixEvent]);

  useEffect(() => {
    if (!reviewStartedEvent) return;
    setReviewInFlight((prev) => new Set(prev).add(reviewStartedEvent.prNumber));
    startElapsed(reviewStartedEvent.prNumber);
  }, [reviewStartedEvent]);

  const handleReview = async (prNumber: number) => {
    if (!activeProjectId) return;
    setReviewInFlight((prev) => new Set(prev).add(prNumber));
    setError(prNumber, null);
    startElapsed(prNumber);
    try {
      const res = await authedFetch(
        `/api/prs/${prNumber}/review?projectId=${encodeURIComponent(activeProjectId)}`,
        { method: 'POST' },
      );
      if (res.status === 504) {
        setError(prNumber, 'Review timed out — try again.');
        return;
      }
      if (!res.ok) {
        const body = (await res
          .json()
          .catch(() => ({ error: 'Unknown error' }))) as { error?: string };
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
    const item = prs.find((p) => p.type === 'pr' && p.prNumber === prNumber);
    if (!item || item.type !== 'pr') return;
    const [owner, repoName] = item.repo.split('/');
    setError(prNumber, null);
    // Pre-merge mergeability check: ask the backend to query GitHub (with retry)
    // right before opening the merge. Shows a "checking mergeability..." state
    // so the user gets immediate feedback instead of an opaque merge failure.
    setCheckingMergeability((prev) => new Set(prev).add(prNumber));
    try {
      const checkRes = await authedFetch(
        `/api/prs/${owner}/${repoName}/${prNumber}/mergeability`,
      );
      if (checkRes.ok) {
        const { mergeable } = (await checkRes.json()) as {
          mergeable: boolean | null;
          mergeState: string | null;
        };
        if (mergeable === false) {
          setError(
            prNumber,
            'PR has merge conflicts — use Fix Conflicts to have the code session rebase.',
          );
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
      const res = await authedFetch(
        `/api/prs/${owner}/${repoName}/${prNumber}/merge`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = (await res
          .json()
          .catch(() => ({ error: 'Unknown error' }))) as { error?: string };
        let errorMsg = body.error ?? 'Unknown error';
        try {
          errorMsg =
            (JSON.parse(errorMsg) as { message?: string }).message ?? errorMsg;
        } catch {
          /* not JSON */
        }
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
    const item = prs.find((p) => p.type === 'pr' && p.prNumber === prNumber);
    if (!item || item.type !== 'pr') return;
    const [owner, repoName] = item.repo.split('/');
    setReReviewInFlight((prev) => new Set(prev).add(prNumber));
    setError(prNumber, null);
    try {
      const res = await authedFetch(
        `/api/prs/${owner}/${repoName}/${prNumber}/re-review`,
        { method: 'POST' },
      );
      if (res.status === 504) {
        setError(prNumber, 'Re-review timed out — try again.');
        return;
      }
      if (!res.ok) {
        const body = (await res
          .json()
          .catch(() => ({ error: 'Unknown error' }))) as { error?: string };
        setError(
          prNumber,
          `Re-review failed: ${body.error ?? 'Unknown error'}`,
        );
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
    const item = prs.find((p) => p.type === 'pr' && p.prNumber === prNumber);
    if (!item || item.type !== 'pr') return;
    const [owner, repoName] = item.repo.split('/');
    setFixConflictsInFlight((prev) => new Set(prev).add(prNumber));
    setError(prNumber, null);
    try {
      const res = await authedFetch(
        `/api/prs/${owner}/${repoName}/${prNumber}/fix-conflicts`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = (await res
          .json()
          .catch(() => ({ error: 'Unknown error' }))) as { error?: string };
        setError(
          prNumber,
          `Fix conflicts failed: ${body.error ?? 'Unknown error'}`,
        );
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
    const item = prs.find((p) => p.type === 'pr' && p.prNumber === prNumber);
    if (!item || item.type !== 'pr') return;
    const [owner, repoName] = item.repo.split('/');
    setApproveInFlight((prev) => new Set(prev).add(prNumber));
    setError(prNumber, null);
    try {
      const res = await authedFetch(
        `/api/prs/${owner}/${repoName}/${prNumber}/approve`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = (await res
          .json()
          .catch(() => ({ error: 'Unknown error' }))) as { error?: string };
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
      const res = await authedFetch(
        `/api/prs/${prNumber}?projectId=${encodeURIComponent(activeProjectId)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const body = (await res
          .json()
          .catch(() => ({ error: 'Unknown error' }))) as { error?: string };
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

  return (
    <div className={styles.panel}>
      <div className={styles.headerBar}>
        <span className={styles.panelTitle}>Open Pull Requests</span>
        <div className={styles.headerButtons}>
          <button
            type="button"
            className={styles.refreshButton}
            onClick={fetchPRs}
          >
            ↻ Refresh
          </button>
          {onCollapse && (
            <button
              type="button"
              className={styles.collapseButton}
              onClick={onCollapse}
              title="Collapse PR panel"
            >
              ✕
            </button>
          )}
        </div>
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

      {!noRepo &&
        !isLoading &&
        (prs.length === 0 && !networkError ? (
          <div className={styles.emptyState}>No open pull requests.</div>
        ) : (
          <div className={styles.prList}>
            {prs.map((item) => {
              const itemKey =
                item.type === 'pr'
                  ? `pr-${item.prNumber}`
                  : `local-${item.sessionId}`;
              const prNumber = item.type === 'pr' ? item.prNumber : 0;

              // Terminal PRs always render as compact rows
              const useCompact =
                item.type === 'pr' &&
                (item.state === 'merged' || item.state === 'closed');

              if (useCompact) {
                return (
                  <PRHistoryRow
                    key={itemKey}
                    pr={item as PRWorkItem}
                    onViewSession={onViewSession}
                  />
                );
              }

              return (
                <ErrorBoundary
                  key={itemKey}
                  name={`WorkItemCard:${itemKey}`}
                  fallback={(_error, reset) => (
                    <div className={styles.cardError} role="alert">
                      <span>PR card failed to render</span>
                      <button type="button" onClick={reset}>
                        Retry
                      </button>
                    </div>
                  )}
                >
                  {autofixStatus.get(prNumber) === 'running' && (
                    <div className={styles.autofixBadge}>
                      ⚙ Autofix running…
                    </div>
                  )}
                  {autofixStatus.get(prNumber) === 'done' && (
                    <div
                      className={`${styles.autofixBadge} ${styles.autofixDone}`}
                    >
                      ✓ Autofix applied
                    </div>
                  )}
                  {autofixStatus.get(prNumber) === 'failed' && (
                    <div
                      className={`${styles.autofixBadge} ${styles.autofixFailed}`}
                    >
                      ⚠ Autofix failed (proceeding)
                    </div>
                  )}
                  {localPipelineStages.get(prNumber) && (
                    <div className={styles.pipelineBadgeRow}>
                      <PipelineStageBadge
                        stage={localPipelineStages.get(prNumber) ?? null}
                        prState={item.type === 'pr' ? item.state : undefined}
                        failedCommand={localFailedCommands.get(prNumber)}
                      />
                    </div>
                  )}
                  <WorkItemCard
                    item={item}
                    onReview={handleReview}
                    onMerge={handleMerge}
                    onRemove={handleRemovePR}
                    onViewSession={onViewSession}
                    onReReview={handleReReview}
                    onFixConflicts={handleFixConflicts}
                    onApprove={handleApprove}
                    reviewInFlight={reviewInFlight.has(prNumber)}
                    mergeInFlight={mergeInFlight.has(prNumber)}
                    checkingMergeability={checkingMergeability.has(prNumber)}
                    removeInFlight={removeInFlight.has(prNumber)}
                    reReviewInFlight={reReviewInFlight.has(prNumber)}
                    fixConflictsInFlight={fixConflictsInFlight.has(prNumber)}
                    approveInFlight={approveInFlight.has(prNumber)}
                    reviewElapsed={reviewElapsed.get(prNumber) ?? 0}
                    error={cardErrors.get(prNumber) ?? null}
                  />
                </ErrorBoundary>
              );
            })}
          </div>
        ))}
    </div>
  );
}
