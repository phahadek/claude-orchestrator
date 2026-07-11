import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockReadFileSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn<[string, string], string>(),
}));
vi.mock('fs', () => ({
  default: { readFileSync: mockReadFileSync },
  readFileSync: mockReadFileSync,
}));

import { PlanUsagePoller } from '../PlanUsagePoller.js';

const VALID_CREDS = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'test-access-token',
    expiresAt: Date.now() + 60_000,
  },
});

const SAMPLE_PAYLOAD = {
  five_hour: { utilization: 43, resets_at: '2026-07-10T01:49:59Z' },
  seven_day: { utilization: 7, resets_at: '2026-07-09T22:59:59Z' },
  limits: [
    {
      kind: 'session',
      percent: 43,
      severity: 'normal',
      resets_at: '2026-07-10T01:49:59Z',
      is_active: true,
    },
    {
      kind: 'weekly_all',
      percent: 7,
      severity: 'normal',
      resets_at: '2026-07-09T22:59:59Z',
    },
  ],
};

function mockFetch(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-09T12:00:00Z'));
  mockReadFileSync.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('PlanUsagePoller', () => {
  it('maps a sample 200 limits[] payload to available fiveHour/weekly windows', async () => {
    mockReadFileSync.mockReturnValue(VALID_CREDS);
    mockFetch(SAMPLE_PAYLOAD);

    const broadcast = vi.fn();
    const poller = new PlanUsagePoller(broadcast);
    await poller.poll();

    expect(poller.getCache()).toEqual({
      available: true,
      fiveHour: {
        percent: 43,
        resetsAt: '2026-07-10T01:49:59Z',
        severity: 'normal',
      },
      weekly: {
        percent: 7,
        resetsAt: '2026-07-09T22:59:59Z',
        severity: 'normal',
      },
    });
    expect(broadcast).toHaveBeenCalledWith({
      type: 'plan_usage',
      usage: poller.getCache(),
    });
  });

  it('maps a non-200 response to unavailable without throwing', async () => {
    mockReadFileSync.mockReturnValue(VALID_CREDS);
    mockFetch({}, 500);

    const broadcast = vi.fn();
    const poller = new PlanUsagePoller(broadcast);
    await expect(poller.poll()).resolves.not.toThrow();

    expect(poller.getCache()).toEqual({ available: false });
  });

  it('maps a missing claudeAiOauth credentials file to unavailable without throwing', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({}));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const broadcast = vi.fn();
    const poller = new PlanUsagePoller(broadcast);
    await expect(poller.poll()).resolves.not.toThrow();

    expect(poller.getCache()).toEqual({ available: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips the tick and does not attempt a token refresh when expiresAt is in the past', async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'stale-token',
          expiresAt: Date.now() - 1000,
        },
      }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const broadcast = vi.fn();
    const poller = new PlanUsagePoller(broadcast);
    await poller.poll();

    expect(poller.getCache()).toEqual({ available: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
