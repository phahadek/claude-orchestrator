import { useEffect, useState } from 'react';
import { useLaneHealthRollup } from '../hooks/useLaneHealthRollup';
import { fileFlakyInvestigation } from '../api/flakyInvestigation';
import styles from './LaneHealthPanel.module.css';

interface Props {
  projectId: string | null;
  /** Bump to trigger a re-fetch in response to a push event, in addition to the poll backstop. */
  invalidationKey?: unknown;
  /** Milestone to file the group investigation task against; the fire-investigation control is disabled without one. */
  milestoneId?: string | null;
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
export function LaneHealthPanel({
  projectId,
  invalidationKey,
  milestoneId = null,
}: Props) {
  const { rollup, loading, error } = useLaneHealthRollup({
    projectId,
    invalidationKey,
  });

  const [selectedTestIds, setSelectedTestIds] = useState<Set<string>>(
    new Set(),
  );
  const [filing, setFiling] = useState(false);
  const [filingError, setFilingError] = useState<string | null>(null);
  const [filedTaskId, setFiledTaskId] = useState<string | null>(null);

  const flakyTests = rollup?.flakyTests.tests ?? [];

  // Drop any selected test_id that's no longer in the current flagged-flaky
  // list (e.g. a poll refresh dropped it) so the selection never fires stale ids.
  useEffect(() => {
    setSelectedTestIds((prev) => {
      const flakyIds = new Set(flakyTests.map((t) => t.testId));
      const next = new Set([...prev].filter((id) => flakyIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rollup]);

  function toggleTestSelection(testId: string) {
    setSelectedTestIds((prev) => {
      const next = new Set(prev);
      if (next.has(testId)) next.delete(testId);
      else next.add(testId);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedTestIds((prev) =>
      prev.size === flakyTests.length
        ? new Set()
        : new Set(flakyTests.map((t) => t.testId)),
    );
  }

  async function handleFireInvestigation() {
    if (!projectId || !milestoneId || selectedTestIds.size === 0) return;
    setFiling(true);
    setFilingError(null);
    setFiledTaskId(null);
    try {
      const result = await fileFlakyInvestigation(
        projectId,
        milestoneId,
        Array.from(selectedTestIds),
      );
      setFiledTaskId(result.taskId);
      setSelectedTestIds(new Set());
    } catch (err) {
      setFilingError(err instanceof Error ? err.message : String(err));
    } finally {
      setFiling(false);
    }
  }

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
              <div className={styles.flaggedHeader}>
                <label className={styles.selectAllLabel}>
                  <input
                    type="checkbox"
                    data-testid="flaky-select-all"
                    checked={
                      flakyTests.length > 0 &&
                      selectedTestIds.size === flakyTests.length
                    }
                    onChange={toggleSelectAll}
                  />
                  <p className={styles.flaggedTitle}>
                    {rollup.flakyTests.count} test
                    {rollup.flakyTests.count === 1 ? '' : 's'} flagged flaky
                  </p>
                </label>
              </div>
              <ul className={styles.flaggedList}>
                {rollup.flakyTests.tests.map((test) => (
                  <li key={test.testId} className={styles.flaggedItem}>
                    <label className={styles.flaggedItemLabel}>
                      <input
                        type="checkbox"
                        data-testid={`flaky-test-checkbox-${test.testId}`}
                        checked={selectedTestIds.has(test.testId)}
                        onChange={() => toggleTestSelection(test.testId)}
                      />
                      <span className={styles.flaggedName}>{test.name}</span>
                    </label>
                    <span className={styles.flaggedDetail}>
                      {test.transitionCount} transitions / {test.sampleCount}{' '}
                      samples
                    </span>
                  </li>
                ))}
              </ul>
              <div className={styles.flaggedActions}>
                <button
                  type="button"
                  data-testid="flaky-fire-investigation"
                  className={styles.fireButton}
                  disabled={
                    !milestoneId || selectedTestIds.size === 0 || filing
                  }
                  onClick={handleFireInvestigation}
                >
                  {filing
                    ? 'Filing…'
                    : `Fire investigation (${selectedTestIds.size})`}
                </button>
                {!milestoneId && (
                  <span className={styles.muted}>
                    Select a milestone to file an investigation.
                  </span>
                )}
                {filingError && (
                  <span
                    className={styles.error}
                    data-testid="flaky-fire-investigation-error"
                  >
                    {filingError}
                  </span>
                )}
                {filedTaskId && (
                  <span
                    className={styles.filedSuccess}
                    data-testid="flaky-fire-investigation-success"
                  >
                    Filed {filedTaskId}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
