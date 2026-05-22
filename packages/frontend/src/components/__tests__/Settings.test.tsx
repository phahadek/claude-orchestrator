import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Settings } from '../Settings';

vi.mock('../Settings/ProjectsSettingsPanel', () => ({
  ProjectsSettingsPanel: () => <div>ProjectsSettingsPanel</div>,
}));

const defaultSettings = {
  max_concurrent_code_sessions: '4',
  auto_review_concurrency: '2',
  auto_review: 'false',
  card_preview_lines: '5',
  code_session_model: '',
  review_session_model: '',
  session_mode: 'cli',
  auto_launch_concurrency: '1',
  auto_launch_poll_interval_ms: '60000',
  session_notify_threshold_seconds: '1800',
  session_pause_threshold_seconds: '3600',
  session_hard_stop_window_seconds: '300',
  ci_poll_interval_seconds: '30',
  ci_poll_max_minutes: '60',
};

function makeFetch(getBody: object = defaultSettings, patchBody: object = {}) {
  return vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
    if (!opts || opts.method !== 'PATCH') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(getBody),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({ updated: patchBody, current: getBody }),
    });
  });
}

describe('Settings — auto-launch inputs', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', makeFetch());
    vi.stubGlobal('localStorage', {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
  });

  it('renders auto_launch_concurrency input with the value from the API', async () => {
    render(<Settings />);
    const input = await screen.findByDisplayValue('1');
    expect(input).toBeDefined();
  });

  it('renders auto_launch_poll_interval_ms input with the value from the API', async () => {
    render(<Settings />);
    const input = await screen.findByDisplayValue('60000');
    expect(input).toBeDefined();
  });

  it('fires PATCH with auto_launch_concurrency when a valid value is entered', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<Settings />);
    await screen.findByDisplayValue('1');

    const inputs = screen.getAllByRole('spinbutton');
    const concurrencyInput = inputs.find(
      (el) => (el as HTMLInputElement).value === '1',
    )!;
    fireEvent.change(concurrencyInput, { target: { value: '3' } });

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([, opts]) =>
          opts &&
          opts.method === 'PATCH' &&
          JSON.parse(opts.body as string).auto_launch_concurrency === '3',
      );
      expect(patchCall).toBeDefined();
    });
  });

  it('fires PATCH with auto_launch_poll_interval_ms when a valid value is entered', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<Settings />);
    await screen.findByDisplayValue('60000');

    const inputs = screen.getAllByRole('spinbutton');
    const pollInput = inputs.find(
      (el) => (el as HTMLInputElement).value === '60000',
    )!;
    fireEvent.change(pollInput, { target: { value: '10000' } });

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([, opts]) =>
          opts &&
          opts.method === 'PATCH' &&
          JSON.parse(opts.body as string).auto_launch_poll_interval_ms === '10000',
      );
      expect(patchCall).toBeDefined();
    });
  });

  it('shows inline error and does not PATCH when concurrency is set to 0', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<Settings />);
    await screen.findByDisplayValue('1');

    const inputs = screen.getAllByRole('spinbutton');
    const concurrencyInput = inputs.find(
      (el) => (el as HTMLInputElement).value === '1',
    )!;
    fireEvent.change(concurrencyInput, { target: { value: '0' } });

    await waitFor(() => {
      expect(screen.getByText('Minimum is 1')).toBeDefined();
    });
    const patchCall = fetchMock.mock.calls.find(
      ([, opts]) =>
        opts &&
        opts.method === 'PATCH' &&
        'auto_launch_concurrency' in JSON.parse(opts.body as string),
    );
    expect(patchCall).toBeUndefined();
  });

  it('shows inline error and does not PATCH when poll interval is below 5000', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<Settings />);
    await screen.findByDisplayValue('60000');

    const inputs = screen.getAllByRole('spinbutton');
    const pollInput = inputs.find(
      (el) => (el as HTMLInputElement).value === '60000',
    )!;
    fireEvent.change(pollInput, { target: { value: '1000' } });

    await waitFor(() => {
      expect(screen.getByText('Minimum is 5000 ms')).toBeDefined();
    });
    const patchCall = fetchMock.mock.calls.find(
      ([, opts]) =>
        opts &&
        opts.method === 'PATCH' &&
        'auto_launch_poll_interval_ms' in JSON.parse(opts.body as string),
    );
    expect(patchCall).toBeUndefined();
  });

  it('does not PATCH when concurrency is set to a negative number', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<Settings />);
    await screen.findByDisplayValue('1');

    const inputs = screen.getAllByRole('spinbutton');
    const concurrencyInput = inputs.find(
      (el) => (el as HTMLInputElement).value === '1',
    )!;
    fireEvent.change(concurrencyInput, { target: { value: '-1' } });

    await waitFor(() => {
      expect(screen.getByText('Minimum is 1')).toBeDefined();
    });
    const patchCall = fetchMock.mock.calls.find(
      ([, opts]) =>
        opts &&
        opts.method === 'PATCH' &&
        'auto_launch_concurrency' in JSON.parse(opts.body as string),
    );
    expect(patchCall).toBeUndefined();
  });
});
