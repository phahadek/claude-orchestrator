import type { ConvergenceSnapshotRow } from '@claude-orchestrator/backend/src/db/types';
import styles from './ConvergenceSparkline.module.css';

interface Props {
  points: ConvergenceSnapshotRow[];
}

const WIDTH = 160;
const HEIGHT = 64;

interface SeriesDef {
  key: 'tasks_open' | 'gate_open' | 'seed_open';
  label: string;
  className: string;
}

/**
 * Tasks / gate / seed, not the aggregate alone — a large near-static axis
 * (e.g. gate) would otherwise swamp a shared linear scale and hide real
 * movement in a smaller one (e.g. tasks). Each series is scaled to its own
 * [0, max] domain, so a small axis's movement stays visible next to a big
 * one's while zero always anchors to the plot's bottom.
 */
const SERIES: SeriesDef[] = [
  { key: 'tasks_open', label: 'Tasks', className: styles.seriesTasks },
  { key: 'gate_open', label: 'Gate', className: styles.seriesGate },
  { key: 'seed_open', label: 'Seed', className: styles.seriesSeed },
];

/**
 * Zero-anchored: domain is always [0, max(values)], never [min, max]. A
 * flat-zero series (e.g. seed_open staying 0 for a milestone's whole life)
 * must draw at the bottom of the plot, not float to the visual center.
 */
function normalize(values: number[]): number[] {
  const max = Math.max(...values, 0);
  if (max === 0) return values.map(() => 0);
  return values.map((v) => v / max);
}

function toPath(normalized: number[], timestamps: number[]): string {
  if (normalized.length === 0) return '';
  if (normalized.length === 1) {
    const y = HEIGHT - normalized[0] * HEIGHT;
    return `M0,${y} L${WIDTH},${y}`;
  }
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
  const tsRange = maxTs - minTs;
  return normalized
    .map((v, i) => {
      const x = tsRange === 0 ? 0 : ((timestamps[i] - minTs) / tsRange) * WIDTH;
      return `${i === 0 ? 'M' : 'L'}${x},${HEIGHT - v * HEIGHT}`;
    })
    .join(' ');
}

function formatRange(first: number, last: number, range: number): string {
  if (range === 0) return `${first} (no change)`;
  const delta = last - first;
  const sign = delta > 0 ? '+' : '';
  return `${first} → ${last} (${sign}${delta})`;
}

export function ConvergenceSparkline({ points }: Props) {
  if (points.length === 0) return null;

  const timestamps = points.map((p) => new Date(p.ts).getTime());

  const series = SERIES.map(({ key, label, className }) => {
    const values = points.map((p) => Number(p[key]));
    const first = values[0];
    const last = values[values.length - 1];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;
    const path = toPath(normalize(values), timestamps);
    return { key, label, className, path, first, last, range };
  });

  return (
    <div className={styles.wrap}>
      <svg
        className={styles.sparkline}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        data-testid="convergence-sparkline"
        role="img"
        aria-label="Convergence trend by axis — tasks, gate, seed"
      >
        {series.map(({ key, label, className, path, range }) => (
          <path
            key={key}
            d={path}
            className={`${styles.line} ${className} ${range === 0 ? styles.lineFlat : ''}`}
            data-testid={`convergence-sparkline-series-${key}`}
          >
            <title>{label}</title>
          </path>
        ))}
      </svg>
      <ul className={styles.legend} data-testid="convergence-sparkline-legend">
        {series.map(({ key, label, className, first, last, range }) => (
          <li key={key} className={styles.legendItem}>
            <span
              className={`${styles.swatch} ${className}`}
              aria-hidden="true"
            />
            <span className={styles.legendLabel}>{label}</span>
            <span
              className={styles.legendRange}
              data-testid={`convergence-sparkline-range-${key}`}
            >
              {formatRange(first, last, range)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
