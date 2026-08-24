import {
  useProjectTestRuns,
  type ProjectTestRunEntry,
  type ProjectTestRunOutcome,
  type ProjectTestRunProducer,
} from '../hooks/useProjectTestRuns';
import { Tier3ErrorRateCard } from './Tier3ErrorRateCard';
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
};

const PRODUCER_LABELS: Record<ProjectTestRunProducer, string> = {
  session_request: 'Session',
  pr_gate: 'PR gate',
  base_health: 'Base health',
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

export function TestsView({ activeProjectId }: Props) {
  const { runs, loading, error } = useProjectTestRuns(activeProjectId);
  const queuePosByRunId = queuePositions(runs);

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
      <div className={styles.runList}>
        {runs.map((run) => (
          <div
            key={run.id}
            className={styles.runRow}
            data-testid={`project-test-run-${run.id}`}
          >
            <div className={styles.runHeader}>
              <span
                className={`${styles.outcomeBadge} ${styles[`outcome--${run.outcome}`] ?? ''}`}
                data-testid={`project-test-run-outcome-${run.id}`}
              >
                {OUTCOME_LABELS[run.outcome]}
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
            </div>
            <div className={styles.nextAction}>{run.nextAction}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
