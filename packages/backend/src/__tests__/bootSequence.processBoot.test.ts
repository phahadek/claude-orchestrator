/**
 * Tests for recordBootEvent()'s self-identifying process_boot payload:
 * pid, version and a per-process bootId, so a real backend boot is
 * distinguishable from an unrelated writer and rows from the same process
 * can be correlated after the fact.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../audit/AuditLog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../audit/AuditLog')>();
  return {
    ...actual,
    recordEvent: vi.fn(actual.recordEvent),
  };
});

import { recordEvent, getLatestEventByType } from '../audit/AuditLog';
import { recordBootEvent } from '../bootSequence';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('recordBootEvent', () => {
  beforeEach(() => {
    vi.mocked(recordEvent).mockClear();
  });

  it('records a payload with pid, version and a valid bootId', () => {
    recordBootEvent();

    const latest = getLatestEventByType('process_boot');
    expect(latest).toBeDefined();
    expect(latest!.event_type).toBe('process_boot');
    expect(latest!.actor_type).toBe('system');

    const payload = JSON.parse(latest!.payload) as {
      pid?: number;
      version?: string;
      bootId?: string;
    };
    expect(payload.pid).toBe(process.pid);
    expect(typeof payload.version).toBe('string');
    expect(payload.version).toBeTruthy();
    expect(payload.bootId).toMatch(UUID_RE);
  });

  it('reuses the same bootId across multiple calls within one process', () => {
    recordBootEvent();
    recordBootEvent();

    const calls = vi.mocked(recordEvent).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const bootIds = calls.map(
      ([event]) => (event.payload as { bootId: string }).bootId,
    );
    const last = bootIds[bootIds.length - 1];
    const secondLast = bootIds[bootIds.length - 2];
    expect(last).toBe(secondLast);
  });

  it('does not throw when the underlying recordEvent throws', () => {
    vi.mocked(recordEvent).mockImplementationOnce(() => {
      throw new Error('boom');
    });

    expect(() => recordBootEvent()).not.toThrow();
  });
});
