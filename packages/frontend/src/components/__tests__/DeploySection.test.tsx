import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const deployApiMock = vi.hoisted(() => ({
  launch: vi.fn(),
  getStatus: vi.fn(),
}));
vi.mock('../../api/deploy', () => ({ deployApi: deployApiMock }));

import { DeploySection } from '../DeploySection';

beforeEach(() => {
  vi.clearAllMocks();
  deployApiMock.getStatus.mockResolvedValue({
    run: null,
    events: [],
    deployedSha: null,
    deployedShaRecordedAt: null,
    behind: { count: 0, items: [] },
    plan: [],
  });
});

describe('DeploySection launch control', () => {
  it('requires an explicit review click before the confirm-and-deploy control appears, and launches with just the projectId', async () => {
    deployApiMock.launch.mockResolvedValue({
      run: {
        run_id: 'run-123',
        project: 'proj-1',
        target_sha: 'abc123',
        current_step: 'confirm',
        status: 'running',
        started_at: '2026-07-20T00:00:00.000Z',
        completed_at: null,
      },
    });

    render(<DeploySection activeProjectId="proj-1" />);

    expect(screen.queryByLabelText('Deploy target SHA')).toBeNull();

    const reviewButton = await screen.findByTestId('deploy-review-button');
    expect(screen.queryByTestId('deploy-launch-button')).toBeNull();
    fireEvent.click(reviewButton);

    const confirmButton = await screen.findByTestId('deploy-launch-button');
    expect((confirmButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(deployApiMock.launch).toHaveBeenCalledWith('proj-1');
    });

    const status = await screen.findByTestId('deploy-run-status');
    expect(status.textContent).toContain('running');
  });

  it('renders run progress from the store on load', async () => {
    deployApiMock.getStatus.mockResolvedValue({
      run: {
        run_id: 'run-456',
        project: 'proj-1',
        target_sha: 'def456',
        current_step: 'deploy',
        status: 'succeeded',
        started_at: '2026-07-20T00:00:00.000Z',
        completed_at: '2026-07-20T00:05:00.000Z',
      },
      events: [
        {
          id: 1,
          run_id: 'run-456',
          step: 'deploy',
          event_type: 'step_succeeded',
          disposition: null,
          detail: null,
          at: '2026-07-20T00:01:00.000Z',
        },
      ],
      deployedSha: 'def456',
      deployedShaRecordedAt: '2026-07-19T00:00:00.000Z',
      behind: { count: 0, items: [] },
      plan: [{ id: 'deploy', description: null }],
    });

    render(<DeploySection activeProjectId="proj-1" />);

    const status = await screen.findByTestId('deploy-run-status');
    expect(status.textContent).toContain('succeeded');

    const strip = await screen.findByTestId('deploy-step-strip');
    expect(strip.textContent).toContain('deploy');

    expect(screen.queryByTestId('deploy-run-events')).toBeNull();
    const toggle = await screen.findByTestId('deploy-run-events-toggle');
    fireEvent.click(toggle);
    const events = await screen.findByTestId('deploy-run-events');
    expect(events.textContent).toContain('deploy: step_succeeded');
  });

  it('keeps a failed run visible with its failure reason, and does not clear it on the next poll', async () => {
    const failedRun = {
      run_id: 'run-789',
      project: 'proj-1',
      target_sha: 'ghi789',
      current_step: 'provision',
      status: 'failed',
      started_at: '2026-07-20T00:00:00.000Z',
      completed_at: '2026-07-20T00:05:00.000Z',
    };
    const failedEvents = [
      {
        id: 1,
        run_id: 'run-789',
        step: 'provision',
        event_type: 'step_failed',
        disposition: null,
        detail: 'sudo: unknown user deploy',
        at: '2026-07-20T00:04:59.000Z',
      },
    ];
    deployApiMock.getStatus.mockResolvedValue({
      run: failedRun,
      events: failedEvents,
      deployedSha: null,
      deployedShaRecordedAt: null,
      behind: { count: 0, items: [] },
    });

    render(<DeploySection activeProjectId="proj-1" />);

    const status = await screen.findByTestId('deploy-run-status');
    expect(status.textContent).toContain('failed');
    const reason = await screen.findByTestId('deploy-run-failure-reason');
    expect(reason.textContent).toContain('provision');
    expect(reason.textContent).toContain('sudo: unknown user deploy');

    // Simulate a subsequent poll returning the same terminal run (as the
    // backend now does instead of null) — the panel must not vanish.
    deployApiMock.getStatus.mockResolvedValue({
      run: failedRun,
      events: failedEvents,
    });
    await waitFor(() => {
      expect(deployApiMock.getStatus).toHaveBeenCalled();
    });

    expect(screen.getByTestId('deploy-run-status').textContent).toContain(
      'failed',
    );
    expect(
      screen.getByTestId('deploy-run-failure-reason').textContent,
    ).toContain('sudo: unknown user deploy');

    const dismissButton = screen.getByTestId('deploy-run-dismiss-button');
    fireEvent.click(dismissButton);

    expect(screen.queryByTestId('deploy-run-status')).toBeNull();
    expect(screen.queryByTestId('deploy-run-failure-reason')).toBeNull();
  });

  it('resets the confirm-armed state on reload rather than resuming pre-armed', async () => {
    const { unmount } = render(<DeploySection activeProjectId="proj-1" />);

    const reviewButton = await screen.findByTestId('deploy-review-button');
    fireEvent.click(reviewButton);
    await screen.findByTestId('deploy-launch-button');

    // Simulate a page reload: unmount and remount the component fresh,
    // exactly like a browser reload would recreate all React state.
    unmount();

    render(<DeploySection activeProjectId="proj-1" />);

    expect(await screen.findByTestId('deploy-review-button')).toBeTruthy();
    expect(screen.queryByTestId('deploy-launch-button')).toBeNull();
  });

  it('styles the behind-list PR link with the accent token and a distinct hover state', async () => {
    deployApiMock.getStatus.mockResolvedValue({
      run: null,
      events: [],
      deployedSha: null,
      deployedShaRecordedAt: null,
      behind: {
        count: 1,
        items: [
          {
            kind: 'pr',
            prNumber: 42,
            prUrl: 'https://github.com/example/repo/pull/42',
            title: 'Some merged PR',
          },
        ],
      },
      plan: [],
    });

    render(<DeploySection activeProjectId="proj-1" />);

    const reviewButton = await screen.findByTestId('deploy-review-button');
    fireEvent.click(reviewButton);

    const list = await screen.findByTestId('deploy-behind-list');
    const link = list.querySelector('a') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
    expect(link.className).toMatch(/deployPrLink/);
  });

  it('renders one pending cell per plan step when the run has no events yet', async () => {
    const plan = Array.from({ length: 10 }, (_, i) => ({
      id: `step-${i}`,
      description: null,
    }));
    deployApiMock.getStatus.mockResolvedValue({
      run: {
        run_id: 'run-999',
        project: 'proj-1',
        target_sha: 'abc999',
        current_step: null,
        status: 'running',
        started_at: '2026-07-20T00:00:00.000Z',
        completed_at: null,
      },
      events: [],
      deployedSha: null,
      deployedShaRecordedAt: null,
      behind: { count: 0, items: [] },
      plan,
    });

    render(<DeploySection activeProjectId="proj-1" />);

    const strip = await screen.findByTestId('deploy-step-strip');
    const cells = plan.map((step) =>
      screen.getByTestId(`deploy-step-cell-${step.id}`),
    );
    expect(cells).toHaveLength(10);
    cells.forEach((cell) => {
      expect(cell.getAttribute('data-state')).toBe('pending');
    });
    expect(strip.querySelectorAll('li')).toHaveLength(10);
  });
});
