import { describe, it, expect } from 'vitest';
import { summarizeEvent } from '../eventParsing';

// Helper to make an event object
function ev(eventType: string, content: string) {
  return { eventType, content };
}

describe('summarizeEvent', () => {
  describe('text / assistant events', () => {
    it('extracts text from a structured assistant message, not raw JSON', () => {
      const payload = {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Here is my analysis of your code.' },
          ],
        },
      };
      const result = summarizeEvent(ev('text', JSON.stringify(payload)));
      expect(result).toBe('Here is my analysis of your code.');
      expect(result).not.toContain('{');
    });

    it('truncates extracted assistant text to 120 chars', () => {
      const longText = 'a'.repeat(200);
      const payload = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: longText }] },
      };
      const result = summarizeEvent(ev('text', JSON.stringify(payload)));
      expect(result.length).toBe(121); // 120 + ellipsis
      expect(result.endsWith('…')).toBe(true);
    });

    it('returns tool summary when assistant message has only tool_use blocks', () => {
      const payload = {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/foo.ts' } },
          ],
        },
      };
      const result = summarizeEvent(ev('text', JSON.stringify(payload)));
      expect(result).toBe('🔧 Read');
    });

    it('returns Bash tool summary with command for Bash tool_use in text event', () => {
      const payload = {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
          ],
        },
      };
      const result = summarizeEvent(ev('text', JSON.stringify(payload)));
      expect(result).toBe('🔧 Bash $ npm test');
    });

    it('falls back to raw content when payload is not parseable JSON', () => {
      const result = summarizeEvent(ev('text', 'plain text message'));
      expect(result).toBe('plain text message');
    });

    it('truncates plain text content at 120 chars', () => {
      const long = 'x'.repeat(130);
      const result = summarizeEvent(ev('text', long));
      expect(result.length).toBe(121);
      expect(result.endsWith('…')).toBe(true);
    });
  });

  describe('tool_use events', () => {
    it('renders 🔧 ToolName for a standard tool', () => {
      const payload = { type: 'tool_use', name: 'Glob', input: { pattern: '**/*.ts' } };
      const result = summarizeEvent(ev('tool_use', JSON.stringify(payload)));
      expect(result).toBe('🔧 Glob');
    });

    it('renders 🔧 Bash $ <command> for Bash tool', () => {
      const payload = { type: 'tool_use', name: 'Bash', input: { command: 'git status' } };
      const result = summarizeEvent(ev('tool_use', JSON.stringify(payload)));
      expect(result).toBe('🔧 Bash $ git status');
    });

    it('falls back to raw content when payload is not parseable JSON', () => {
      const result = summarizeEvent(ev('tool_use', 'not json at all'));
      expect(result).toBe('not json at all');
    });
  });

  describe('tool_result events', () => {
    it('extracts result text from structured payload', () => {
      const payload = { content: 'File read successfully.' };
      const result = summarizeEvent(ev('tool_result', JSON.stringify(payload)));
      expect(result).toBe('File read successfully.');
    });

    it('truncates result text to 120 chars', () => {
      const payload = { content: 'z'.repeat(200) };
      const result = summarizeEvent(ev('tool_result', JSON.stringify(payload)));
      expect(result.length).toBe(121);
      expect(result.endsWith('…')).toBe(true);
    });

    it('falls back to raw content when payload is not parseable JSON', () => {
      const result = summarizeEvent(ev('tool_result', 'raw result text'));
      expect(result).toBe('raw result text');
    });
  });

  describe('system events', () => {
    it('renders [init] for init subtype', () => {
      const payload = { type: 'system', subtype: 'init' };
      const result = summarizeEvent(ev('system', JSON.stringify(payload)));
      expect(result).toBe('[init]');
    });

    it('renders [rate limit] for rate_limit subtype', () => {
      const payload = { type: 'system', subtype: 'rate_limit' };
      const result = summarizeEvent(ev('system', JSON.stringify(payload)));
      expect(result).toBe('[rate limit]');
    });

    it('renders [done] for success subtype', () => {
      const payload = { type: 'system', subtype: 'success' };
      const result = summarizeEvent(ev('system', JSON.stringify(payload)));
      expect(result).toBe('[done]');
    });

    it('falls back to raw content when payload is not parseable JSON', () => {
      const result = summarizeEvent(ev('system', 'raw system text'));
      expect(result).toBe('raw system text');
    });
  });

  describe('fallback for unknown event types', () => {
    it('truncates raw content for unknown event type', () => {
      const result = summarizeEvent(ev('unknown_type', 'some content'));
      expect(result).toBe('some content');
    });
  });
});
