import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const wrapApiMock = vi.hoisted(() => ({
  launch: vi.fn(),
  confirm: vi.fn(),
  getStatus: vi.fn(),
}));
vi.mock('../../api/wrap', () => ({ wrapApi: wrapApiMock }));

const convergenceMock = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useMilestoneConvergence', () => ({
  useMilestoneConvergence: (...args: unknown[]) => convergenceMock(...args),
}));

import { WrapSection } from '../WrapSection';

const GREEN_AXES = {
  tasks: { status: 'green', open: 0, closed: 3, blocking: [] },
  gate: {
    status: 'green',
    blockingCount: 0,
    parkedCount: 0,
    bespokeCount: 0,
    counts: {},
    blocking: [],
  },
  seed: { status: 'green', blockingCount: 0, blocking: [] },
  ops: { status: 'green', blockingCount: 0, blocking: [] },
  investigationReport: { status: 'green', blockingCount: 0, blocking: [] },
};

function fillInputs() {
  fireEvent.change(screen.getByTestId('wrap-next-milestone-input'), {
    target: { value: 'M13' },
  });
  fireEvent.change(screen.getByTestId('wrap-release-version-input'), {
    target: { value: '1.9.0' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  wrapApiMock.getStatus.mockResolvedValue({ run: null, events: [] });
});

describe('WrapSection launch gating', () => {
  it('enables the review-wrap button when the real 5-axis convergence read is allGreen', async () => {
    convergenceMock.mockReturnValue({
      convergence: {
        project: 'proj-1',
        milestone: 'M12',
        status: 'green',
        distanceToGreen: 0,
        axes: GREEN_AXES,
      },
      loading: false,
      error: null,
      refetch: () => {},
    });

    render(<WrapSection activeProjectId="proj-1" closingMilestoneId="M12" />);
    fillInputs();

    const reviewButton = await screen.findByTestId('wrap-review-button');
    expect((reviewButton as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the review-wrap button disabled when the gate+seed axes are green but another axis (e.g. ops) is not — the narrower composite would have said ready, allGreen must not', async () => {
    convergenceMock.mockReturnValue({
      convergence: {
        project: 'proj-1',
        milestone: 'M12',
        status: 'blocked',
        distanceToGreen: 0,
        axes: {
          ...GREEN_AXES,
          ops: {
            status: 'blocked',
            blockingCount: 1,
            blocking: ['pending ops task'],
          },
        },
      },
      loading: false,
      error: null,
      refetch: () => {},
    });

    render(<WrapSection activeProjectId="proj-1" closingMilestoneId="M12" />);
    fillInputs();

    const reviewButton = await screen.findByTestId('wrap-review-button');
    expect((reviewButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('names the specific blocking axes when the milestone is not allGreen', async () => {
    convergenceMock.mockReturnValue({
      convergence: {
        project: 'proj-1',
        milestone: 'M12',
        status: 'blocked',
        distanceToGreen: 2,
        axes: {
          ...GREEN_AXES,
          tasks: {
            status: 'blocked',
            open: 2,
            closed: 3,
            blocking: [{ id: 't1', title: 'task', status: 'In Progress' }],
          },
          investigationReport: {
            status: 'blocked',
            blockingCount: 1,
            blocking: [{ id: 'r1', title: 'report', state: 'open' }],
          },
        },
      },
      loading: false,
      error: null,
      refetch: () => {},
    });

    render(<WrapSection activeProjectId="proj-1" closingMilestoneId="M12" />);

    const blockingAxes = await screen.findByTestId('wrap-blocking-axes');
    expect(blockingAxes.textContent).toContain('tasks');
    expect(blockingAxes.textContent).toContain('investigationReport');
    expect(blockingAxes.textContent).not.toContain('gate');
    expect(blockingAxes.textContent).not.toContain('seed');
  });
});
