import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { LaneHealthPanel } from '../LaneHealthPanel';
import { apiRequest } from '../../api/projects';

vi.mock('../../api/projects', () => ({
  apiRequest: vi.fn(),
}));

const baseRollup = {
  project: 'proj-1',
  totalRuns: 10,
  passRate: 0.9,
  timeoutRate: 0,
  queueWaitMs: { p50: 10, p90: 20, p99: 30, sampleCount: 10 },
  executionTimeMs: { p50: 100, p90: 200, p99: 300, sampleCount: 10 },
};

describe('LaneHealthPanel', () => {
  it('renders a regressed test in the rollup', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...baseRollup,
      regressedTests: [
        {
          testId: 'test-a',
          name: 'suite > slow test',
          medianDurationMs: 100,
          lastDurationMs: 900,
        },
      ],
    });

    render(<LaneHealthPanel projectId="proj-1" />);

    await waitFor(() =>
      expect(screen.getByTestId('lane-health-regressed-tests')).toBeTruthy(),
    );
    expect(screen.getByText('suite > slow test')).toBeTruthy();
    expect(screen.getByText('1 test regressed')).toBeTruthy();
  });

  it('renders nothing extra when there is no regression', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...baseRollup,
      regressedTests: [],
    });

    render(<LaneHealthPanel projectId="proj-1" />);

    await waitFor(() =>
      expect(screen.getByText(/runs? considered/)).toBeTruthy(),
    );
    expect(screen.queryByTestId('lane-health-regressed-tests')).toBeNull();
  });
});
