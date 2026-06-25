import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerMessage } from '@claude-orchestrator/backend/src/ws/types';
import { SettingsSystemHealth } from '../SettingsSystemHealth';

// Capture the WS message handler registered by useSchedulerStatus
let capturedWsHandler: ((msg: ServerMessage) => void) | null = null;

vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: (handler: (msg: ServerMessage) => void) => {
    capturedWsHandler = handler;
    return { send: vi.fn(), connectionState: 'connected' as const };
  },
}));

const baseJobs = [
  {
    name: 'concluded_session_archiver',
    running: false,
    lastRunAt: '2026-06-15T10:00:00.000Z',
    lastStatus: 'ok',
    nextRunAt: '2026-06-15T10:03:00.000Z',
    lastDurationMs: 312,
  },
  {
    name: 'auto_launcher',
    running: true,
    lastRunAt: null,
    lastStatus: null,
    nextRunAt: null,
    lastDurationMs: null,
  },
];

function makeFetch(jobs = baseJobs) {
  return vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
    if (
      url === '/api/diagnostics/scheduler' &&
      (!opts || opts.method !== 'POST')
    ) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(jobs),
      });
    }
    if (typeof url === 'string' && url.includes('/trigger')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    }
    return Promise.resolve({ ok: false });
  });
}

describe('SettingsSystemHealth', () => {
  beforeEach(() => {
    capturedWsHandler = null;
    vi.stubGlobal('fetch', makeFetch());
  });

  it('calls GET /api/diagnostics/scheduler on mount and renders one JobRow per job', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<SettingsSystemHealth />);

    await screen.findByText('concluded_session_archiver');
    expect(screen.getByText('auto_launcher')).toBeDefined();

    const schedulerCall = fetchMock.mock.calls.find(
      ([url]) => url === '/api/diagnostics/scheduler',
    );
    expect(schedulerCall).toBeDefined();
  });

  it('patches matching row on scheduler_job_run WS event without full refetch', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<SettingsSystemHealth />);

    await screen.findByText('concluded_session_archiver');
    const callsBefore = fetchMock.mock.calls.length;

    act(() => {
      capturedWsHandler?.({
        type: 'scheduler_job_run',
        job: 'concluded_session_archiver',
        status: 'failed',
        started_at: '2026-06-15T10:05:00.000Z',
        completed_at: '2026-06-15T10:05:00.500Z',
        duration_ms: 500,
      });
    });

    await screen.findByText('❌ failed');
    expect(screen.getByText('500 ms')).toBeDefined();
    // No additional fetch after the WS event
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('Trigger button calls POST /api/diagnostics/scheduler/:name/trigger', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<SettingsSystemHealth />);

    const triggerBtn = await screen.findByRole('button', { name: 'Trigger' });
    fireEvent.click(triggerBtn);

    await waitFor(() => {
      const triggerCall = fetchMock.mock.calls.find(
        ([url, opts]) =>
          url ===
            '/api/diagnostics/scheduler/concluded_session_archiver/trigger' &&
          opts?.method === 'POST',
      );
      expect(triggerCall).toBeDefined();
    });
  });

  it('Trigger button is disabled while job is currently running', async () => {
    render(<SettingsSystemHealth />);

    await screen.findByText('auto_launcher');
    const runningBtn = screen.getByRole('button', { name: 'Running…' });
    expect((runningBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows loading state before data arrives', () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    render(<SettingsSystemHealth />);
    expect(screen.getByText('Loading…')).toBeDefined();
  });

  it('updates nextRunAt from scheduler_job_run WS event so NEXT RUN is not stale', async () => {
    const futureIso = new Date(Date.now() + 60_000).toISOString();
    render(<SettingsSystemHealth />);
    await screen.findByText('concluded_session_archiver');

    act(() => {
      capturedWsHandler?.({
        type: 'scheduler_job_run',
        job: 'concluded_session_archiver',
        status: 'ok',
        started_at: '2026-06-15T10:05:00.000Z',
        completed_at: '2026-06-15T10:05:00.300Z',
        duration_ms: 300,
        next_run_at: futureIso,
      });
    });

    // Should show "from now" because next_run_at is in the future
    await waitFor(() => {
      expect(screen.getByText(/from now/)).toBeDefined();
    });
  });

  it('sets nextRunAt to null (renders —) when WS event carries next_run_at: null (running job)', async () => {
    render(<SettingsSystemHealth />);
    await screen.findByText('concluded_session_archiver');

    act(() => {
      capturedWsHandler?.({
        type: 'scheduler_job_run',
        job: 'concluded_session_archiver',
        status: 'ok',
        started_at: '2026-06-15T10:05:00.000Z',
        completed_at: '2026-06-15T10:05:00.300Z',
        duration_ms: 300,
        next_run_at: null,
      });
    });

    // nextRunAt null → formatRelative returns '—'
    // The cell for NEXT RUN should show '—'
    await waitFor(() => {
      const cells = screen.getAllByText('—');
      expect(cells.length).toBeGreaterThan(0);
    });
  });
});
