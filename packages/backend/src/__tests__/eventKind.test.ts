import { describe, it, expect } from 'vitest';
import { eventKind } from '../session/eventKind';
import type { EventKind } from '../session/eventKind';
import { makeEventRow } from '../../test/helpers/eventFixtures';

// ── EventKind derivation — both writer shapes ─────────────────────────────────

describe('eventKind — live full-event payload shape', () => {
  it('text → text', () => {
    expect(eventKind(makeEventRow('text').live)).toBe<EventKind>('text');
  });

  // db/types.ts's EventType was narrowed to the values the event_type column
  // actually holds ('text' | 'system' | 'user_message' | 'rate_limit' — see
  // "narrow EventType to stored values, remove dead kind comparisons").
  // event_type is never literally 'tool_use' or 'tool_result' in storage —
  // tool_use blocks arrive folded into an assistant 'text' event's merged
  // content array instead — so eventKind() has no case for them and falls
  // through to the default 'other', which is the correct, safe behavior for
  // a row shape that shouldn't occur in practice.
  it('tool_use (impossible event_type) → other', () => {
    expect(eventKind(makeEventRow('tool_use').live)).toBe<EventKind>('other');
  });

  it('tool_result (impossible event_type) → other', () => {
    expect(eventKind(makeEventRow('tool_result').live)).toBe<EventKind>(
      'other',
    );
  });

  // Likewise, event_type is never literally 'error' in storage — error
  // events are stored as event_type='system' with payload.type='error' (see
  // 'eventKind — system event payload discrimination' below) — so this
  // shape also falls through to the default 'other'.
  it('error (impossible event_type) → other', () => {
    expect(eventKind(makeEventRow('error').live)).toBe<EventKind>('other');
  });

  it('result → result (system event, payload.type=result)', () => {
    expect(eventKind(makeEventRow('result').live)).toBe<EventKind>('result');
  });

  it('user_message → user_message', () => {
    expect(eventKind(makeEventRow('user_message').live)).toBe<EventKind>(
      'user_message',
    );
  });

  it('other → other', () => {
    expect(eventKind(makeEventRow('other').live)).toBe<EventKind>('other');
  });
});

describe('eventKind — JSONL ev.content shape', () => {
  it('text → text', () => {
    expect(eventKind(makeEventRow('text').jsonl)).toBe<EventKind>('text');
  });

  // Same "impossible event_type" reasoning as the live-shape block above —
  // event_type is never 'tool_use'/'tool_result'/'error' in storage, so
  // these fall through to the default 'other'.
  it('tool_use (impossible event_type) → other (no type field in payload)', () => {
    expect(eventKind(makeEventRow('tool_use').jsonl)).toBe<EventKind>(
      'other',
    );
  });

  it('tool_result (impossible event_type) → other (no type field in payload)', () => {
    expect(eventKind(makeEventRow('tool_result').jsonl)).toBe<EventKind>(
      'other',
    );
  });

  it('error (impossible event_type) → other (no type field in payload)', () => {
    expect(eventKind(makeEventRow('error').jsonl)).toBe<EventKind>('other');
  });

  it('result → result (system event, payload.type=result — same as live)', () => {
    expect(eventKind(makeEventRow('result').jsonl)).toBe<EventKind>('result');
  });

  it('user_message → user_message', () => {
    expect(eventKind(makeEventRow('user_message').jsonl)).toBe<EventKind>(
      'user_message',
    );
  });
});

// ── system event payload discrimination ──────────────────────────────────────

describe('eventKind — system event payload discrimination', () => {
  it('system + payload.type=error → error (SDK error stored via system event)', () => {
    const row = {
      event_type: 'system',
      payload: JSON.stringify({ type: 'error', error: { type: 'api_error' } }),
    };
    expect(eventKind(row)).toBe<EventKind>('error');
  });

  it('system + payload.type=user → other', () => {
    const row = {
      event_type: 'system',
      payload: JSON.stringify({ type: 'user', message: { role: 'user' } }),
    };
    expect(eventKind(row)).toBe<EventKind>('other');
  });

  it('system + no type field → other', () => {
    expect(
      eventKind({
        event_type: 'system',
        payload: JSON.stringify({ subtype: 'init' }),
      }),
    ).toBe<EventKind>('other');
  });

  it('system + malformed payload → other', () => {
    expect(
      eventKind({ event_type: 'system', payload: 'not-json' }),
    ).toBe<EventKind>('other');
  });

  it('rate_limit → other', () => {
    expect(
      eventKind({ event_type: 'rate_limit', payload: '{}' }),
    ).toBe<EventKind>('other');
  });
});

// ── Regression: isTransientApiError (AgentSession:415) ───────────────────────

describe('regression — transient API error detection (isTransientApiError path)', () => {
  it('eventKind=error for overloaded_error (529 retry) — stored as a system event', () => {
    // overloaded_error (like all error events) is stored as event_type='system'
    // with payload.type='error' — see eventFixtures.ts's 'error' shape and
    // the "system event payload discrimination" block above for the
    // event_type='error' (impossible-shape) case, which now yields 'other'.
    const overloadedErrorRow = {
      event_type: 'system',
      payload: JSON.stringify({
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' },
      }),
    };
    expect(eventKind(overloadedErrorRow)).toBe<EventKind>('error');
  });

  it('eventKind=error for SDK error stored as system event', () => {
    const sdkErrorRow = {
      event_type: 'system',
      payload: JSON.stringify({ type: 'error', error: { type: 'api_error' } }),
    };
    expect(eventKind(sdkErrorRow)).toBe<EventKind>('error');
  });

  it('eventKind≠error for system result event (no false retry)', () => {
    expect(eventKind(makeEventRow('result').live)).not.toBe<EventKind>('error');
  });
});

// ── Regression: mid-turn detection (SessionManager:1089) ─────────────────────

describe('regression — mid-turn detection', () => {
  // SessionManager's mid-turn check (`eventKind(lastEvent) === 'tool_result'
  // || eventKind(lastEvent) === 'tool_use'`) is now unreachable dead code —
  // event_type is never 'tool_result'/'tool_use' in storage (see the "narrow
  // EventType to stored values, remove dead kind comparisons" PR), so these
  // shapes always resolve to 'other'. Documented here rather than deleted so
  // a future EventType widening that resurrects these values is caught.
  it('eventKind≠tool_result — live shape (impossible event_type, dead comparison)', () => {
    expect(eventKind(makeEventRow('tool_result').live)).toBe<EventKind>(
      'other',
    );
  });

  it('eventKind≠tool_result — JSONL shape (impossible event_type, dead comparison)', () => {
    expect(eventKind(makeEventRow('tool_result').jsonl)).toBe<EventKind>(
      'other',
    );
  });

  it('eventKind≠tool_use — live shape (impossible event_type, dead comparison)', () => {
    expect(eventKind(makeEventRow('tool_use').live)).toBe<EventKind>('other');
  });

  it('eventKind≠tool_use — JSONL shape (impossible event_type, dead comparison)', () => {
    expect(eventKind(makeEventRow('tool_use').jsonl)).toBe<EventKind>(
      'other',
    );
  });

  it('eventKind≠tool_result for a text event (no false positive)', () => {
    expect(eventKind(makeEventRow('text').live)).not.toBe<EventKind>(
      'tool_result',
    );
  });
});

// ── Regression: reaper result detection (queries.ts SQL equivalent) ──────────

describe('regression — reaper result detection', () => {
  it('eventKind=result for production-shaped system+result event — live shape', () => {
    expect(eventKind(makeEventRow('result').live)).toBe<EventKind>('result');
  });

  it('eventKind=result for production-shaped system+result event — JSONL shape', () => {
    expect(eventKind(makeEventRow('result').jsonl)).toBe<EventKind>('result');
  });

  it('eventKind≠result for a non-result system event', () => {
    expect(eventKind(makeEventRow('other').live)).not.toBe<EventKind>('result');
  });
});
