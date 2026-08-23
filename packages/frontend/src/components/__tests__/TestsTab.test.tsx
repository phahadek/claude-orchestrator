import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestsTab } from '../TestsTab';
import { apiRequest } from '../../api/projects';

vi.mock('../../api/projects', () => ({
  apiRequest: vi.fn(),
}));

describe('TestsTab', () => {
  beforeEach(() => {
    vi.mocked(apiRequest).mockReset();
  });

  it('renders the cycle counter and run outcome badges', async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      cycleCount: 2,
      cycleLimit: 5,
      runs: [
        {
          id: 'run-1',
          sessionId: 'sess-1',
          contentHash: 'hash-1',
          startedAt: 1000,
          finishedAt: 2000,
          durationMs: 1000,
          concurrentRunCount: 0,
          outcome: 'passed',
          nextAction: 'No action needed — all tests passed.',
          testResults: [],
        },
      ],
    });

    render(<TestsTab projectId="proj-1" sessionId="sess-1" />);

    await waitFor(() =>
      expect(screen.getByTestId('tests-tab-cycle-counter')).toBeTruthy(),
    );
    expect(screen.getByTestId('tests-tab-cycle-counter').textContent).toContain(
      '2 of 5',
    );
    expect(screen.getByTestId('test-run-outcome-run-1').textContent).toBe(
      'Passed',
    );
  });

  it('renders an explicit labelled state for failed-with-no-report-acquired, never a bare empty table', async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      cycleCount: 1,
      cycleLimit: 5,
      runs: [
        {
          id: 'run-2',
          sessionId: 'sess-1',
          contentHash: 'hash-2',
          startedAt: 1000,
          finishedAt: 1500,
          durationMs: 500,
          concurrentRunCount: 0,
          outcome: 'failed-with-no-report-acquired',
          nextAction: 'No per-test report was produced.',
          testResults: [],
        },
      ],
    });

    render(<TestsTab projectId="proj-1" sessionId="sess-1" />);

    await waitFor(() =>
      expect(screen.getByTestId('test-run-no-report-run-2')).toBeTruthy(),
    );
  });

  it('renders a not-yet-run empty state when there is no session', () => {
    render(<TestsTab projectId="proj-1" sessionId={null} />);
    expect(apiRequest).not.toHaveBeenCalled();
  });
});
