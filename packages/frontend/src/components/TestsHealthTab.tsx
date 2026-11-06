import { useState } from 'react';
import {
  DEFAULT_HEALTH_WINDOW_DAYS,
  MAX_HEALTH_WINDOW_DAYS,
  useProjectTestHealth,
  type BaselineTestSummary,
  type PassRateTrendDay,
  type QueueWaitDay,
} from '../hooks/useProjectTestHealth';
import { LaneOccupancyPanel } from './LaneOccupancyPanel';
import styles from './TestsHealthTab.module.css';

const EXCUSAL_HORIZON_DAYS = 14;
const WINDOW_OPTIONS = [
  7,
  DEFAULT_HEALTH_WINDOW_DAYS,
  60,
  MAX_HEALTH_WINDOW_DAYS,
];

interface Segment {
  key: string;
  label: string;
  className: string;
  count: number;
}

const LEGEND: Array<{ key: string; label: string; className: string }> = [
  { key: 'passed', label: 'Executed – passed', className: 'bandPassed' },
  { key: 'failed', label: 'Executed – failed', className: 'bandFailed' },
  {
    key: 'notRetained',
    label: 'Failed (excusal not retained)',
    className: 'bandNotRetained',
  },
  {
    key: 'excused',
    label: 'All failures excused',
    className: 'bandExcused',
  },
  { key: 'oom', label: 'OOM / timeout', className: 'bandOom' },
  { key: 'noVerdict', label: 'No verdict', className: 'bandNoVerdict' },
  {
    key: 'nothingExercised',
    label: 'Nothing exercised',
    className: 'bandNothing',
  },
  { key: 'reused', label: 'Reused', className: 'bandReused' },
];

function segmentsOf(day: PassRateTrendDay): Segment[] {
  const b = day.bands;
  const notRetained = Math.min(day.failedExcusalNotRetained, b.executed_failed);
  const segments: Segment[] = [
    {
      key: 'passed',
      label: 'Executed – passed',
      className: 'bandPassed',
      count: b.executed_passed,
    },
    {
      key: 'failed',
      label: 'Executed – failed',
      className: 'bandFailed',
      count: b.executed_failed - notRetained,
    },
    {
      key: 'notRetained',
      label: 'Failed (excusal not retained)',
      className: 'bandNotRetained',
      count: notRetained,
    },
  ];
  const reasons = Object.entries(day.excusedBySource);
  if (reasons.length > 0) {
    // A run with several reasons is counted once per reason; scale so the
    // band's total height still equals the number of excused runs.
    const reasonTotal = reasons.reduce((sum, [, n]) => sum + n, 0);
    for (const [reason, n] of reasons) {
      segments.push({
        key: `excused:${reason}`,
        label: `All failures excused – ${reason}`,
        className: 'bandExcused',
        count: (n / reasonTotal) * b.executed_failed_all_excused,
      });
    }
  } else if (b.executed_failed_all_excused > 0) {
    segments.push({
      key: 'excused',
      label: 'All failures excused',
      className: 'bandExcused',
      count: b.executed_failed_all_excused,
    });
  }
  segments.push(
    {
      key: 'oom',
      label: 'OOM / timeout',
      className: 'bandOom',
      count: b.oom_or_timeout,
    },
    {
      key: 'noVerdict',
      label: 'No verdict',
      className: 'bandNoVerdict',
      count: b.no_verdict,
    },
    {
      key: 'nothingExercised',
      label: 'Nothing exercised',
      className: 'bandNothing',
      count: b.nothing_exercised,
    },
    {
      key: 'reused',
      label: 'Reused',
      className: 'bandReused',
      count: b.reused,
    },
  );
  return segments.filter((s) => s.count > 0);
}

function headlineRate(days: PassRateTrendDay[]): number | null {
  let passed = 0;
  let denominator = 0;
  for (const d of days) {
    passed += d.bands.executed_passed;
    denominator +=
      d.bands.executed_passed +
      d.bands.executed_failed +
      d.bands.executed_failed_all_excused +
      d.bands.oom_or_timeout;
  }
  return denominator > 0 ? passed / denominator : null;
}

function formatMs(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function PassRateChart({
  kind,
  days,
  windowDays,
}: {
  kind: string;
  days: PassRateTrendDay[];
  windowDays: number;
}) {
  const maxTotal = Math.max(
    1,
    ...days.map((d) => Object.values(d.bands).reduce((sum, n) => sum + n, 0)),
  );
  const rate = headlineRate(days);
  return (
    <div className={styles.kindBlock} data-testid={`health-kind-${kind}`}>
      <div className={styles.kindHeader}>
        <span className={styles.kindName}>{kind}</span>
        <span
          className={styles.headlineRate}
          data-testid={`health-headline-${kind}`}
        >
          {rate == null ? '—' : `${Math.round(rate * 100)}% executed pass rate`}
        </span>
      </div>
      <div className={styles.bars}>
        {days.map((day) => (
          <div
            key={day.day}
            className={styles.bar}
            data-testid={`health-bar-${kind}-${day.day}`}
            title={day.day}
          >
            <div
              className={styles.barStack}
              style={{
                height: `${(Object.values(day.bands).reduce((s, n) => s + n, 0) / maxTotal) * 100}%`,
              }}
            >
              {segmentsOf(day).map((seg) => (
                <div
                  key={seg.key}
                  className={`${styles.segment} ${styles[seg.className]}`}
                  data-testid={`health-band-${seg.key}`}
                  style={{ flexGrow: seg.count }}
                  title={`${day.day}: ${seg.label} (${Math.round(seg.count * 100) / 100})`}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      {windowDays > EXCUSAL_HORIZON_DAYS && (
        <div
          className={styles.horizonNote}
          data-testid="health-excusal-horizon"
        >
          Excusal horizon: {EXCUSAL_HORIZON_DAYS} days — failures older than
          this render as "failed (excusal not retained)".
        </div>
      )}
    </div>
  );
}

function QueueWaitChart({ days }: { days: QueueWaitDay[] }) {
  if (days.length === 0) {
    return <p className={styles.empty}>No executed runs in this window.</p>;
  }
  const max = Math.max(1, ...days.map((d) => d.p90 ?? d.p50 ?? 0));
  return (
    <div>
      <div className={styles.bars} data-testid="health-queue-wait-chart">
        {days.map((d) => (
          <div
            key={d.day}
            className={styles.bar}
            title={`${d.day}: p50 ${formatMs(d.p50)}, p90 ${formatMs(d.p90)}`}
          >
            <div
              className={styles.waitP90}
              style={{ height: `${((d.p90 ?? 0) / max) * 100}%` }}
            >
              <div
                className={styles.waitP50}
                style={{
                  height: `${d.p90 ? ((d.p50 ?? 0) / d.p90) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <span className={`${styles.swatch} ${styles.waitP50}`} />
          p50
        </span>
        <span className={styles.legendItem}>
          <span className={`${styles.swatch} ${styles.waitP90}`} />
          p90
        </span>
      </div>
    </div>
  );
}

function TestTable({
  title,
  testId,
  rows,
  onSelect,
}: {
  title: string;
  testId: string;
  rows: BaselineTestSummary[];
  onSelect?: (testId: string) => void;
}) {
  return (
    <div className={styles.tableBlock} data-testid={testId}>
      <h4 className={styles.panelSubtitle}>{title}</h4>
      {rows.length === 0 ? (
        <p className={styles.empty}>None.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Test</th>
              <th>Median</th>
              <th>Last</th>
              <th>Samples</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.testId}
                data-testid={`${testId}-row-${row.testId}`}
                className={onSelect ? styles.clickableRow : undefined}
                onClick={onSelect ? () => onSelect(row.testId) : undefined}
              >
                <td className={styles.testName}>{row.name}</td>
                <td>{formatMs(row.medianDurationMs)}</td>
                <td>{formatMs(row.lastDurationMs)}</td>
                <td>{row.sampleCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface Props {
  projectId: string;
  onSelectTest?: (testId: string) => void;
}

export function TestsHealthTab({ projectId, onSelectTest }: Props) {
  const [windowDays, setWindowDays] = useState(DEFAULT_HEALTH_WINDOW_DAYS);
  const {
    passRate,
    queueWait,
    slowAndRegressed,
    laneOccupancy,
    loading,
    error,
  } = useProjectTestHealth(projectId, windowDays);

  const kinds = passRate ? Object.keys(passRate.runKinds).sort() : [];

  return (
    <div className={styles.health} data-testid="tests-health-tab">
      <div className={styles.toolbar}>
        <label className={styles.windowLabel}>
          Window
          <select
            className={styles.windowSelect}
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
            data-testid="health-window-select"
          >
            {WINDOW_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <div className={styles.error}>Failed to load test health: {error}</div>
      )}
      {loading && !passRate && <p className={styles.empty}>Loading health…</p>}

      <section className={styles.panel} data-testid="health-pass-rate-panel">
        <h3 className={styles.panelTitle}>Pass rate</h3>
        <div className={styles.legend} data-testid="health-legend">
          {LEGEND.map((item) => (
            <span key={item.key} className={styles.legendItem}>
              <span className={`${styles.swatch} ${styles[item.className]}`} />
              {item.label}
            </span>
          ))}
        </div>
        <p className={styles.note}>
          Headline rate excludes reused, no-verdict and nothing-exercised runs.
          Excused failures are never counted as passes.
        </p>
        {passRate && kinds.length === 0 && (
          <p className={styles.empty}>No finished runs in this window.</p>
        )}
        {passRate &&
          kinds.map((kind) => (
            <PassRateChart
              key={kind}
              kind={kind}
              days={passRate.runKinds[kind]}
              windowDays={passRate.windowDays}
            />
          ))}
      </section>

      <section className={styles.panel} data-testid="health-queue-wait-panel">
        <h3 className={styles.panelTitle}>Queue wait</h3>
        {queueWait && <QueueWaitChart days={queueWait.days} />}
      </section>

      {laneOccupancy && <LaneOccupancyPanel lanes={laneOccupancy.lanes} />}

      <section className={styles.panel} data-testid="health-slow-panel">
        <h3 className={styles.panelTitle}>Slowest &amp; regressed tests</h3>
        {slowAndRegressed && (
          <>
            <TestTable
              title="Slowest by baseline median"
              testId="health-slow"
              rows={slowAndRegressed.slowest}
              onSelect={onSelectTest}
            />
            <TestTable
              title="Regressed"
              testId="health-regressed"
              rows={slowAndRegressed.regressed}
              onSelect={onSelectTest}
            />
          </>
        )}
      </section>
    </div>
  );
}
