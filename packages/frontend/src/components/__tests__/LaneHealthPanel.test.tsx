import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { LaneHealthPanel } from '../LaneHealthPanel';
import { apiRequest } from '../../api/projects';
import { fileFlakyInvestigation } from '../../api/flakyInvestigation';

vi.mock('../../api/projects', () => ({
  apiRequest: vi.fn(),
}));

vi.mock('../../api/flakyInvestigation', () => ({
  fileFlakyInvestigation: vi.fn(),
}));

const baseRollup = {
  project: 'proj-1',
  totalRuns: 10,
  passRate: 0.9,
  timeoutRate: 0,
  queueWaitMs: { p50: 10, p90: 20, p99: 30, sampleCount: 10 },
  executionTimeMs: { p50: 100, p90: 200, p99: 300, sampleCount: 10 },
  regressedTests: [],
  flakyTests: { count: 0, tests: [] },
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

  it('renders a flagged flaky test in the rollup', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...baseRollup,
      flakyTests: {
        count: 1,
        tests: [
          {
            testId: 'test-a',
            name: 'suite > flaky test',
            sampleCount: 4,
            transitionCount: 3,
          },
        ],
      },
    });

    render(<LaneHealthPanel projectId="proj-1" />);

    await waitFor(() =>
      expect(screen.getByTestId('flaky-tests-section')).toBeTruthy(),
    );
    expect(screen.getByText('suite > flaky test')).toBeTruthy();
    expect(screen.getByText('1 test flagged flaky')).toBeTruthy();
  });

  it('renders nothing extra when there are no flagged flaky tests', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...baseRollup,
      flakyTests: { count: 0, tests: [] },
    });

    render(<LaneHealthPanel projectId="proj-1" />);

    await waitFor(() =>
      expect(screen.getByText(/runs? considered/)).toBeTruthy(),
    );
    expect(screen.queryByTestId('flaky-tests-section')).toBeNull();
  });

  it('fires a group investigation for the selected flaky tests', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...baseRollup,
      flakyTests: {
        count: 2,
        tests: [
          {
            testId: 'test-a',
            name: 'suite > flaky test a',
            sampleCount: 4,
            transitionCount: 3,
          },
          {
            testId: 'test-b',
            name: 'suite > flaky test b',
            sampleCount: 5,
            transitionCount: 4,
          },
        ],
      },
    });
    vi.mocked(fileFlakyInvestigation).mockResolvedValueOnce({
      taskId: 'task-123',
    });

    render(
      <LaneHealthPanel projectId="proj-1" milestoneId="proj-1:board-m1" />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('flaky-tests-section')).toBeTruthy(),
    );

    const fireButton = screen.getByTestId(
      'flaky-fire-investigation',
    ) as HTMLButtonElement;
    expect(fireButton.disabled).toBe(true);

    fireEvent.click(screen.getByTestId('flaky-test-checkbox-test-a'));
    expect(fireButton.disabled).toBe(false);

    fireEvent.click(fireButton);

    await waitFor(() =>
      expect(screen.getByTestId('flaky-fire-investigation-success')).toBeTruthy(),
    );
    expect(fileFlakyInvestigation).toHaveBeenCalledWith(
      'proj-1',
      'proj-1:board-m1',
      ['test-a'],
    );
    expect(fireButton.disabled).toBe(true);
  });

  it('selects and deselects all flaky tests via the header checkbox', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...baseRollup,
      flakyTests: {
        count: 2,
        tests: [
          {
            testId: 'test-a',
            name: 'suite > flaky test a',
            sampleCount: 4,
            transitionCount: 3,
          },
          {
            testId: 'test-b',
            name: 'suite > flaky test b',
            sampleCount: 5,
            transitionCount: 4,
          },
        ],
      },
    });

    render(
      <LaneHealthPanel projectId="proj-1" milestoneId="proj-1:board-m1" />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('flaky-tests-section')).toBeTruthy(),
    );

    fireEvent.click(screen.getByTestId('flaky-select-all'));
    expect(
      (screen.getByTestId('flaky-test-checkbox-test-a') as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (screen.getByTestId('flaky-test-checkbox-test-b') as HTMLInputElement)
        .checked,
    ).toBe(true);

    fireEvent.click(screen.getByTestId('flaky-select-all'));
    expect(
      (screen.getByTestId('flaky-test-checkbox-test-a') as HTMLInputElement)
        .checked,
    ).toBe(false);
  });

  it('disables the fire-investigation control without a milestoneId', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...baseRollup,
      flakyTests: {
        count: 1,
        tests: [
          {
            testId: 'test-a',
            name: 'suite > flaky test',
            sampleCount: 4,
            transitionCount: 3,
          },
        ],
      },
    });

    render(<LaneHealthPanel projectId="proj-1" />);

    await waitFor(() =>
      expect(screen.getByTestId('flaky-tests-section')).toBeTruthy(),
    );

    fireEvent.click(screen.getByTestId('flaky-test-checkbox-test-a'));
    expect(
      (screen.getByTestId('flaky-fire-investigation') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
