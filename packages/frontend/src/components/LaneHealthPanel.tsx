import { useLaneHealthRollup } from '../hooks/useLaneHealthRollup';
import styles from './LaneHealthPanel.module.css';

interface Props {
  projectId: string | null;
  /** Bump to trigger a re-fetch in response to a push event, in addition to the poll backstop. */
  invalidationKey?: unknown;
}

function formatPct(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

function formatMs(ms: number | null): string {
  return ms === null ? '—' : `${Math.round(ms)}ms`;
}

/**
 * Project/fleet-scoped supplementary rollup — pass rate, timeout rate, and
 * queue-wait vs execution-time distributions — layered alongside
 * MilestoneView's existing burndown/attention hooks, not a replacement for
 * the per-request TaskCard/SessionPanel surface.
 */
export function LaneHealthPanel({ projectId, invalidationKey }: Props) {
  const { rollup, loading, error } = useLaneHealthRollup({
    projectId,
    invalidationKey,
  });

  if (!projectId) return null;

  return (
    <div className={styles.panel} data-testid="lane-health-panel">
      <h3 className={styles.title}>Lane health</h3>
      {loading && !rollup && <p className={styles.muted}>Loading…</p>}
      {error && <p className={styles.error}>{error}</p>}
      {rollup && rollup.totalRuns === 0 && (
        <p className={styles.muted}>No test-lane runs recorded yet.</p>
      )}
      {rollup && rollup.totalRuns > 0 && (
        <div className={styles.metrics}>
          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>Pass rate</span>
            <span className={styles.metricValue}>
              {formatPct(rollup.passRate)}
            </span>
          </div>
          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>Timeout rate</span>
            <span className={styles.metricValue}>
              {formatPct(rollup.timeoutRate)}
            </span>
          </div>
          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>Queue wait (p50/p90/p99)</span>
            <span className={styles.metricValue}>
              {formatMs(rollup.queueWaitMs.p50)} /{' '}
              {formatMs(rollup.queueWaitMs.p90)} /{' '}
              {formatMs(rollup.queueWaitMs.p99)}
            </span>
          </div>
          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>
              Execution time (p50/p90/p99)
            </span>
            <span className={styles.metricValue}>
              {formatMs(rollup.executionTimeMs.p50)} /{' '}
              {formatMs(rollup.executionTimeMs.p90)} /{' '}
              {formatMs(rollup.executionTimeMs.p99)}
            </span>
          </div>
          <p className={styles.sampleNote}>
            {rollup.totalRuns} run{rollup.totalRuns === 1 ? '' : 's'} considered
          </p>
          {rollup.regressedTests.length > 0 && (
            <div
              className={styles.regressed}
              data-testid="lane-health-regressed-tests"
            >
              <p className={styles.regressedTitle}>
                {rollup.regressedTests.length} test
                {rollup.regressedTests.length === 1 ? '' : 's'} regressed
              </p>
              <ul className={styles.regressedList}>
                {rollup.regressedTests.map((test) => (
                  <li key={test.testId} className={styles.regressedItem}>
                    <span className={styles.regressedName}>{test.name}</span>
                    <span className={styles.regressedDuration}>
                      {formatMs(test.lastDurationMs)} (baseline{' '}
                      {formatMs(test.medianDurationMs)})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {rollup.flakyTests.count > 0 && (
            <div
              className={styles.flaggedSection}
              data-testid="flaky-tests-section"
            >
              <p className={styles.flaggedTitle}>
                {rollup.flakyTests.count} test
                {rollup.flakyTests.count === 1 ? '' : 's'} flagged flaky
              </p>
              <ul className={styles.flaggedList}>
                {rollup.flakyTests.tests.map((test) => (
                  <li key={test.testId} className={styles.flaggedItem}>
                    <span className={styles.flaggedName}>{test.name}</span>
                    <span className={styles.flaggedDetail}>
                      {test.transitionCount} transitions / {test.sampleCount}{' '}
                      samples
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
