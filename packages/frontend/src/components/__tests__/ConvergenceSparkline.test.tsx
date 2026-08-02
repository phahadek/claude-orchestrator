import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ConvergenceSparkline } from '../ConvergenceSparkline';
import styles from '../ConvergenceSparkline.module.css';
import type { ConvergenceSnapshotRow } from '@claude-orchestrator/backend/src/db/types';

function makePoint(
  overrides: Partial<ConvergenceSnapshotRow> = {},
): ConvergenceSnapshotRow {
  return {
    id: 'x',
    project: 'p',
    milestone: 'm',
    ts: '2026-07-31T00:00:00Z',
    tasks_open: 0,
    tasks_closed: 0,
    gate_open: 0,
    gate_closed: 0,
    gate_parked: 0,
    seed_open: 0,
    seed_closed: 0,
    ops_open: 0,
    ops_closed: 0,
    total_scope: 0,
    distance_to_green: 0,
    status: 'green',
    ...overrides,
  };
}

const points: ConvergenceSnapshotRow[] = [
  makePoint({ tasks_open: 20, gate_open: 154, seed_open: 7 }),
  makePoint({ tasks_open: 17, gate_open: 165, seed_open: 7 }),
  makePoint({ tasks_open: 14, gate_open: 190, seed_open: 7 }),
  makePoint({ tasks_open: 6, gate_open: 190, seed_open: 7 }),
];

describe('ConvergenceSparkline', () => {
  it('renders a legend naming each series with a swatch matching its stroke colour', () => {
    render(<ConvergenceSparkline points={points} />);
    const legend = screen.getByTestId('convergence-sparkline-legend');
    expect(legend.textContent).toContain('Tasks');
    expect(legend.textContent).toContain('Gate');
    expect(legend.textContent).toContain('Seed');

    const items = legend.querySelectorAll('li');
    expect(items).toHaveLength(3);

    const tasksSwatch = items[0].querySelector(`.${styles.swatch}`);
    expect(tasksSwatch?.classList.contains(styles.seriesTasks)).toBe(true);
    const gateSwatch = items[1].querySelector(`.${styles.swatch}`);
    expect(gateSwatch?.classList.contains(styles.seriesGate)).toBe(true);
    const seedSwatch = items[2].querySelector(`.${styles.swatch}`);
    expect(seedSwatch?.classList.contains(styles.seriesSeed)).toBe(true);
  });

  it('renders each series actual value range as text, not only a title tooltip', () => {
    render(<ConvergenceSparkline points={points} />);
    expect(
      screen.getByTestId('convergence-sparkline-range-tasks_open').textContent,
    ).toBe('20 → 6 (-14)');
    expect(
      screen.getByTestId('convergence-sparkline-range-gate_open').textContent,
    ).toBe('154 → 190 (+36)');
  });

  it('renders a constant series visually distinct from a mid-range series', () => {
    render(<ConvergenceSparkline points={points} />);
    const seedPath = screen.getByTestId(
      'convergence-sparkline-series-seed_open',
    );
    expect(seedPath.classList.contains(styles.lineFlat)).toBe(true);
    expect(
      screen.getByTestId('convergence-sparkline-range-seed_open').textContent,
    ).toBe('7 (no change)');

    const tasksPath = screen.getByTestId(
      'convergence-sparkline-series-tasks_open',
    );
    expect(tasksPath.classList.contains(styles.lineFlat)).toBe(false);
  });

  it('keeps per-series normalization so a small-range series still spans the full plot height', () => {
    render(<ConvergenceSparkline points={points} />);
    const tasksPath = screen.getByTestId(
      'convergence-sparkline-series-tasks_open',
    );
    const gatePath = screen.getByTestId(
      'convergence-sparkline-series-gate_open',
    );

    // tasks_open ranges 6..20 (span 14), gate_open ranges 154..190 (span 36) —
    // despite the smaller absolute span, both paths must use the full [0, HEIGHT]
    // extent because each is normalized against its own min/max independently.
    const heightOf = (d: string) => {
      const ys = Array.from(
        d.matchAll(/[ML]-?\d+(?:\.\d+)?,(-?\d+(?:\.\d+)?)/g),
      ).map((m) => Number(m[1]));
      return Math.max(...ys) - Math.min(...ys);
    };

    expect(heightOf(tasksPath.getAttribute('d')!)).toBeCloseTo(
      heightOf(gatePath.getAttribute('d')!),
      5,
    );
  });

  it('fills the container width instead of centering at a fixed intrinsic size', () => {
    render(<ConvergenceSparkline points={points} />);
    const svg = screen.getByTestId('convergence-sparkline');
    expect(svg.getAttribute('preserveAspectRatio')).toBe('none');
    expect(svg.classList.contains(styles.sparkline)).toBe(true);
  });

  it('renders nothing when there are no points', () => {
    const { container } = render(<ConvergenceSparkline points={[]} />);
    expect(container.innerHTML).toBe('');
  });
});
