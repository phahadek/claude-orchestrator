import { useEffect, useState } from 'react';
import { apiRequest } from '../api/projects';
import { cancelTestRun } from '../hooks/useProjectTestRuns';
import { subscribeToTestRequestRunStatus } from '../hooks/testRequestRunStatusBus';
import { TestHistoryView } from './TestHistoryView';
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

type TestRunOutcome =
  | 'passed'
  | 'passed-scoped'
  | 'passed-targeted'
  | 'failed-with-named-tests'
  | 'failed-with-no-report-acquired'
  | 'crashed-oom'
  | 'timed-out'
  | 'running'
  | 'queued'
  | 'cancelled';

interface TestRunHistoryEntry {
  id: string;
  sessionId: string | null;
  runKind: string;
  isPrPipelineRun: boolean;
  contentHash: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  concurrentRunCount: number | null;
  outcome: TestRunOutcome;
  failureReason?: string | null;
  cancelledBy?: string | null;
  nextAction: string;
  nothing_exercised?: boolean;
  unclaimed_paths?: string | null;
  testResults: TestResultEntry[];
  testResultsTruncated: boolean;
  totalTestResultCount: number;
}

interface TestRunHistoryResponse {
  cycleCount: number;
  cycleLimit: number;
  runs: TestRunHistoryEntry[];
}

const OUTCOME_LABELS: Record<TestRunOutcome, string> = {
  passed: 'Passed',
  'passed-scoped': 'Passed (scoped)',
  'passed-targeted': 'Passed (targeted)',
  'failed-with-named-tests': 'Failed',
  'failed-with-no-report-acquired': 'No report acquired',
  'crashed-oom': 'Crashed (OOM)',
  'timed-out': 'Timed out',
  running: 'Running…',
  queued: 'Queued',
  cancelled: 'Cancelled',
};

function parseUnclaimedPaths(raw: string | null | undefined): string[] | null {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((p): p is string => typeof p === 'string');
  } catch {
    return null;
  }
}

function isCancelledRun(run: TestRunHistoryEntry): boolean {
  return run.outcome === 'cancelled' || run.failureReason === 'cancelled';
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimestamp(ms: number | null): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString();
}

function isPassed(outcome: TestRunOutcome): boolean {
  return (
    outcome === 'passed' ||
    outcome === 'passed-scoped' ||
    outcome === 'passed-targeted'
  );
}

interface Props {
  projectId: string | null | undefined;
  sessionId: string | null | undefined;
}

export function TestsTab({ projectId, sessionId }: Props) {
  const [data, setData] = useState<TestRunHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [historyTestId, setHistoryTestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!projectId || !sessionId) return undefined;
    return subscribeToTestRequestRunStatus((payload) => {
      if (payload.projectId === projectId && payload.sessionId === sessionId) {
        setRefreshTick((n) => n + 1);
      }
    });
  }, [projectId, sessionId]);

  const [cancelNotice, setCancelNotice] = useState<string | null>(null);

  const handleCancel = async (runId: string) => {
    if (!window.confirm('Cancel this test run?')) return;
    setCancelNotice(null);
    const result = await cancelTestRun(runId);
    if (result === 'already-finished') {
      setCancelNotice('That run already finished.');
    } else if (result === 'error') {
      setCancelNotice('Failed to cancel the run.');
    }
  };

  useEffect(() => {
    setData(null);
    setError(null);
  }, [projectId, sessionId]);

  useEffect(() => {
    if (!projectId || !sessionId) return;
    let cancelled = false;
    setLoading(true);
    apiRequest<TestRunHistoryResponse>(
      `/api/test-request-runs/history?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(sessionId)}`,
    )
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setError(null);
        }
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
  }, [projectId, sessionId, refreshTick]);

  if (!projectId || !sessionId) {
    return (
      <div className={styles.container}>
        <p className={styles.emptyState}>No code session for this task yet.</p>
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

  if (historyTestId) {
    return (
      <TestHistoryView
        projectId={projectId}
        testId={historyTestId}
        onClose={() => setHistoryTestId(null)}
      />
    );
  }

  return (
    <div className={styles.container} data-testid="tests-tab">
      <div
        className={styles.cycleCounter}
        data-testid="tests-tab-cycle-counter"
      >
        {data.cycleCount} of {data.cycleLimit} test.request cycles used
      </div>
      {cancelNotice && (
        <div
          className={styles.errorBanner}
          data-testid="tests-tab-cancel-notice"
        >
          {cancelNotice}
        </div>
      )}
      <div className={styles.runList}>
        {data.runs.map((run) => (
          <div
            key={run.id}
            className={styles.runRow}
            data-testid={`test-run-${run.id}`}
          >
            <div className={styles.runHeader}>
              <span
                className={`${styles.outcomeBadge} ${styles[`outcome--${isCancelledRun(run) ? 'cancelled' : run.outcome}`]}`}
                data-testid={`test-run-outcome-${run.id}`}
              >
                {isCancelledRun(run)
                  ? 'Cancelled'
                  : run.nothing_exercised
                    ? 'nothing exercised'
                    : OUTCOME_LABELS[run.outcome]}
              </span>
              {run.isPrPipelineRun && (
                <span
                  className={styles.runMeta}
                  data-testid={`test-run-source-${run.id}`}
                >
                  PR pipeline (full)
                </span>
              )}
              <span className={styles.runMeta}>
                {formatTimestamp(run.startedAt)} →{' '}
                {formatTimestamp(run.finishedAt)}
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
              {isCancelledRun(run) && run.cancelledBy && (
                <span
                  className={styles.runMeta}
                  data-testid={`test-run-cancelled-by-${run.id}`}
                >
                  Cancelled by {run.cancelledBy}
                </span>
              )}
              {(run.outcome === 'queued' || run.outcome === 'running') && (
                <button
                  type="button"
                  className={styles.cancelButton}
                  data-testid={`test-run-cancel-${run.id}`}
                  onClick={() => void handleCancel(run.id)}
                >
                  Cancel
                </button>
              )}
            </div>
            <div className={styles.nextAction}>{run.nextAction}</div>

            {isPassed(run.outcome) &&
              (() => {
                const unclaimed = parseUnclaimedPaths(run.unclaimed_paths);
                if (unclaimed === null) {
                  return (
                    <p
                      className={styles.runMeta}
                      data-testid={`test-run-coverage-unknown-${run.id}`}
                    >
                      Coverage unknown — not every test command declared the
                      paths it covers.
                    </p>
                  );
                }
                if (unclaimed.length === 0) return null;
                return (
                  <div
                    className={styles.runMeta}
                    data-testid={`test-run-unexercised-${run.id}`}
                  >
                    Unexercised paths (changed, but claimed by no test command):
                    <ul>
                      {unclaimed.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </div>
                );
              })()}

            {run.outcome === 'failed-with-no-report-acquired' && (
              <p
                className={styles.noReportState}
                data-testid={`test-run-no-report-${run.id}`}
              >
                No per-test report was acquired for this run — the process
                likely crashed before any structured result was written.
              </p>
            )}

            {run.testResultsTruncated && (
              <p
                className={styles.runMeta}
                data-testid={`test-run-truncated-${run.id}`}
              >
                Showing {run.testResults.length} of {run.totalTestResultCount}{' '}
                test results.
              </p>
            )}

            {run.testResults.length > 0 && (
              <div className={styles.testList}>
                {run.testResults.map((t) => (
                  <div
                    key={t.testId}
                    className={styles.testRow}
                    style={{ cursor: 'pointer' }}
                    role="button"
                    tabIndex={0}
                    data-testid={`test-result-${t.testId}`}
                    onClick={() => setHistoryTestId(t.testId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') setHistoryTestId(t.testId);
                    }}
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
