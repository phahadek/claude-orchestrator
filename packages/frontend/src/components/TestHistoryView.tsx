import { useEffect, useState } from 'react';
import { apiRequest } from '../api/projects';
import styles from './TestHistoryView.module.css';

interface Sample {
  sequencedAt: number;
  outcome: 'P' | 'F' | null;
  durationMs: number | null;
}

interface Bucket {
  weekStart: number;
  passCount: number;
  failCount: number;
  transitionCount: number;
  durationCount: number;
  durationSumMs: number;
  durationMinMs: number | null;
  durationMaxMs: number | null;
}

interface Failure {
  testRequestRunId: string;
  failureMessage: string | null;
  failureTraceExcerpt: string | null;
  createdAt: number;
}

interface TestHistoryResponse {
  testId: string;
  name: string | null;
  outcomeSamples: Sample[];
  durationSamples: Sample[];
  weeklyBuckets: Bucket[];
  failures: Failure[];
  failureRetentionMs: number;
  failureHorizonMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface Props {
  projectId: string;
  testId: string;
  onClose: () => void;
}

export function TestHistoryView({ projectId, testId, onClose }: Props) {
  const [data, setData] = useState<TestHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    let cancelled = false;
    apiRequest<TestHistoryResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/tests/history?testId=${encodeURIComponent(testId)}`,
    )
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Network error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, testId]);

  const retentionDays = data
    ? Math.round(data.failureRetentionMs / DAY_MS)
    : 14;

  return (
    <div className={styles.container} data-testid="test-history-view">
      <div className={styles.header}>
        <button
          type="button"
          onClick={onClose}
          data-testid="test-history-close"
        >
          Back
        </button>
        <strong>{data?.name ?? testId}</strong>
      </div>
      {error && (
        <div className={styles.error}>Failed to load test history: {error}</div>
      )}
      {!error && !data && <p className={styles.empty}>Loading history…</p>}
      {data && (
        <>
          <section>
            <h4>Outcomes</h4>
            <div className={styles.strip} data-testid="test-history-outcomes">
              {data.outcomeSamples.map((s) => (
                <span
                  key={s.sequencedAt}
                  className={s.outcome === 'F' ? styles.fail : styles.pass}
                  title={new Date(s.sequencedAt / 1000).toLocaleString()}
                >
                  {s.outcome}
                </span>
              ))}
            </div>
          </section>
          <section>
            <h4>Durations</h4>
            <div
              className={styles.durations}
              data-testid="test-history-durations"
            >
              {data.durationSamples.map((s) => (
                <span key={s.sequencedAt}>{s.durationMs}ms</span>
              ))}
            </div>
          </section>
          <section>
            <h4>Weekly history</h4>
            {data.weeklyBuckets.length === 0 ? (
              <p className={styles.empty}>No older weekly history.</p>
            ) : (
              <ul data-testid="test-history-weeks">
                {data.weeklyBuckets.map((b) => (
                  <li key={b.weekStart}>
                    {new Date(b.weekStart).toLocaleDateString()}: {b.passCount}{' '}
                    pass / {b.failCount} fail, {b.transitionCount} flips
                    {b.durationCount > 0 &&
                      `, avg ${Math.round(b.durationSumMs / b.durationCount)}ms (${b.durationMinMs}–${b.durationMaxMs}ms)`}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h4>Failure messages</h4>
            <p
              className={styles.horizon}
              data-testid="test-history-failure-horizon"
            >
              Showing failures since{' '}
              {new Date(data.failureHorizonMs).toLocaleString()} (last{' '}
              {retentionDays} days retained)
            </p>
            {data.failures.length === 0 ? (
              <p className={styles.empty}>No failure messages retained.</p>
            ) : (
              data.failures.map((f) => (
                <div key={`${f.testRequestRunId}-${f.createdAt}`}>
                  <div className={styles.meta}>
                    {new Date(f.createdAt).toLocaleString()}
                  </div>
                  <pre>{f.failureMessage ?? f.failureTraceExcerpt}</pre>
                </div>
              ))
            )}
          </section>
        </>
      )}
    </div>
  );
}
