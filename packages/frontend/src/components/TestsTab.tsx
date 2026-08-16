import { useEffect, useState } from 'react';
import { apiRequest } from '../api/projects';
import styles from './TestsTab.module.css';

interface FlipRateFlag {
  testId: string;
  sampleCount: number;
  transitionCount: number;
  flagged: boolean;
}

interface TestResultEntry {
  testId: string;
  name: string;
  outcome: string;
  durationMs: number;
  flipRate: FlipRateFlag | null;
}

export type TestRunOutcome =
  | 'passed'
  | 'failed-with-named-tests'
  | 'failed-with-no-report-acquired'
  | 'crashed-oom'
  | 'timed-out'
  | 'running';

interface TestRunHistoryEntry {
  id: string;
  sessionId: string | null;
  contentHash: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  concurrentRunCount: number | null;
  outcome: TestRunOutcome;
  nextAction: string;
  testResults: TestResultEntry[];
}

interface TestRunHistoryResponse {
  cycleCount: number;
  cycleLimit: number;
  runs: TestRunHistoryEntry[];
}

const OUTCOME_LABELS: Record<TestRunOutcome, string> = {
  passed: 'Passed',
  'failed-with-named-tests': 'Failed',
  'failed-with-no-report-acquired': 'No report acquired',
  'crashed-oom': 'Crashed (OOM)',
  'timed-out': 'Timed out',
  running: 'Running…',
};

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimestamp(ms: number | null): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString();
}

interface Props {
  projectId: string | null | undefined;
  sessionId: string | null | undefined;
}

export function TestsTab({ projectId, sessionId }: Props) {
  const [data, setData] = useState<TestRunHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    if (!projectId || !sessionId) return;
    let cancelled = false;
    setLoading(true);
    apiRequest<TestRunHistoryResponse>(
      `/api/test-request-runs/history?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(sessionId)}`,
    )
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Network error');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, sessionId]);

  if (!projectId || !sessionId) {
    return (
      <div className={styles.container}>
        <p className={styles.emptyState}>
          No code session for this task yet.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.errorBanner}>
          Failed to load test runs: {error}
        </div>
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className={styles.container}>
        <p className={styles.emptyState}>Loading test runs…</p>
      </div>
    );
  }

  if (!data || data.runs.length === 0) {
    return (
      <div className={styles.container}>
        <p className={styles.emptyState} data-testid="tests-tab-empty">
          No test runs for this session yet.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.container} data-testid="tests-tab">
      <div className={styles.cycleCounter} data-testid="tests-tab-cycle-counter">
        {data.cycleCount} of {data.cycleLimit} test.request cycles used
      </div>
      <div className={styles.runList}>
        {data.runs.map((run) => (
          <div
            key={run.id}
            className={styles.runRow}
            data-testid={`test-run-${run.id}`}
          >
            <div className={styles.runHeader}>
              <span
                className={`${styles.outcomeBadge} ${styles[`outcome--${run.outcome}`]}`}
                data-testid={`test-run-outcome-${run.id}`}
              >
                {OUTCOME_LABELS[run.outcome]}
              </span>
              <span className={styles.runMeta}>
                {formatTimestamp(run.startedAt)} → {formatTimestamp(run.finishedAt)}
              </span>
              <span className={styles.runMeta}>
                {formatDuration(run.durationMs)}
              </span>
              {run.concurrentRunCount != null && run.concurrentRunCount > 0 && (
                <span className={styles.runMeta}>
                  {run.concurrentRunCount} concurrent run
                  {run.concurrentRunCount === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <div className={styles.nextAction}>{run.nextAction}</div>

            {run.outcome === 'failed-with-no-report-acquired' && (
              <p
                className={styles.noReportState}
                data-testid={`test-run-no-report-${run.id}`}
              >
                No per-test report was acquired for this run — the process
                likely crashed before any structured result was written.
              </p>
            )}

            {run.testResults.length > 0 && (
              <div className={styles.testList}>
                {run.testResults.map((t) => (
                  <div
                    key={t.testId}
                    className={styles.testRow}
                    data-testid={`test-result-${t.testId}`}
                  >
                    <span
                      className={`${styles.testOutcome} ${styles[`testOutcome--${t.outcome}`] ?? ''}`}
                    >
                      {t.outcome}
                    </span>
                    <span>{t.name}</span>
                    <span className={styles.runMeta}>
                      {formatDuration(t.durationMs)}
                    </span>
                    {t.flipRate?.flagged && (
                      <span
                        className={styles.flipRateBadge}
                        data-testid={`test-flip-rate-${t.testId}`}
                        title={`${t.flipRate.transitionCount} transitions over ${t.flipRate.sampleCount} samples`}
                      >
                        flaky
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
