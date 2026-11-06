import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestsView } from '../TestsView';
import { TestsHealthTab } from '../TestsHealthTab';
import { apiRequest } from '../../api/projects';

vi.mock('../../api/projects', () => ({
  apiRequest: vi.fn(),
}));

const zeroBands = {
  executed_passed: 0,
  executed_failed: 0,
  executed_failed_all_excused: 0,
  oom_or_timeout: 0,
  no_verdict: 0,
  nothing_exercised: 0,
  reused: 0,
};

function mockHealth(
  days: unknown[],
  windowDays = 30,
  extra: Record<string, unknown> = {},
) {
  vi.mocked(apiRequest).mockImplementation(async (input) => {
    const path = String(input);
    if (path.includes('pass-rate-trend'))
      return { project: 'p', windowDays, runKinds: { full: days } } as never;
    if (path.includes('queue-wait'))
      return {
        project: 'p',
        windowDays,
        days: [
          { day: '2026-11-01', p50: 100, p90: 400, p99: 500, sampleCount: 3 },
        ],
      } as never;
    if (path.includes('slow-and-regressed'))
      return {
        slowest: [
          {
            testId: 't1',
            name: 'slow test',
            medianDurationMs: 5000,
            lastDurationMs: 6000,
            sampleCount: 9,
          },
        ],
        regressed: [],
        ...extra,
      } as never;
    return { runs: [] } as never;
  });
}

describe('TestsHealthTab', () => {
  beforeEach(() => {
    vi.mocked(apiRequest).mockReset();
  });

  it('renders each band with its legend entry and the tables', async () => {
    mockHealth([
      {
        day: '2026-11-01',
        bands: {
          executed_passed: 2,
          executed_failed: 2,
          executed_failed_all_excused: 1,
          oom_or_timeout: 1,
          no_verdict: 1,
          nothing_exercised: 1,
          reused: 1,
        },
        failedExcusalNotRetained: 1,
        excusedBySource: { flaky: 1 },
        passRate: 0.3,
      },
    ]);
    render(<TestsHealthTab projectId="p" />);

    await waitFor(() =>
      expect(screen.getByTestId('health-bar-full-2026-11-01')).toBeTruthy(),
    );
    const legend = screen.getByTestId('health-legend').textContent ?? '';
    for (const label of [
      'Executed – passed',
      'Executed – failed',
      'Failed (excusal not retained)',
      'All failures excused',
      'OOM / timeout',
      'No verdict',
      'Nothing exercised',
      'Reused',
    ]) {
      expect(legend).toContain(label);
    }
    for (const key of [
      'passed',
      'failed',
      'notRetained',
      'excused:flaky',
      'oom',
      'noVerdict',
      'nothingExercised',
      'reused',
    ]) {
      expect(screen.getByTestId(`health-band-${key}`)).toBeTruthy();
    }
    expect(screen.getByTestId('health-headline-full').textContent).toContain(
      '33%',
    );
    await waitFor(() =>
      expect(screen.getByTestId('health-slow').textContent).toContain(
        'slow test',
      ),
    );
    expect(screen.getByTestId('health-queue-wait-chart')).toBeTruthy();
  });

  it('shows no green on a reused-only day', async () => {
    mockHealth([
      {
        day: '2026-11-01',
        bands: { ...zeroBands, reused: 4 },
        failedExcusalNotRetained: 0,
        excusedBySource: {},
        passRate: null,
      },
    ]);
    render(<TestsHealthTab projectId="p" />);
    await waitFor(() =>
      expect(screen.getByTestId('health-band-reused')).toBeTruthy(),
    );
    expect(screen.queryByTestId('health-band-passed')).toBeNull();
    expect(screen.getByTestId('health-headline-full').textContent).toBe('—');
  });

  it('labels the excusal horizon only when the window exceeds 14 days', async () => {
    const day = {
      day: '2026-11-01',
      bands: { ...zeroBands, executed_passed: 1 },
      failedExcusalNotRetained: 0,
      excusedBySource: {},
      passRate: 1,
    };
    mockHealth([day], 30);
    const { unmount } = render(<TestsHealthTab projectId="p" />);
    await waitFor(() =>
      expect(screen.getByTestId('health-excusal-horizon')).toBeTruthy(),
    );
    unmount();

    mockHealth([day], 7);
    render(<TestsHealthTab projectId="p" />);
    await waitFor(() =>
      expect(screen.getByTestId('health-bar-full-2026-11-01')).toBeTruthy(),
    );
    expect(screen.queryByTestId('health-excusal-horizon')).toBeNull();
  });
});

describe('TestsView tabs', () => {
  beforeEach(() => {
    vi.mocked(apiRequest).mockReset();
  });

  it('preserves the Runs list when switching to Health and back', async () => {
    vi.mocked(apiRequest).mockImplementation(async (input) => {
      const path = String(input);
      if (path.includes('/tests/flakiest')) return { tests: [] } as never;
      if (path.includes('test-analytics')) {
        return (
          path.includes('slow-and-regressed')
            ? { slowest: [], regressed: [] }
            : path.includes('queue-wait')
              ? { project: 'p', windowDays: 30, days: [] }
              : { project: 'p', windowDays: 30, runKinds: {} }
        ) as never;
      }
      return {
        runs: [
          {
            id: 'run-1',
            projectId: 'p',
            sessionId: null,
            contentHash: 'h',
            state: 'passed',
            producer: 'pr_gate',
            runOrigin: 'pr_gate',
            requestedAt: 1,
            startedAt: 1,
            finishedAt: 2,
            durationMs: 1,
            outcome: 'passed',
            nextAction: 'ok',
            outcomeCounts: null,
          },
        ],
      } as never;
    });
    render(<TestsView activeProjectId="p" />);
    await waitFor(() =>
      expect(screen.getByTestId('project-test-run-run-1')).toBeTruthy(),
    );

    fireEvent.click(screen.getByTestId('tests-tab-health'));
    expect(screen.getByTestId('tests-health-tab')).toBeTruthy();
    expect(screen.queryByTestId('project-test-run-run-1')).toBeNull();

    fireEvent.click(screen.getByTestId('tests-tab-runs'));
    expect(await screen.findByTestId('project-test-run-run-1')).toBeTruthy();
  });
});
