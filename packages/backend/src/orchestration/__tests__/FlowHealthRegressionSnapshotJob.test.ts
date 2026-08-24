/**
 * Tests for FlowHealthRegressionSnapshotJob
 * (packages/backend/src/orchestration/FlowHealthRegressionSnapshotJob.ts).
 *
 * AC: p50 wall-clock computed correctly over ended 'standard' sessions in
 * the window; archived+killed+no-reason kills before the fixed cutoff are
 * excluded from the sample set and counted separately, the same shape after
 * the cutoff is not excluded; dedup-on-write; status crosses to 'regressed'
 * above the 60-minute p50 threshold; registered daily.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

function percentilesOf(samples: number[]) {
  if (samples.length === 0) {
    return { p50: null, p90: null, p99: null, sampleCount: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => {
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
    );
    return sorted[idx];
  };
  return { p50: at(50), p90: at(90), p99: at(99), sampleCount: sorted.length };
}

const queriesMock = vi.hoisted(() => ({
  getStandardSessionWallClockSample: vi.fn(),
  insertFlowHealthRegressionSnapshot: vi.fn(),
  getLatestFlowHealthRegressionSnapshot: vi.fn(),
  percentilesOf: vi.fn(),
}));

vi.mock('../../db/queries.js', () => queriesMock);

import { FlowHealthRegressionSnapshotJob } from '../FlowHealthRegressionSnapshotJob.js';
import {
  getStandardSessionWallClockSample,
  insertFlowHealthRegressionSnapshot,
  getLatestFlowHealthRegressionSnapshot,
} from '../../db/queries.js';

const MS = 60_000;

beforeEach(() => {
  vi.clearAllMocks();
  queriesMock.percentilesOf.mockImplementation(percentilesOf);
});

describe('FlowHealthRegressionSnapshotJob p50 computation', () => {
  it('computes p50 wall-clock over the sampled durations', () => {
    (getStandardSessionWallClockSample as any).mockReturnValue({
      durationsMs: [10 * MS, 20 * MS, 30 * MS, 40 * MS, 50 * MS],
      excludedArtifactCount: 0,
    });
    (getLatestFlowHealthRegressionSnapshot as any).mockReturnValue(undefined);

    const job = new FlowHealthRegressionSnapshotJob();
    job.runOnce();

    expect(insertFlowHealthRegressionSnapshot).toHaveBeenCalledTimes(1);
    const row = (insertFlowHealthRegressionSnapshot as any).mock.calls[0][0];
    expect(row.p50_wall_clock_ms).toBe(30 * MS);
    expect(row.status).toBe('ok');
  });

  it('crosses to regressed when p50 exceeds 60 minutes and back to ok otherwise', () => {
    (getLatestFlowHealthRegressionSnapshot as any).mockReturnValue(undefined);

    (getStandardSessionWallClockSample as any).mockReturnValue({
      durationsMs: [70 * MS, 80 * MS, 90 * MS],
      excludedArtifactCount: 0,
    });
    const job = new FlowHealthRegressionSnapshotJob();
    job.runOnce();
    expect(
      (insertFlowHealthRegressionSnapshot as any).mock.calls[0][0].status,
    ).toBe('regressed');

    (getStandardSessionWallClockSample as any).mockReturnValue({
      durationsMs: [10 * MS, 20 * MS, 30 * MS],
      excludedArtifactCount: 0,
    });
    (getLatestFlowHealthRegressionSnapshot as any).mockReturnValue({
      id: 'snap-1',
      window_start: 0,
      window_end: 1,
      sample_count: 3,
      p50_wall_clock_ms: 80 * MS,
      status: 'regressed',
      excluded_artifact_count: 0,
    });
    job.runOnce();
    expect(
      (insertFlowHealthRegressionSnapshot as any).mock.calls[1][0].status,
    ).toBe('ok');
  });
});

describe('FlowHealthRegressionSnapshotJob artifact exclusion', () => {
  it('propagates excluded_artifact_count from the sample separately from sample_count', () => {
    (getStandardSessionWallClockSample as any).mockReturnValue({
      durationsMs: [10 * MS, 20 * MS],
      excludedArtifactCount: 4,
    });
    (getLatestFlowHealthRegressionSnapshot as any).mockReturnValue(undefined);

    const job = new FlowHealthRegressionSnapshotJob();
    job.runOnce();

    const row = (insertFlowHealthRegressionSnapshot as any).mock.calls[0][0];
    expect(row.sample_count).toBe(2);
    expect(row.excluded_artifact_count).toBe(4);
  });
});

describe('FlowHealthRegressionSnapshotJob dedup', () => {
  it('writes exactly one row for two identical consecutive evaluations', () => {
    (getStandardSessionWallClockSample as any).mockReturnValue({
      durationsMs: [10 * MS, 20 * MS, 30 * MS],
      excludedArtifactCount: 0,
    });

    let stored: any;
    (getLatestFlowHealthRegressionSnapshot as any).mockImplementation(
      () => stored,
    );
    (insertFlowHealthRegressionSnapshot as any).mockImplementation(
      (row: any) => {
        stored = { id: 'snap-1', ...row };
      },
    );

    const job = new FlowHealthRegressionSnapshotJob();
    job.runOnce();
    job.runOnce();

    expect(insertFlowHealthRegressionSnapshot).toHaveBeenCalledTimes(1);
  });

  it('writes a new row when the sample changes', () => {
    let stored: any;
    (getLatestFlowHealthRegressionSnapshot as any).mockImplementation(
      () => stored,
    );
    (insertFlowHealthRegressionSnapshot as any).mockImplementation(
      (row: any) => {
        stored = { id: 'snap-1', ...row };
      },
    );

    (getStandardSessionWallClockSample as any).mockReturnValue({
      durationsMs: [10 * MS, 20 * MS, 30 * MS],
      excludedArtifactCount: 0,
    });
    const job = new FlowHealthRegressionSnapshotJob();
    job.runOnce();

    (getStandardSessionWallClockSample as any).mockReturnValue({
      durationsMs: [10 * MS, 20 * MS, 30 * MS],
      excludedArtifactCount: 1,
    });
    job.runOnce();

    expect(insertFlowHealthRegressionSnapshot).toHaveBeenCalledTimes(2);
  });
});

describe('FlowHealthRegressionSnapshotJob registration', () => {
  it('registers with the Scheduler at a fixed 24-hour interval', () => {
    const registered: any[] = [];
    const scheduler = { register: (opts: any) => registered.push(opts) };

    const job = new FlowHealthRegressionSnapshotJob();
    job.register(scheduler as any);

    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe('flow_health_regression_snapshot');
    expect(registered[0].intervalMs).toBe(24 * 60 * 60 * 1000);
  });
});
