import { useEffect, useState } from 'react';
import {
  cancelTestRun,
  useProjectTestRuns,
  type ProjectTestRunEntry,
  type ProjectTestRunOutcome,
  type ProjectTestRunProducer,
} from '../hooks/useProjectTestRuns';
import { Tier3ErrorRateCard } from './Tier3ErrorRateCard';
import { apiRequest } from '../api/projects';
import { FlakiestTestsPanel } from './FlakiestTestsPanel';
import { TestHistoryView } from './TestHistoryView';
import styles from './TestsView.module.css';

const OUTCOME_LABELS: Record<ProjectTestRunOutcome, string> = {
  passed: 'Passed',
  'failed-with-named-tests': 'Failed',
  'failed-with-no-report-acquired': 'No report acquired',
  'crashed-oom': 'Crashed (OOM)',
  'timed-out': 'Timed out',
  'execution-failed': 'Execution failed',
  running: 'Running…',
  queued: 'Queued',
  cancelled: 'Cancelled',
};

const PRODUCER_LABELS: Record<ProjectTestRunProducer, string> = {
  session_request: 'Session',
  pr_gate: 'PR gate',
  base_health: 'Base health',
};

const MERGE_OUTCOME_LABELS: Record<string, string> = {
  conflict: 'Pre-test merge conflicted with dev',
  dirty_refused: 'Pre-test merge skipped (uncommitted changes)',
  error: 'Pre-test merge errored',
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

function isCancelledRun(run: ProjectTestRunEntry): boolean {
  return run.outcome === 'cancelled' || run.failureReason === 'cancelled';
}

function queuePositions(runs: ProjectTestRunEntry[]): Map<string, number> {
  const positions = new Map<string, number>();
  const queued = runs
    .filter((run) => run.outcome === 'queued')
    .sort(
      (a, b) => (a.requestedAt ?? a.startedAt) - (b.requestedAt ?? b.startedAt),
    );
  queued.forEach((run, index) => positions.set(run.id, index + 1));
  return positions;
}

interface Props {
  activeProjectId: string | null;
}

interface BaselineTest {
  testId: string;
  name: string;
  medianDurationMs: number;
}

function TestList({
  title,
  testId,
  tests,
  onSelect,
}: {
  title: string;
  testId: string;
  tests: BaselineTest[];
  onSelect: (id: string) => void;
}) {
  return (
    <section data-testid={testId}>
      <h4>{title}</h4>
      {tests.length === 0 && <p className={styles.emptyState}>None.</p>}
      {tests.map((t) => (
        <div
          key={t.testId}
          role="button"
          tabIndex={0}
          style={{ cursor: 'pointer' }}
          data-testid={`${testId}-row-${t.testId}`}
          onClick={() => onSelect(t.testId)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSelect(t.testId);
          }}
        >
          {t.name} — median {formatDuration(t.medianDurationMs)}
        </div>
      ))}
    </section>
  );
}

function TestHealth({ activeProjectId }: Props) {
  const [lists, setLists] = useState<{
    slowest: BaselineTest[];
    regressed: BaselineTest[];
  } | null>(null);
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null);

  useEffect(() => {
    setLists(null);
    if (!activeProjectId) return;
    let cancelled = false;
    apiRequest<{ slowest: BaselineTest[]; regressed: BaselineTest[] }>(
      `/api/milestones/${encodeURIComponent(activeProjectId)}/test-analytics/slow-and-regressed`,
    )
      .then((res) => {
        if (!cancelled) setLists(res);
      })
      .catch(() => {
        if (!cancelled) setLists({ slowest: [], regressed: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  if (!activeProjectId) return null;
  if (selectedTestId) {
    return (
      <TestHistoryView
        projectId={activeProjectId}
        testId={selectedTestId}
        onClose={() => setSelectedTestId(null)}
      />
    );
  }
  return (
    <div className={styles.container} data-testid="tests-health">
      <TestList
        title="Regressed tests"
        testId="health-regressed"
        tests={lists?.regressed ?? []}
        onSelect={setSelectedTestId}
      />
      <TestList
        title="Slowest tests"
        testId="health-slow"
        tests={lists?.slowest ?? []}
        onSelect={setSelectedTestId}
      />
      <FlakiestTestsPanel
        projectId={activeProjectId}
        onSelectTest={setSelectedTestId}
      />
    </div>
  );
}

export function TestsView({ activeProjectId }: Props) {
  const [tab, setTab] = useState<'runs' | 'health'>('runs');
  return (
    <>
      <div role="tablist" data-testid="tests-view-tabs">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'runs'}
          onClick={() => setTab('runs')}
        >
          Runs
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'health'}
          onClick={() => setTab('health')}
        >
          Health
        </button>
      </div>
      {tab === 'runs' ? (
        <TestRunsList activeProjectId={activeProjectId} />
      ) : (
        <TestHealth activeProjectId={activeProjectId} />
      )}
    </>
  );
}

function TestRunsList({ activeProjectId }: Props) {
  const { runs, loading, error } = useProjectTestRuns(activeProjectId);
  const queuePosByRunId = queuePositions(runs);
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

  if (!activeProjectId) {
    return (
      <div className={styles.container}>
        <p className={styles.emptyState}>No project selected.</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container}>
        <Tier3ErrorRateCard activeProjectId={activeProjectId} />
        <div className={styles.errorBanner}>
          Failed to load test runs: {error}
        </div>
      </div>
    );
  }

  if (loading && runs.length === 0) {
    return (
      <div className={styles.container}>
        <Tier3ErrorRateCard activeProjectId={activeProjectId} />
        <p className={styles.emptyState}>Loading test runs…</p>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className={styles.container}>
        <Tier3ErrorRateCard activeProjectId={activeProjectId} />
        <p className={styles.emptyState} data-testid="tests-view-empty">
          No test runs for this project yet.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.container} data-testid="tests-view">
      <Tier3ErrorRateCard activeProjectId={activeProjectId} />
      {cancelNotice && (
        <div
          className={styles.errorBanner}
          data-testid="tests-view-cancel-notice"
        >
          {cancelNotice}
        </div>
      )}
      <div className={styles.runList}>
        {runs.map((run) => (
          <div
            key={run.id}
            className={styles.runRow}
            data-testid={`project-test-run-${run.id}`}
          >
            <div className={styles.runHeader}>
              <span
                className={`${styles.outcomeBadge} ${styles[`outcome--${isCancelledRun(run) ? 'cancelled' : run.outcome}`] ?? ''}`}
                data-testid={`project-test-run-outcome-${run.id}`}
              >
                {isCancelledRun(run)
                  ? 'Cancelled'
                  : OUTCOME_LABELS[run.outcome]}
              </span>
              {run.producer && (
                <span
                  className={styles.producerBadge}
                  data-testid={`project-test-run-producer-${run.id}`}
                >
                  {PRODUCER_LABELS[run.producer]}
                </span>
              )}
              {run.outcome === 'queued' && queuePosByRunId.has(run.id) && (
                <span
                  className={styles.runMeta}
                  data-testid={`project-test-run-queue-position-${run.id}`}
                >
                  Queue position {queuePosByRunId.get(run.id)}
                </span>
              )}
              <span className={styles.runMeta}>
                {formatTimestamp(run.startedAt)} →{' '}
                {formatTimestamp(run.finishedAt)}
              </span>
              <span className={styles.runMeta}>
                {formatDuration(run.durationMs)}
              </span>
              {isCancelledRun(run) && run.cancelledBy && (
                <span
                  className={styles.runMeta}
                  data-testid={`project-test-run-cancelled-by-${run.id}`}
                >
                  Cancelled by {run.cancelledBy}
                </span>
              )}
              {(run.outcome === 'queued' || run.outcome === 'running') && (
                <button
                  type="button"
                  className={styles.cancelButton}
                  data-testid={`project-test-run-cancel-${run.id}`}
                  onClick={() => void handleCancel(run.id)}
                >
                  Cancel
                </button>
              )}
            </div>
            {run.conflictOutcome && run.conflictOutcome !== 'up_to_date' && (
              <div
                className={styles.runMeta}
                data-testid={`project-test-run-merge-${run.id}`}
              >
                {run.conflictOutcome === 'merged'
                  ? `Merged dev@${run.mergedDevSha ? run.mergedDevSha.slice(0, 7) : 'latest'} before run`
                  : (MERGE_OUTCOME_LABELS[run.conflictOutcome] ??
                    `Pre-test merge: ${run.conflictOutcome}`)}
              </div>
            )}
            <div className={styles.nextAction}>{run.nextAction}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
