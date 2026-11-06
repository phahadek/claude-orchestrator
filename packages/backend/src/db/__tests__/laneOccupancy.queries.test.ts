import { describe, it, expect } from 'vitest';

import { computeLaneOccupancy, type LaneRunInterval } from '../queries.js';

const H = 60 * 60 * 1000;
const T0 = 1_000 * H;
const END = T0 + 4 * H;

function run(
  requested: number,
  started: number | null,
  finished: number | null,
  coverage: string | null = null,
): LaneRunInterval {
  return {
    requested_at: requested,
    started_at: started,
    finished_at: finished,
    coverage_source_run_id: coverage,
  };
}

describe('computeLaneOccupancy', () => {
  it('matches a hand-computed series for overlap, open-ended, cancelled and reused runs', () => {
    const runs = [
      // A: queued [0h,0.5h), running [0.5h,2.5h)
      run(T0, T0 + 0.5 * H, T0 + 2.5 * H),
      // B: queued [0.25h,1.5h), running [1.5h,3.5h)  (overlaps A)
      run(T0 + 0.25 * H, T0 + 1.5 * H, T0 + 3.5 * H),
      // C: still running at window end: queued [2h,2.25h), running [2.25h,END)
      run(T0 + 2 * H, T0 + 2.25 * H, null),
      // D: cancelled while queued: queued [1h,1.75h) only
      run(T0 + 1 * H, null, T0 + 1.75 * H),
      // E: reused: queued [3h,3.1h) but no running interval
      run(T0 + 3 * H, T0 + 3.1 * H, T0 + 3.1 * H, 'src'),
    ];
    // Hour 0: A starts (running 1), B queued -> peakRunning 1, peakQueued 2 (A,B queued before A starts)
    // Hour 1: B starts at 1.5h (A running) -> running 2; D queued with B -> queued 2
    // Hour 2: A ends 2.5h; C queued 2h then running 2.25h -> running peak 3 (A,B,C)
    // Hour 3: B ends 3.5h; C runs; E queued -> running 2 at start, queued 1
    expect(computeLaneOccupancy(runs, T0, END)).toEqual([
      { t: T0, peakRunning: 1, peakQueued: 2 },
      { t: T0 + H, peakRunning: 2, peakQueued: 2 },
      { t: T0 + 2 * H, peakRunning: 3, peakQueued: 1 },
      { t: T0 + 3 * H, peakRunning: 2, peakQueued: 1 },
    ]);
  });

  it('counts back-to-back runs once and carries pre-window runs in', () => {
    const runs = [
      run(T0 - 2 * H, T0 - 1 * H, T0 + 1 * H),
      run(T0 + 1 * H, T0 + 1 * H, T0 + 2 * H),
    ];
    expect(computeLaneOccupancy(runs, T0, T0 + 2 * H)).toEqual([
      { t: T0, peakRunning: 1, peakQueued: 0 },
      { t: T0 + H, peakRunning: 1, peakQueued: 0 },
    ]);
  });
});
