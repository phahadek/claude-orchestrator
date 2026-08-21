import { useEffect, useState } from 'react';
import { useLaneHealthRollup } from '../hooks/useLaneHealthRollup';
import {
  fileFlakyInvestigation,
  FlakyInvestigationError,
} from '../api/flakyInvestigation';
import styles from './LaneHealthPanel.module.css';

/** Reasons that mean "the selection raced a concurrent filing" rather than a
 * plain request failure — see FlakyInvestigationFilingError in
 * backend/src/audit/flakyRemediationFiling.ts. */
const BATCH_REJECT_REASONS = new Set(['already-open', 'claim-conflict']);

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
  const [filingConflict, setFilingConflict] = useState<string | null>(null);
  const [filedTaskId, setFiledTaskId] = useState<string | null>(null);

  const flakyTests = rollup?.flakyTests.tests ?? [];
  // Tests already tracked under an open remediation task can't be re-selected
  // into another batch — the filing service would reject the whole request.
  const selectableTests = flakyTests.filter((t) => !t.remediationTaskOpen);

  // Drop any selected test_id that's no longer selectable (dropped by a poll
  // refresh, or claimed by an open remediation task since it was checked) so
  // the selection never fires a stale or now-open id.
  useEffect(() => {
    setSelectedTestIds((prev) => {
      const selectableIds = new Set(selectableTests.map((t) => t.testId));
      const next = new Set([...prev].filter((id) => selectableIds.has(id)));
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
      prev.size === selectableTests.length
        ? new Set()
        : new Set(selectableTests.map((t) => t.testId)),
    );
  }

  async function handleFireInvestigation() {
    if (!projectId || !milestoneId || selectedTestIds.size === 0) return;
    setFiling(true);
    setFilingError(null);
    setFilingConflict(null);
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
      if (
        err instanceof FlakyInvestigationError &&
        err.reason &&
        BATCH_REJECT_REASONS.has(err.reason)
      ) {
        setFilingConflict(err.message);
      } else {
        setFilingError(err instanceof Error ? err.message : String(err));
      }
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
                    disabled={selectableTests.length === 0}
                    checked={
                      selectableTests.length > 0 &&
                      selectedTestIds.size === selectableTests.length
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
                  <li
                    key={test.testId}
                    className={`${styles.flaggedItem}${
                      test.remediationTaskOpen
                        ? ` ${styles.flaggedItemOpen}`
                        : ''
                    }`}
                  >
                    <label className={styles.flaggedItemLabel}>
                      <input
                        type="checkbox"
                        data-testid={`flaky-test-checkbox-${test.testId}`}
                        disabled={test.remediationTaskOpen}
                        checked={selectedTestIds.has(test.testId)}
                        onChange={() => toggleTestSelection(test.testId)}
                      />
                      <span className={styles.flaggedName}>{test.name}</span>
                    </label>
                    {test.remediationTaskOpen && test.remediationTaskId ? (
                      <a
                        className={styles.flaggedTaskLink}
                        data-testid={`flaky-remediation-link-${test.testId}`}
                        href={`https://notion.so/${test.remediationTaskId.replace(/-/g, '')}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Investigation open
                      </a>
                    ) : (
                      <span className={styles.flaggedDetail}>
                        {test.transitionCount} transitions / {test.sampleCount}{' '}
                        samples
                      </span>
                    )}
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
                {filingConflict && (
                  <span
                    className={styles.error}
                    data-testid="flaky-fire-investigation-conflict"
                  >
                    Selection changed before filing — {filingConflict}
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
