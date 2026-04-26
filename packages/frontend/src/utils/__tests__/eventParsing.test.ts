import { describe, it, expect } from 'vitest';
import { summarizeEvent, extractSystem, extractToolDetail } from '../eventParsing';

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

    it('returns tool summary with filename when assistant message has only tool_use blocks', () => {
      const payload = {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/foo.ts' } },
          ],
        },
      };
      const result = summarizeEvent(ev('text', JSON.stringify(payload)));
      expect(result).toBe('🔧 Read (foo.ts)');
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
    it('renders 🔧 ToolName (pattern) for Glob tool', () => {
      const payload = { type: 'tool_use', name: 'Glob', input: { pattern: '**/*.ts' } };
      const result = summarizeEvent(ev('tool_use', JSON.stringify(payload)));
      expect(result).toBe('🔧 Glob (**/*.ts)');
    });

    it('renders 🔧 Read (filename) for Read tool', () => {
      const payload = { type: 'tool_use', name: 'Read', input: { file_path: '/src/config.ts' } };
      const result = summarizeEvent(ev('tool_use', JSON.stringify(payload)));
      expect(result).toBe('🔧 Read (config.ts)');
    });

    it('renders 🔧 ToolName for a tool with no extractable detail', () => {
      const payload = { type: 'tool_use', name: 'WebFetch', input: {} };
      const result = summarizeEvent(ev('tool_use', JSON.stringify(payload)));
      expect(result).toBe('🔧 WebFetch');
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
    it('hides init subtype from card preview', () => {
      const payload = { type: 'system', subtype: 'init' };
      const result = summarizeEvent(ev('system', JSON.stringify(payload)));
      expect(result).toBe('');
    });

    it('hides rate_limit subtype from card preview', () => {
      const payload = { type: 'system', subtype: 'rate_limit' };
      const result = summarizeEvent(ev('system', JSON.stringify(payload)));
      expect(result).toBe('');
    });

    it('renders a friendly label for success subtype', () => {
      const payload = { type: 'system', subtype: 'success' };
      const result = summarizeEvent(ev('system', JSON.stringify(payload)));
      expect(result).toBe('Session complete');
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

describe('extractToolDetail', () => {
  it('returns basename for Read with file_path', () => {
    expect(extractToolDetail('Read', { file_path: '/src/config.ts' })).toBe('config.ts');
  });

  it('returns basename for Write with file_path', () => {
    expect(extractToolDetail('Write', { file_path: 'C:\\project\\foo.ts' })).toBe('foo.ts');
  });

  it('returns basename for Edit with file_path', () => {
    expect(extractToolDetail('Edit', { file_path: '/a/b/c.ts' })).toBe('c.ts');
  });

  it('returns pattern for Glob', () => {
    expect(extractToolDetail('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
  });

  it('returns pattern for Grep', () => {
    expect(extractToolDetail('Grep', { pattern: 'foo.*bar' })).toBe('foo.*bar');
  });

  it('returns description for Agent', () => {
    expect(extractToolDetail('Agent', { description: 'Explore codebase' })).toBe('Explore codebase');
  });

  it('returns null for unknown tool', () => {
    expect(extractToolDetail('WebFetch', { url: 'https://example.com' })).toBeNull();
  });

  it('returns null when input is null', () => {
    expect(extractToolDetail('Read', null)).toBeNull();
  });

  it('returns null when relevant field is missing', () => {
    expect(extractToolDetail('Read', {})).toBeNull();
  });
});

describe('extractSystem — user events with array content', () => {
  it('returns readable text from user event with array content', () => {
    const payload = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Please fix the bug in foo.ts' }],
      },
    };
    const { rawType, display } = extractSystem(payload, '');
    expect(rawType).toBe('user');
    expect(display).toBe('Please fix the bug in foo.ts');
  });

  it('returns empty string for user event with array content that is entirely a system-reminder block', () => {
    // Entire text is wrapped in a system tag — strip tag+content → nothing remains
    const payload = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>Do not do X</system-reminder>' },
        ],
      },
    };
    const { rawType, display } = extractSystem(payload, '');
    expect(rawType).toBe('user');
    expect(display).toBe('');
  });

  it('strips tag+content blocks but retains bare text in array content', () => {
    const payload = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello<local-command-caveat>some caveat</local-command-caveat>' },
        ],
      },
    };
    const { display } = extractSystem(payload, '');
    expect(display).toBe('Hello');
  });

  it('returns empty string for user event with unknown content shape', () => {
    const payload = { type: 'user', message: { role: 'user', content: 42 } };
    const { display } = extractSystem(payload, '');
    expect(display).toBe('');
  });
});
