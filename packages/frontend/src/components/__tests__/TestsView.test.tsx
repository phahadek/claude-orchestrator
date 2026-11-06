import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestsView } from '../TestsView';
import { apiRequest } from '../../api/projects';

vi.mock('../../api/projects', () => ({
  apiRequest: vi.fn(),
}));

describe('TestsView', () => {
  beforeEach(() => {
    vi.mocked(apiRequest).mockReset();
  });

  it('renders queued, running, and finished runs with outcome and producer labels', async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      runs: [
        {
          id: 'run-queued',
          projectId: 'proj-1',
          sessionId: 'sess-1',
          contentHash: 'hash-1',
          state: 'queued',
          producer: 'session_request',
          runOrigin: 'test_request',
          requestedAt: 900,
          startedAt: 900,
          finishedAt: null,
          durationMs: null,
          outcome: 'queued',
          nextAction:
            'Run is queued — waiting for a lane concurrency slot to open.',
          outcomeCounts: null,
        },
        {
          id: 'run-running',
          projectId: 'proj-1',
          sessionId: null,
          contentHash: 'hash-2',
          state: 'running',
          producer: 'pr_gate',
          runOrigin: 'pr_gate',
          requestedAt: 950,
          startedAt: 1000,
          finishedAt: null,
          durationMs: null,
          outcome: 'running',
          nextAction: 'Run is still in progress — wait for it to finish.',
          outcomeCounts: null,
        },
        {
          id: 'run-passed',
          projectId: 'proj-1',
          sessionId: null,
          contentHash: 'hash-3',
          state: 'passed',
          producer: 'base_health',
          runOrigin: 'base_health_probe',
          requestedAt: 1500,
          startedAt: 1500,
          finishedAt: 2500,
          durationMs: 1000,
          outcome: 'passed',
          nextAction: 'No action needed — all tests passed.',
          outcomeCounts: {
            passed: 5,
            failed: 0,
            skipped: 0,
            error: 0,
            other: 0,
            total: 5,
          },
        },
      ],
    });

    render(<TestsView activeProjectId="proj-1" />);

    await waitFor(() => expect(screen.getByTestId('tests-view')).toBeTruthy());

    expect(
      screen.getByTestId('project-test-run-outcome-run-queued').textContent,
    ).toBe('Queued');
    expect(
      screen.getByTestId('project-test-run-outcome-run-running').textContent,
    ).toBe('Running…');
    expect(
      screen.getByTestId('project-test-run-outcome-run-passed').textContent,
    ).toBe('Passed');

    expect(
      screen.getByTestId('project-test-run-producer-run-queued').textContent,
    ).toBe('Session');
    expect(
      screen.getByTestId('project-test-run-producer-run-running').textContent,
    ).toBe('PR gate');
    expect(
      screen.getByTestId('project-test-run-producer-run-passed').textContent,
    ).toBe('Base health');

    expect(
      screen.getByTestId('project-test-run-queue-position-run-queued')
        .textContent,
    ).toContain('1');
  });

  const baseRun = {
    projectId: 'proj-1',
    sessionId: null,
    contentHash: 'h',
    producer: 'session_request',
    runOrigin: 'test_request',
    requestedAt: 1,
    startedAt: 1,
    finishedAt: null,
    durationMs: null,
    nextAction: 'next',
    outcomeCounts: null,
  };

  it('shows cancel only on queued/running rows, renders cancelled distinctly, and handles 409', async () => {
    vi.mocked(apiRequest).mockImplementation((url: RequestInfo) =>
      String(url).includes('/cancel')
        ? Promise.reject(new Error('run already settled'))
        : Promise.resolve({
            runs: [
              { ...baseRun, id: 'q', state: 'queued', outcome: 'queued' },
              { ...baseRun, id: 'r', state: 'running', outcome: 'running' },
              {
                ...baseRun,
                id: 'p',
                state: 'passed',
                outcome: 'passed',
                finishedAt: 2,
              },
              {
                ...baseRun,
                id: 'c',
                state: 'failed',
                outcome: 'failed-with-no-report-acquired',
                failureReason: 'cancelled',
                cancelledBy: 'dev-1',
                finishedAt: 2,
              },
            ],
          }),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<TestsView activeProjectId="proj-1" />);
    await waitFor(() => expect(screen.getByTestId('tests-view')).toBeTruthy());

    expect(screen.getByTestId('project-test-run-cancel-q')).toBeTruthy();
    expect(screen.getByTestId('project-test-run-cancel-r')).toBeTruthy();
    expect(screen.queryByTestId('project-test-run-cancel-p')).toBeNull();
    expect(screen.queryByTestId('project-test-run-cancel-c')).toBeNull();
    expect(screen.getByTestId('project-test-run-outcome-c').textContent).toBe(
      'Cancelled',
    );
    expect(
      screen.getByTestId('project-test-run-cancelled-by-c').textContent,
    ).toContain('dev-1');

    fireEvent.click(screen.getByTestId('project-test-run-cancel-q'));
    await waitFor(() =>
      expect(screen.getByTestId('tests-view-cancel-notice').textContent).toBe(
        'That run already finished.',
      ),
    );
    expect(apiRequest).toHaveBeenCalledWith('/api/test-request-runs/q/cancel', {
      method: 'POST',
    });
  });

  it('renders an empty state when there is no active project', () => {
    render(<TestsView activeProjectId={null} />);
    expect(apiRequest).not.toHaveBeenCalled();
  });
});
