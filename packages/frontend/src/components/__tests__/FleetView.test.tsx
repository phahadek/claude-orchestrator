import { render, screen, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const gateApiMock = vi.hoisted(() => ({
  getFleetState: vi.fn(),
}));
vi.mock('../../api/gate', () => ({ gateApi: gateApiMock }));

vi.mock('../../api/projects', () => ({
  authedFetch: vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ max_concurrent_verify_sessions: '5' }),
  }),
}));

import { FleetView } from '../FleetView';

function makeSession(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sessionId: 'sess-1',
    itemId: 'item-1',
    project: 'proj-1',
    milestone: 'M12',
    text: 'gate item text',
    status: 'running',
    startedAt: Date.now() - 60_000,
    elapsedMs: 60_000,
    remainingMs: 19 * 60_000,
    suspended: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  gateApiMock.getFleetState.mockResolvedValue({
    liveCount: 0,
    sessions: [],
    skippedForBudgetHistory: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FleetView', () => {
  it('renders the empty state when no sessions are in flight', async () => {
    render(<FleetView />);
    await screen.findByText(
      'No in-flight gate-verify sessions across any project.',
    );
  });

  it('renders a populated multi-project state', async () => {
    gateApiMock.getFleetState.mockResolvedValue({
      liveCount: 2,
      sessions: [
        makeSession({
          sessionId: 'sess-1',
          project: 'proj-1',
          milestone: 'M12',
          text: 'gate item one',
        }),
        makeSession({
          sessionId: 'sess-2',
          project: 'proj-2',
          milestone: 'M4',
          text: 'gate item two',
          suspended: true,
        }),
      ],
      skippedForBudgetHistory: [],
    });

    render(<FleetView />);

    await screen.findByText('gate item one');
    expect(screen.getByText('gate item two')).toBeTruthy();
    expect(screen.getByText('proj-1')).toBeTruthy();
    expect(screen.getByText('proj-2')).toBeTruthy();
    expect(screen.getByText('Suspended')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('fleet-live-count').textContent).toBe(
        '2 live / cap 5',
      );
    });
  });

  it('ticks elapsed/remaining locally without issuing an additional fetch', async () => {
    gateApiMock.getFleetState.mockResolvedValue({
      liveCount: 1,
      sessions: [
        makeSession({
          sessionId: 'sess-1',
          project: 'proj-1',
          milestone: 'M12',
          text: 'gate item one',
          startedAt: Date.now(),
          elapsedMs: 0,
          remainingMs: 20 * 60_000,
        }),
      ],
      skippedForBudgetHistory: [],
    });

    vi.useFakeTimers();
    render(<FleetView />);
    // The initial fetch and its state update run on real microtasks even
    // under fake timers, so let them flush before advancing the clock.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('gate item one')).toBeTruthy();

    const callCountAfterInitialFetch =
      gateApiMock.getFleetState.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    const row = screen.getByText('gate item one').closest('tr');
    expect(row?.textContent).toContain('0:05');
    expect(gateApiMock.getFleetState.mock.calls.length).toBe(
      callCountAfterInitialFetch,
    );
  });
});
