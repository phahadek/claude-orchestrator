import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const gateApiMock = vi.hoisted(() => ({
  listMilestoneReadiness: vi.fn().mockResolvedValue([]),
  getGateReadiness: vi.fn().mockResolvedValue(null),
  listGateItems: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1 }),
  getGateItemDetail: vi.fn(),
}));
vi.mock('../../api/gate', () => ({ gateApi: gateApiMock }));

const seedApiMock = vi.hoisted(() => ({
  listSeedMilestoneReadiness: vi.fn().mockResolvedValue([]),
  getSeedReadiness: vi.fn().mockResolvedValue(null),
  listSeedItems: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1 }),
}));
vi.mock('../../api/seed', () => ({ seedApi: seedApiMock }));

const deployApiMock = vi.hoisted(() => ({
  launch: vi.fn(),
  getStatus: vi.fn(),
}));
vi.mock('../../api/deploy', () => ({ deployApi: deployApiMock }));

import { GateReadinessPanel } from '../GateReadinessPanel';

beforeEach(() => {
  vi.clearAllMocks();
  gateApiMock.listMilestoneReadiness.mockResolvedValue([]);
  gateApiMock.listGateItems.mockResolvedValue({ items: [], total: 0, page: 1 });
  seedApiMock.listSeedMilestoneReadiness.mockResolvedValue([]);
  seedApiMock.listSeedItems.mockResolvedValue({ items: [], total: 0, page: 1 });
  deployApiMock.getStatus.mockResolvedValue({ run: null, events: [] });
});

describe('GateReadinessPanel deploy launch control', () => {
  it('launches a deploy_run with the entered target sha', async () => {
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

    render(<GateReadinessPanel activeProjectId="proj-1" />);

    const input = await screen.findByLabelText('Deploy target SHA');
    fireEvent.change(input, { target: { value: 'abc123' } });
    fireEvent.click(screen.getByTestId('deploy-launch-button'));

    await waitFor(() => {
      expect(deployApiMock.launch).toHaveBeenCalledWith('proj-1', 'abc123');
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
    });

    render(<GateReadinessPanel activeProjectId="proj-1" />);

    const status = await screen.findByTestId('deploy-run-status');
    expect(status.textContent).toContain('succeeded');
    const events = await screen.findByTestId('deploy-run-events');
    expect(events.textContent).toContain('deploy: step_succeeded');
  });
});
