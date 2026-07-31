import type { ConvergenceSnapshotRow } from '@claude-orchestrator/backend/src/db/types';
import styles from './ConvergenceSparkline.module.css';

interface Props {
  points: ConvergenceSnapshotRow[];
}

const WIDTH = 160;
const HEIGHT = 32;

interface SeriesDef {
  key: 'tasks_open' | 'gate_open' | 'seed_open';
  label: string;
  className: string;
}

/**
 * Tasks / gate / seed, not the aggregate alone — a large near-static axis
 * (e.g. gate) would otherwise swamp a shared linear scale and hide real
 * movement in a smaller one (e.g. tasks). Each series is normalized to its
 * own range, so a small axis's movement stays visible next to a big one's.
 */
const SERIES: SeriesDef[] = [
  { key: 'tasks_open', label: 'Tasks', className: styles.seriesTasks },
  { key: 'gate_open', label: 'Gate', className: styles.seriesGate },
  { key: 'seed_open', label: 'Seed', className: styles.seriesSeed },
];

function normalize(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range === 0) return values.map(() => 0.5);
  return values.map((v) => (v - min) / range);
}

function toPath(normalized: number[]): string {
  if (normalized.length === 0) return '';
  if (normalized.length === 1) {
    const y = HEIGHT - normalized[0] * HEIGHT;
    return `M0,${y} L${WIDTH},${y}`;
  }
  const step = WIDTH / (normalized.length - 1);
  return normalized
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${i * step},${HEIGHT - v * HEIGHT}`)
    .join(' ');
}

export function ConvergenceSparkline({ points }: Props) {
  if (points.length === 0) return null;

  return (
    <svg
      className={styles.sparkline}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      data-testid="convergence-sparkline"
      role="img"
      aria-label="Convergence trend by axis — tasks, gate, seed"
    >
      {SERIES.map(({ key, label, className }) => {
        const path = toPath(normalize(points.map((p) => Number(p[key]))));
        return (
          <path
            key={key}
            d={path}
            className={`${styles.line} ${className}`}
            data-testid={`convergence-sparkline-series-${key}`}
          >
            <title>{label}</title>
          </path>
        );
      })}
    </svg>
  );
}
