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

  it('zero-anchors each series to its own [0, max] domain, not [min, max]', () => {
    render(<ConvergenceSparkline points={points} />);
    const tasksPath = screen.getByTestId(
      'convergence-sparkline-series-tasks_open',
    );
    const gatePath = screen.getByTestId(
      'convergence-sparkline-series-gate_open',
    );

    const yOf = (d: string, index: number) => {
      const ys = Array.from(
        d.matchAll(/[ML]-?\d+(?:\.\d+)?,(-?\d+(?:\.\d+)?)/g),
      ).map((m) => Number(m[1]));
      return ys[index];
    };

    // tasks_open: max is 20 (first point) -> normalized to 1 -> y = 0 (top).
    expect(yOf(tasksPath.getAttribute('d')!, 0)).toBeCloseTo(0, 5);
    // gate_open: max is 190 (last two points) -> normalized to 1 -> y = 0.
    expect(yOf(gatePath.getAttribute('d')!, 2)).toBeCloseTo(0, 5);
    expect(yOf(gatePath.getAttribute('d')!, 3)).toBeCloseTo(0, 5);
  });

  it('renders a series constant at 0 at the bottom of the plotted range, not the midpoint', () => {
    const zeroPoints = [
      makePoint({ tasks_open: 5, seed_open: 0 }),
      makePoint({ tasks_open: 5, seed_open: 0 }),
      makePoint({ tasks_open: 5, seed_open: 0 }),
    ];
    render(<ConvergenceSparkline points={zeroPoints} />);
    const seedPath = screen.getByTestId(
      'convergence-sparkline-series-seed_open',
    );
    const ys = Array.from(
      seedPath
        .getAttribute('d')!
        .matchAll(/[ML]-?\d+(?:\.\d+)?,(-?\d+(?:\.\d+)?)/g),
    ).map((m) => Number(m[1]));
    // Bottom of the plot is y = HEIGHT (64), never the midpoint (32).
    for (const y of ys) {
      expect(y).toBeCloseTo(64, 5);
    }
  });

  it('renders 0 at the chart bottom for a non-zero series (zero-anchored, not [min, max])', () => {
    const nonZeroPoints = [
      makePoint({ tasks_open: 0 }),
      makePoint({ tasks_open: 20 }),
      makePoint({ tasks_open: 10 }),
    ];
    render(<ConvergenceSparkline points={nonZeroPoints} />);
    const tasksPath = screen.getByTestId(
      'convergence-sparkline-series-tasks_open',
    );
    const ys = Array.from(
      tasksPath
        .getAttribute('d')!
        .matchAll(/[ML]-?\d+(?:\.\d+)?,(-?\d+(?:\.\d+)?)/g),
    ).map((m) => Number(m[1]));
    // First point (value 0) must draw at the very bottom, y = HEIGHT.
    expect(ys[0]).toBeCloseTo(64, 5);
  });

  it('spaces points by elapsed time, not fixed index steps', () => {
    const unevenPoints = [
      makePoint({ ts: '2026-07-31T00:00:00Z', tasks_open: 0 }),
      makePoint({ ts: '2026-07-31T00:01:00Z', tasks_open: 10 }),
      makePoint({ ts: '2026-07-31T01:01:00Z', tasks_open: 20 }),
    ];
    render(<ConvergenceSparkline points={unevenPoints} />);
    const tasksPath = screen.getByTestId(
      'convergence-sparkline-series-tasks_open',
    );
    const xs = Array.from(
      tasksPath.getAttribute('d')!.matchAll(/[ML](-?\d+(?:\.\d+)?),/g),
    ).map((m) => Number(m[1]));

    expect(xs[0]).toBeCloseTo(0, 5);
    expect(xs[2]).toBeCloseTo(160, 5);
    // Gap 1 (60s) is 1/60th of the total 3600s span — the middle point
    // should sit near the start, far from an evenly-spaced index midpoint (80).
    expect(xs[1]).toBeLessThan(10);
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
