import { describe, it, expect } from 'vitest';
import { eventKind } from '../session/eventKind';
import type { EventKind } from '../session/eventKind';

function row(
  event_type: string,
  payload: unknown,
): { event_type: string; payload: string } {
  return { event_type, payload: JSON.stringify(payload) };
}

// ── EventType column → EventKind (no payload parse needed) ───────────────────

describe('eventKind — direct column mapping', () => {
  it('text → text', () => {
    expect(eventKind(row('text', { message: {} }))).toBe<EventKind>('text');
  });

  it('tool_use → tool_use (live shape)', () => {
    expect(
      eventKind(
        row('tool_use', { type: 'tool_use', name: 'Write', input: {} }),
      ),
    ).toBe<EventKind>('tool_use');
  });

  it('tool_use → tool_use (JSONL ev.content shape — no type field)', () => {
    expect(
      eventKind(row('tool_use', { name: 'Write', input: {} })),
    ).toBe<EventKind>('tool_use');
  });

  it('tool_result → tool_result (live shape)', () => {
    expect(
      eventKind(
        row('tool_result', { type: 'tool_result', tool_use_id: 'id1' }),
      ),
    ).toBe<EventKind>('tool_result');
  });

  it('tool_result → tool_result (JSONL ev.content shape)', () => {
    expect(
      eventKind(row('tool_result', { tool_use_id: 'id1', content: 'ok' })),
    ).toBe<EventKind>('tool_result');
  });

  it('error → error (live full-event shape)', () => {
    expect(
      eventKind(
        row('error', {
          type: 'error',
          error: { type: 'overloaded_error', message: 'Overloaded' },
        }),
      ),
    ).toBe<EventKind>('error');
  });

  it('error → error (JSONL ev.content shape — no type field)', () => {
    expect(
      eventKind(
        row('error', {
          error_type: 'api_error',
          message: 'Internal server error',
        }),
      ),
    ).toBe<EventKind>('error');
  });

  it('user_message → user_message', () => {
    expect(eventKind(row('user_message', { content: 'hi' }))).toBe<EventKind>(
      'user_message',
    );
  });

  it('rate_limit → other', () => {
    expect(eventKind(row('rate_limit', {}))).toBe<EventKind>('other');
  });
});

// ── system events — payload.type discriminates the logical kind ───────────────

describe('eventKind — system event payload discrimination', () => {
  it('system + payload.type=result → result (production reaper shape)', () => {
    expect(
      eventKind(
        row('system', {
          type: 'result',
          subtype: 'success',
          duration_ms: 1000,
        }),
      ),
    ).toBe<EventKind>('result');
  });

  it('system + payload.type=result (error_max_turns subtype) → result', () => {
    expect(
      eventKind(row('system', { type: 'result', subtype: 'error_max_turns' })),
    ).toBe<EventKind>('result');
  });

  it('system + payload.type=error → error (SDK error stored via system event)', () => {
    expect(
      eventKind(row('system', { type: 'error', error: { type: 'api_error' } })),
    ).toBe<EventKind>('error');
  });

  it('system + payload.type=user → other', () => {
    expect(
      eventKind(row('system', { type: 'user', message: { role: 'user' } })),
    ).toBe<EventKind>('other');
  });

  it('system + no type field → other', () => {
    expect(eventKind(row('system', { subtype: 'init' }))).toBe<EventKind>(
      'other',
    );
  });

  it('system + malformed payload → other', () => {
    expect(
      eventKind({ event_type: 'system', payload: 'not-json' }),
    ).toBe<EventKind>('other');
  });
});

// ── Regression: isTransientApiError uses eventKind ───────────────────────────

describe('regression — transient API error detection', () => {
  it('eventKind=error for overloaded_error event (500/529 retry path)', () => {
    const lastEvent = row('error', {
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded' },
    });
    expect(eventKind(lastEvent)).toBe<EventKind>('error');
  });

  it('eventKind=error for api_error event (500 path)', () => {
    const lastEvent = row('error', {
      type: 'error',
      error: { type: 'api_error', message: 'Internal server error' },
    });
    expect(eventKind(lastEvent)).toBe<EventKind>('error');
  });

  it('eventKind≠error for system result event (no retry)', () => {
    const lastEvent = row('system', {
      type: 'result',
      subtype: 'success',
    });
    expect(eventKind(lastEvent)).not.toBe<EventKind>('error');
  });
});

// ── Regression: mid-turn detection ───────────────────────────────────────────

describe('regression — mid-turn detection', () => {
  it('eventKind=tool_result for a stored tool_result event', () => {
    expect(
      eventKind(row('tool_result', { tool_use_id: 'tid' })),
    ).toBe<EventKind>('tool_result');
  });

  it('eventKind=tool_use for a stored tool_use event', () => {
    expect(
      eventKind(row('tool_use', { name: 'Bash', input: {} })),
    ).toBe<EventKind>('tool_use');
  });

  it('eventKind≠tool_result for a text event (no false positive)', () => {
    expect(
      eventKind(row('text', { message: { content: [] } })),
    ).not.toBe<EventKind>('tool_result');
  });
});

// ── Regression: reaper terminal-result detection ─────────────────────────────

describe('regression — reaper result detection', () => {
  it('eventKind=result for production-shaped system+result event', () => {
    const resultEvent = row('system', {
      type: 'result',
      subtype: 'success',
      duration_ms: 5000,
      session_id: 'abc',
    });
    expect(eventKind(resultEvent)).toBe<EventKind>('result');
  });

  it('eventKind≠result for system event without result payload', () => {
    const nonResultEvent = row('system', {
      type: 'user',
      message: { role: 'user', content: 'hello' },
    });
    expect(eventKind(nonResultEvent)).not.toBe<EventKind>('result');
  });
});
