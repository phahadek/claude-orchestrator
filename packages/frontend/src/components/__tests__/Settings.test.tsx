import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Settings } from '../Settings';
import { validateField } from '../Settings.helpers';

vi.mock('../Settings/ProjectsSettingsPanel', () => ({
  ProjectsSettingsPanel: () => <div>ProjectsSettingsPanel</div>,
}));

vi.mock('../../pages/SettingsSystemHealth', () => ({
  SettingsSystemHealth: () => <div>SettingsSystemHealth</div>,
}));

vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ send: vi.fn(), connectionState: 'connected' }),
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
  max_review_iterations: '3',
  auto_archive_enabled: 'false',
  auto_archive_grace_minutes: '10',
  auto_archive_sweep_interval_minutes: '5',
  large_task_model: '',
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
      json: () => Promise.resolve({ updated: patchBody, current: getBody }),
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
          JSON.parse(opts.body as string).auto_launch_poll_interval_ms ===
            '10000',
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

describe('validateField — non-numeric keys', () => {
  it('returns null for code_session_model with a model string', () => {
    expect(validateField('code_session_model', 'claude-opus-4-6')).toBeNull();
  });

  it('returns null for review_session_model with a model string', () => {
    expect(
      validateField('review_session_model', 'claude-sonnet-4-6'),
    ).toBeNull();
  });

  it('returns null for large_task_model with a model string', () => {
    expect(validateField('large_task_model', 'claude-opus-4-8[1m]')).toBeNull();
  });

  it('returns null for auto_review with "true"', () => {
    expect(validateField('auto_review', 'true')).toBeNull();
  });

  it('returns null for auto_archive_enabled with "false"', () => {
    expect(validateField('auto_archive_enabled', 'false')).toBeNull();
  });

  it('returns null for session_mode with "api"', () => {
    expect(validateField('session_mode', 'api')).toBeNull();
  });

  it('still returns an error for a numeric field given a non-integer', () => {
    expect(validateField('max_concurrent_code_sessions', 'abc')).toBe(
      'Must be a whole number',
    );
  });

  it('still returns minimum error for auto_launch_concurrency set to 0', () => {
    expect(validateField('auto_launch_concurrency', '0')).toBe('Minimum is 1');
  });
});

describe('Settings — non-numeric settings PATCH', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', makeFetch());
    vi.stubGlobal('localStorage', {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
  });

  it('fires PATCH when the auto_review toggle is clicked', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<Settings />);

    const toggles = await screen.findAllByRole('button', { name: 'Off' });
    fireEvent.click(toggles[0]);

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([, opts]) =>
          opts &&
          opts.method === 'PATCH' &&
          JSON.parse(opts.body as string).auto_review === 'true',
      );
      expect(patchCall).toBeDefined();
    });
  });

  it('fires PATCH when a large_task_model is selected', async () => {
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<Settings />);

    await screen.findByText('(off)');
    const selects = screen.getAllByRole('combobox');
    const largeTaskSelect = selects.find((el) =>
      Array.from((el as HTMLSelectElement).options).some(
        (o) => o.text === '(off)',
      ),
    )!;
    fireEvent.change(largeTaskSelect, {
      target: { value: 'claude-opus-4-8[1m]' },
    });

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([, opts]) =>
          opts &&
          opts.method === 'PATCH' &&
          JSON.parse(opts.body as string).large_task_model ===
            'claude-opus-4-8[1m]',
      );
      expect(patchCall).toBeDefined();
    });
  });
});

describe('Settings — System Health peer tab', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', makeFetch());
    vi.stubGlobal('localStorage', {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
  });

  it('renders the System Health tab in the nav', async () => {
    render(<Settings />);
    await screen.findByRole('button', { name: 'General' });
    expect(screen.getByRole('button', { name: 'System Health' })).toBeDefined();
  });

  it('shows SettingsSystemHealth when System Health tab is selected', async () => {
    render(<Settings />);
    const tab = await screen.findByRole('button', { name: 'System Health' });
    fireEvent.click(tab);
    expect(screen.getByText('SettingsSystemHealth')).toBeDefined();
  });

  it('does not show SettingsSystemHealth when General tab is active', async () => {
    render(<Settings />);
    await screen.findByRole('button', { name: 'General' });
    expect(screen.queryByText('SettingsSystemHealth')).toBeNull();
  });

  it('does not regress General tab after switching to System Health and back', async () => {
    render(<Settings />);
    await screen.findByRole('button', { name: 'General' });

    const sysHealthTab = screen.getByRole('button', { name: 'System Health' });
    fireEvent.click(sysHealthTab);
    expect(screen.getByText('SettingsSystemHealth')).toBeDefined();

    const generalTab = screen.getByRole('button', { name: 'General' });
    fireEvent.click(generalTab);
    expect(screen.queryByText('SettingsSystemHealth')).toBeNull();
  });
});
