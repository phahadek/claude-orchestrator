import { describe, it, expect } from 'vitest';
import { eventKind } from '../session/eventKind';
import type { EventKind } from '../session/eventKind';
import { makeEventRow } from '../../test/helpers/eventFixtures';

// ── EventKind derivation — both writer shapes ─────────────────────────────────

describe('eventKind — live full-event payload shape', () => {
  it('text → text', () => {
    expect(eventKind(makeEventRow('text').live)).toBe<EventKind>('text');
  });

  it('tool_use → tool_use', () => {
    expect(eventKind(makeEventRow('tool_use').live)).toBe<EventKind>(
      'tool_use',
    );
  });

  it('tool_result → tool_result', () => {
    expect(eventKind(makeEventRow('tool_result').live)).toBe<EventKind>(
      'tool_result',
    );
  });

  it('error → error', () => {
    expect(eventKind(makeEventRow('error').live)).toBe<EventKind>('error');
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

  it('tool_use → tool_use (no type field in payload)', () => {
    expect(eventKind(makeEventRow('tool_use').jsonl)).toBe<EventKind>(
      'tool_use',
    );
  });

  it('tool_result → tool_result (no type field in payload)', () => {
    expect(eventKind(makeEventRow('tool_result').jsonl)).toBe<EventKind>(
      'tool_result',
    );
  });

  it('error → error (no type field in payload)', () => {
    expect(eventKind(makeEventRow('error').jsonl)).toBe<EventKind>('error');
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
  it('eventKind=error for overloaded_error (529 retry) — live shape', () => {
    expect(eventKind(makeEventRow('error').live)).toBe<EventKind>('error');
  });

  it('eventKind=error for overloaded_error (529 retry) — JSONL shape', () => {
    expect(eventKind(makeEventRow('error').jsonl)).toBe<EventKind>('error');
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
  it('eventKind=tool_result — live shape', () => {
    expect(eventKind(makeEventRow('tool_result').live)).toBe<EventKind>(
      'tool_result',
    );
  });

  it('eventKind=tool_result — JSONL shape', () => {
    expect(eventKind(makeEventRow('tool_result').jsonl)).toBe<EventKind>(
      'tool_result',
    );
  });

  it('eventKind=tool_use — live shape', () => {
    expect(eventKind(makeEventRow('tool_use').live)).toBe<EventKind>(
      'tool_use',
    );
  });

  it('eventKind=tool_use — JSONL shape', () => {
    expect(eventKind(makeEventRow('tool_use').jsonl)).toBe<EventKind>(
      'tool_use',
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
