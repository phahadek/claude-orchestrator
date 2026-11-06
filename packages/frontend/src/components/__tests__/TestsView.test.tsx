import { render, screen, waitFor } from '@testing-library/react';
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

  it('renders an empty state when there is no active project', () => {
    render(<TestsView activeProjectId={null} />);
    expect(apiRequest).not.toHaveBeenCalled();
  });
});
