import { describe, it, expect } from 'vitest';
import { eventKind, isUsageLimitResult } from '../eventKind';

describe('isUsageLimitResult', () => {
  it('recognises a terminating result event carrying api_error_status: 429', () => {
    const row = {
      event_type: 'system' as const,
      payload: JSON.stringify({
        type: 'result',
        is_error: true,
        api_error_status: 429,
        terminal_reason: 'api_error',
        result: "You've hit your session limit · resets 6:10pm (UTC)",
      }),
    };
    // eventKind classifies this as 'result', not 'error' — the masking this
    // helper exists to see past.
    expect(eventKind(row)).toBe('result');
    expect(isUsageLimitResult(row)).toBe(true);
  });

  it('returns false for a normal successful result event', () => {
    const row = {
      event_type: 'system' as const,
      payload: JSON.stringify({ type: 'result', is_error: false }),
    };
    expect(isUsageLimitResult(row)).toBe(false);
  });

  it('returns false for a genuine error event, even with a 429-looking message', () => {
    const row = {
      event_type: 'system' as const,
      payload: JSON.stringify({
        type: 'error',
        api_error_status: 429,
      }),
    };
    expect(isUsageLimitResult(row)).toBe(false);
  });

  it('returns false for unparseable payloads', () => {
    const row = { event_type: 'system' as const, payload: 'not json' };
    expect(isUsageLimitResult(row)).toBe(false);
  });
});
