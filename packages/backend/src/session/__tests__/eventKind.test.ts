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

describe('eventKind — tool_use/tool_result contract', () => {
  // event_type='text' rows (raw CLI 'assistant'/'text'/'message') always
  // classify as 'text', even when the message's only content block is a
  // tool_use — a caller that needs to find an embedded tool_use inspects the
  // content array itself (see SessionAuditor.extractToolUseBlocks) rather
  // than depend on eventKind reclassifying the row.
  it('classifies a "text" row whose content is entirely tool_use blocks as text, not tool_use', () => {
    const row = {
      event_type: 'text' as const,
      payload: JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Write',
              input: { content: 'https://github.com/owner/repo/pull/42' },
            },
          ],
        },
      }),
    };
    expect(eventKind(row)).toBe('text');
  });

  // A standalone (flat) CLI tool_use/tool_result event maps to
  // event_type='system' via toEventType's default branch — this is the one
  // storage shape eventKind CAN and does discriminate through payload.type.
  it('classifies a "system" row with payload.type "tool_use" as tool_use', () => {
    const row = {
      event_type: 'system' as const,
      payload: JSON.stringify({ type: 'tool_use', name: 'Write', input: {} }),
    };
    expect(eventKind(row)).toBe('tool_use');
  });

  it('classifies a "system" row with payload.type "tool_result" as tool_result', () => {
    const row = {
      event_type: 'system' as const,
      payload: JSON.stringify({ type: 'tool_result', content: 'ok' }),
    };
    expect(eventKind(row)).toBe('tool_result');
  });

  // The CLI also reports some tool results nested inside a raw 'user'-role
  // message rather than a flat 'tool_result' event — this is the shape a
  // phantom-PR fixture URL slipped through in (payload.type='user' carrying
  // a tool_result content block), so it must classify as tool_result too.
  it('classifies a "system" row with payload.type "user" carrying a tool_result content block as tool_result', () => {
    const row = {
      event_type: 'system' as const,
      payload: JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              content: 'pr_url: https://github.com/owner/repo/pull/42',
            },
          ],
        },
      }),
    };
    expect(eventKind(row)).toBe('tool_result');
  });

  it('classifies a "system" row with payload.type "user" but no tool_result content block as other', () => {
    const row = {
      event_type: 'system' as const,
      payload: JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: 'hi' }] },
      }),
    };
    expect(eventKind(row)).toBe('other');
  });
});
