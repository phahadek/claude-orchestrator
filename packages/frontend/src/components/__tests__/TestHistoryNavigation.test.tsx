import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestsView } from '../TestsView';
import { TestsTab } from '../TestsTab';
import { apiRequest } from '../../api/projects';

vi.mock('../../api/projects', () => ({
  apiRequest: vi.fn(),
}));

const baseline = (id: string) => ({
  testId: id,
  name: `name-${id}`,
  medianDurationMs: 10,
  lastDurationMs: 10,
  sampleCount: 5,
});

const history = {
  testId: 'x',
  name: 'name-x',
  outcomeSamples: [{ sequencedAt: 1, outcome: 'F', durationMs: null }],
  durationSamples: [{ sequencedAt: 2, outcome: null, durationMs: 12 }],
  weeklyBuckets: [],
  failures: [],
  failureRetentionMs: 14 * 24 * 60 * 60 * 1000,
  failureHorizonMs: 1000,
};

function route(url: string) {
  if (url.includes('pass-rate-trend')) {
    return Promise.resolve({ project: 'p1', windowDays: 30, runKinds: {} });
  }
  if (url.includes('test-analytics/queue-wait')) {
    return Promise.resolve({ project: 'p1', windowDays: 30, days: [] });
  }
  if (url.includes('slow-and-regressed')) {
    return Promise.resolve({
      slowest: [baseline('slow1')],
      regressed: [baseline('reg1')],
    });
  }
  if (url.includes('/tests/flakiest')) {
    return Promise.resolve({
      tests: [
        {
          testId: 'flaky1',
          name: 'flaky',
          sampleCount: 10,
          transitionCount: 4,
          remediationTaskOpen: false,
        },
      ],
    });
  }
  if (url.includes('/tests/history')) return Promise.resolve(history);
  if (url.includes('/history?projectId')) {
    return Promise.resolve({
      cycleCount: 1,
      cycleLimit: 5,
      runs: [
        {
          id: 'r1',
          sessionId: 's',
          runKind: 'k',
          isPrPipelineRun: false,
          contentHash: 'h',
          startedAt: 1,
          finishedAt: 2,
          durationMs: 1,
          concurrentRunCount: null,
          outcome: 'passed',
          nextAction: '',
          testResults: [
            {
              testId: 'tab1',
              name: 'tab test',
              outcome: 'passed',
              durationMs: 1,
              flipRate: null,
            },
          ],
          testResultsTruncated: false,
          totalTestResultCount: 1,
        },
      ],
    });
  }
  return Promise.resolve({ runs: [] });
}

describe('per-test history navigation', () => {
  beforeEach(() => {
    vi.mocked(apiRequest).mockReset();
    vi.mocked(apiRequest).mockImplementation(((url: string) =>
      route(url)) as never);
  });

  it.each([
    ['health-regressed-row-reg1', 'reg1'],
    ['health-slow-row-slow1', 'slow1'],
    ['flaky-row-flaky1', 'flaky1'],
  ])('opens history from %s', async (rowTestId, testId) => {
    render(<TestsView activeProjectId="p1" />);
    fireEvent.click(screen.getByText('Health'));
    fireEvent.click(await screen.findByTestId(rowTestId));
    expect(await screen.findByTestId('test-history-view')).toBeTruthy();
    expect(vi.mocked(apiRequest)).toHaveBeenCalledWith(
      expect.stringContaining(`testId=${testId}`),
    );
    expect(
      await screen.findByTestId('test-history-failure-horizon'),
    ).toBeTruthy();
  });

  it('opens history from TestsTab per-test rows', async () => {
    render(<TestsTab projectId="p1" sessionId="s1" />);
    fireEvent.click(await screen.findByTestId('test-result-tab1'));
    await waitFor(() =>
      expect(screen.getByTestId('test-history-view')).toBeTruthy(),
    );
    expect(vi.mocked(apiRequest)).toHaveBeenCalledWith(
      expect.stringContaining('testId=tab1'),
    );
  });
});
