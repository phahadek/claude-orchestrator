import {
  render,
  screen,
  waitFor,
  act,
  fireEvent,
} from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EnrollmentFlow } from '../EnrollmentFlow';

function mockFetch(responses: Array<{ status: number; body: unknown }>): void {
  let call = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => {
      const r = responses[call] ?? responses[responses.length - 1];
      call++;
      return Promise.resolve({
        status: r.status,
        ok: r.status >= 200 && r.status < 300,
        json: () => Promise.resolve(r.body),
      });
    }),
  );
}

describe('EnrollmentFlow', () => {
  let storageMock: Map<string, string>;

  beforeEach(() => {
    storageMock = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storageMock.get(k) ?? null,
      setItem: (k: string, v: string) => storageMock.set(k, v),
      removeItem: (k: string) => storageMock.delete(k),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('bootstraps on loopback+deviceCount=0: calls setDeviceToken and onEnrolled', async () => {
    mockFetch([{ status: 200, body: { token: 'abc123' } }]);
    const onEnrolled = vi.fn();

    render(<EnrollmentFlow onEnrolled={onEnrolled} />);

    await waitFor(() => expect(onEnrolled).toHaveBeenCalledTimes(1));
    expect(storageMock.get('device_token')).toBe('abc123');
  });

  it('transitions to requesting step when bootstrap returns no token (devices already enrolled)', async () => {
    mockFetch([{ status: 200, body: {} }]);
    const onEnrolled = vi.fn();

    render(<EnrollmentFlow onEnrolled={onEnrolled} />);

    await waitFor(() => screen.getByText(/request pairing code/i));
    expect(onEnrolled).not.toHaveBeenCalled();
  });

  it('shows pairing code after requesting enrollment code', async () => {
    mockFetch([
      { status: 200, body: {} },
      { status: 200, body: { code: '123456' } },
    ]);
    const onEnrolled = vi.fn();

    render(<EnrollmentFlow onEnrolled={onEnrolled} />);

    await waitFor(() => screen.getByText(/request pairing code/i));

    fireEvent.click(
      screen.getByRole('button', { name: /request pairing code/i }),
    );

    await waitFor(() => screen.getByText('123456'));
    expect(onEnrolled).not.toHaveBeenCalled();
  });

  it('calls onEnrolled and setDeviceToken when polling returns approved', async () => {
    mockFetch([
      { status: 200, body: {} },
      { status: 200, body: { code: '654321' } },
      { status: 200, body: { status: 'approved', token: 'tok-xyz' } },
    ]);
    const onEnrolled = vi.fn();

    vi.useFakeTimers();

    render(<EnrollmentFlow onEnrolled={onEnrolled} />);

    await waitFor(() => screen.getByText(/request pairing code/i));

    fireEvent.click(
      screen.getByRole('button', { name: /request pairing code/i }),
    );

    await waitFor(() => screen.getByText('654321'));

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    await waitFor(() => expect(onEnrolled).toHaveBeenCalledTimes(1));
    expect(storageMock.get('device_token')).toBe('tok-xyz');

    vi.useRealTimers();
  });

  it('shows error state when bootstrap fetch fails (network error)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network error')),
    );
    const onEnrolled = vi.fn();

    render(<EnrollmentFlow onEnrolled={onEnrolled} />);

    await waitFor(() => screen.getByText(/failed to connect/i));
    expect(onEnrolled).not.toHaveBeenCalled();
  });

  it('does not treat a non-ok response body as valid data (no crash on 500)', async () => {
    mockFetch([{ status: 500, body: { error: 'internal', code: 'boom' } }]);
    const onEnrolled = vi.fn();

    render(<EnrollmentFlow onEnrolled={onEnrolled} />);

    await waitFor(() => screen.getByText(/failed to connect/i));
    expect(onEnrolled).not.toHaveBeenCalled();
  });
});
