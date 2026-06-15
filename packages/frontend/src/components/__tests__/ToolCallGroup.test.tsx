import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ToolCallGroup } from '../ToolCallGroup';
import { groupSessionEvents } from '../EventTranscript.helpers';

// ── Test helpers ──────────────────────────────────────────────────

function makeEvent(eventType: string, content: string, timestamp = 1000) {
  return { eventType, content, timestamp };
}

/** Create a text event wrapping an assistant message with a single tool_use block. */
function makeToolUseTextEvent(
  toolName: string,
  input: Record<string, unknown>,
  timestamp = 1000,
) {
  return makeEvent(
    'text',
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_01', name: toolName, input }],
      },
    }),
    timestamp,
  );
}

function makeToolResultEvent(content: string, timestamp = 1001) {
  return makeEvent(
    'tool_result',
    JSON.stringify({ type: 'tool_result', content }),
    timestamp,
  );
}

function makeCallPair(
  toolName: string,
  input: Record<string, unknown>,
  result: string,
) {
  return {
    textEvent: makeToolUseTextEvent(toolName, input),
    resultEvent: makeToolResultEvent(result),
  };
}

// ── MultiCallGroup tests (calls.length >= 2) ──────────────────────

describe('ToolCallGroup (multi-call)', () => {
  it('renders collapsed header with tool name, detail, and count', () => {
    const calls = [
      makeCallPair('Read', { file_path: '/a.ts' }, 'content a'),
      makeCallPair('Read', { file_path: '/b.ts' }, 'content b'),
      makeCallPair('Read', { file_path: '/c.ts' }, 'content c'),
    ];
    render(<ToolCallGroup toolName="Read" calls={calls} />);
    expect(screen.getByText(/🔧 Read \(a\.ts\) ×3/)).toBeTruthy();
  });

  it('collapsed header shows description for Bash groups', () => {
    const calls = [
      makeCallPair(
        'Bash',
        { command: 'npx tsc --noEmit', description: 'Run tsc' },
        'output',
      ),
      makeCallPair(
        'Bash',
        { command: 'npx tsc --noEmit', description: 'Run tsc' },
        'output',
      ),
    ];
    render(<ToolCallGroup toolName="Bash" calls={calls} />);
    expect(screen.getByText(/🔧 Bash \(Run tsc\) ×2/)).toBeTruthy();
  });

  it('collapsed header shows detail for Read groups', () => {
    const calls = [
      makeCallPair('Read', { file_path: '/src/file.ts' }, 'content a'),
      makeCallPair('Read', { file_path: '/src/other.ts' }, 'content b'),
      makeCallPair('Read', { file_path: '/src/third.ts' }, 'content c'),
    ];
    render(<ToolCallGroup toolName="Read" calls={calls} />);
    expect(screen.getByText(/🔧 Read \(file\.ts\) ×3/)).toBeTruthy();
  });

  it('collapsed header falls back to command for Bash with no description', () => {
    const calls = [
      makeCallPair('Bash', { command: 'ls' }, 'output1'),
      makeCallPair('Bash', { command: 'pwd' }, 'output2'),
    ];
    render(<ToolCallGroup toolName="Bash" calls={calls} />);
    expect(screen.getByText(/🔧 Bash \(ls\) ×2/)).toBeTruthy();
  });

  it('collapsed header shows only bare tool name for unknown tool with no extractable detail', () => {
    const calls = [
      makeCallPair('TodoWrite', { todos: [] }, 'ok'),
      makeCallPair('TodoWrite', { todos: [] }, 'ok'),
    ];
    render(<ToolCallGroup toolName="TodoWrite" calls={calls} />);
    expect(screen.getByText(/🔧 TodoWrite ×2/)).toBeTruthy();
  });

  it('does not render call details when collapsed', () => {
    const calls = [
      makeCallPair('Read', { file_path: '/a.ts' }, 'file content here'),
      makeCallPair('Read', { file_path: '/b.ts' }, 'other content'),
    ];
    render(<ToolCallGroup toolName="Read" calls={calls} />);
    expect(screen.queryByText('file content here')).toBeNull();
    expect(screen.queryByText('other content')).toBeNull();
  });

  it('expands to show individual call items on click', () => {
    const calls = [
      makeCallPair('Read', { file_path: '/a.ts' }, 'result a'),
      makeCallPair('Read', { file_path: '/b.ts' }, 'result b'),
    ];
    render(<ToolCallGroup toolName="Read" calls={calls} />);
    const header = screen.getByRole('button', { name: /🔧 Read.*×2/ });
    fireEvent.click(header);
    expect(screen.getByText(/\/a\.ts/)).toBeTruthy();
    expect(screen.getByText(/\/b\.ts/)).toBeTruthy();
  });

  it('shows call result when individual call item is expanded', () => {
    const calls = [
      makeCallPair('Read', { file_path: '/a.ts' }, 'result content here'),
      makeCallPair('Read', { file_path: '/b.ts' }, 'other result'),
    ];
    render(<ToolCallGroup toolName="Read" calls={calls} />);
    fireEvent.click(screen.getByRole('button', { name: /🔧 Read.*×2/ }));
    const callButtons = screen.getAllByRole('button');
    const callBtn = callButtons.find((b) => b.textContent?.includes('/a.ts'));
    expect(callBtn).toBeTruthy();
    fireEvent.click(callBtn!);
    expect(screen.getByText(/result content here/)).toBeTruthy();
  });

  it('collapses again when header is clicked a second time', () => {
    const calls = [
      makeCallPair('Read', { file_path: '/x.ts' }, 'some result'),
      makeCallPair('Read', { file_path: '/y.ts' }, 'other result'),
    ];
    render(<ToolCallGroup toolName="Read" calls={calls} />);
    const header = screen.getByRole('button', { name: /🔧 Read.*×2/ });
    fireEvent.click(header);
    expect(screen.getByText(/\/x\.ts/)).toBeTruthy();
    fireEvent.click(header);
    expect(screen.queryByText('/x.ts')).toBeNull();
  });

  it('renders Bash command inline in call item label', () => {
    const calls = [
      makeCallPair('Bash', { command: 'npm test' }, 'test output'),
      makeCallPair('Bash', { command: 'npm build' }, 'build output'),
    ];
    render(<ToolCallGroup toolName="Bash" calls={calls} />);
    fireEvent.click(screen.getByRole('button', { name: /🔧 Bash.*×2/ }));
    expect(screen.getByText(/\$ npm test/)).toBeTruthy();
    expect(screen.getByText(/\$ npm build/)).toBeTruthy();
  });

  it('aria-expanded reflects open/closed state', () => {
    const calls = [
      makeCallPair('Read', { file_path: '/a.ts' }, 'r'),
      makeCallPair('Read', { file_path: '/b.ts' }, 'r'),
    ];
    render(<ToolCallGroup toolName="Read" calls={calls} />);
    const header = screen.getByRole('button', { name: /🔧 Read.*×2/ });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
  });
});

// ── SingleCallEntry tests (calls.length === 1) ─────────────────────

describe('ToolCallGroup (single call — SingleCallEntry)', () => {
  it('renders collapsed header with tool name and detail for Bash', () => {
    const calls = [
      makeCallPair(
        'Bash',
        { command: 'npx tsc --noEmit', description: 'Run tsc' },
        'output',
      ),
    ];
    render(<ToolCallGroup toolName="Bash" calls={calls} />);
    expect(screen.getByText(/🔧 Bash \(Run tsc\)/)).toBeTruthy();
    // No ×1 count suffix
    expect(screen.queryByText(/×1/)).toBeNull();
  });

  it('body is hidden when collapsed', () => {
    const calls = [makeCallPair('Bash', { command: 'ls -la' }, 'total 42')];
    render(<ToolCallGroup toolName="Bash" calls={calls} />);
    expect(screen.queryByText(/\$ ls -la/)).toBeNull();
    expect(screen.queryByText('total 42')).toBeNull();
  });

  it('expands Bash entry to show command and stdout', () => {
    const calls = [
      makeCallPair('Bash', { command: 'npm test' }, 'Tests passed'),
    ];
    render(<ToolCallGroup toolName="Bash" calls={calls} />);
    fireEvent.click(screen.getByRole('button', { name: /🔧 Bash/ }));
    expect(screen.getByText(/\$ npm test/)).toBeTruthy();
    expect(screen.getByText(/Tests passed/)).toBeTruthy();
  });

  it('expands Read entry to show file path and content', () => {
    const calls = [
      makeCallPair('Read', { file_path: '/src/index.ts' }, 'export default {}'),
    ];
    render(<ToolCallGroup toolName="Read" calls={calls} />);
    fireEvent.click(screen.getByRole('button', { name: /🔧 Read/ }));
    expect(screen.getByText(/\/src\/index\.ts/)).toBeTruthy();
    expect(screen.getByText(/export default/)).toBeTruthy();
  });

  it('expands Edit entry to show file path and result', () => {
    const calls = [
      makeCallPair(
        'Edit',
        { file_path: '/src/utils.ts', old_string: 'foo', new_string: 'bar' },
        'Edit applied',
      ),
    ];
    render(<ToolCallGroup toolName="Edit" calls={calls} />);
    fireEvent.click(screen.getByRole('button', { name: /🔧 Edit/ }));
    expect(screen.getByText(/\/src\/utils\.ts/)).toBeTruthy();
    expect(screen.getByText(/Edit applied/)).toBeTruthy();
  });

  it('expands unknown tool to show serialized input args', () => {
    const calls = [
      makeCallPair('TodoWrite', { todos: [{ id: 1, text: 'do thing' }] }, 'ok'),
    ];
    render(<ToolCallGroup toolName="TodoWrite" calls={calls} />);
    fireEvent.click(screen.getByRole('button', { name: /🔧 TodoWrite/ }));
    expect(screen.getByText(/do thing/)).toBeTruthy();
  });

  it('truncates result longer than 20 lines', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const calls = [
      makeCallPair('Bash', { command: 'cat big.txt' }, lines.join('\n')),
    ];
    render(<ToolCallGroup toolName="Bash" calls={calls} />);
    fireEvent.click(screen.getByRole('button', { name: /🔧 Bash/ }));
    expect(screen.getByText(/\+10 lines/)).toBeTruthy();
    expect(screen.queryByText('line 30')).toBeNull();
  });

  it('does not truncate result of exactly 20 lines', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const calls = [makeCallPair('Bash', { command: 'ls' }, lines.join('\n'))];
    render(<ToolCallGroup toolName="Bash" calls={calls} />);
    fireEvent.click(screen.getByRole('button', { name: /🔧 Bash/ }));
    expect(screen.getByText(/line 20/)).toBeTruthy();
    expect(screen.queryByText(/\+.*lines/)).toBeNull();
  });

  it('collapses body when header is clicked again', () => {
    const calls = [
      makeCallPair('Read', { file_path: '/a.ts' }, 'some content'),
    ];
    render(<ToolCallGroup toolName="Read" calls={calls} />);
    const btn = screen.getByRole('button', { name: /🔧 Read/ });
    fireEvent.click(btn);
    expect(screen.getByText(/some content/)).toBeTruthy();
    fireEvent.click(btn);
    expect(screen.queryByText('some content')).toBeNull();
  });

  it('aria-expanded reflects open/closed state', () => {
    const calls = [makeCallPair('Read', { file_path: '/a.ts' }, 'r')];
    render(<ToolCallGroup toolName="Read" calls={calls} />);
    const btn = screen.getByRole('button', { name: /🔧 Read/ });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });
});

// ── groupSessionEvents tests ──────────────────────────────────────

describe('groupSessionEvents', () => {
  it('returns empty array for empty input', () => {
    expect(groupSessionEvents([])).toEqual([]);
  });

  it('passes non-tool events through unchanged', () => {
    const events = [
      makeEvent('text', 'Hello'),
      makeEvent('other', 'init'),
      makeEvent('error', 'boom'),
    ];
    const items = groupSessionEvents(events);
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.kind === 'event')).toBe(true);
  });

  it('3 consecutive Read calls render as a single group', () => {
    const events = [
      makeToolUseTextEvent('Read', { file_path: '/a.ts' }, 1000),
      makeToolResultEvent('content a', 1001),
      makeToolUseTextEvent('Read', { file_path: '/b.ts' }, 1002),
      makeToolResultEvent('content b', 1003),
      makeToolUseTextEvent('Read', { file_path: '/c.ts' }, 1004),
      makeToolResultEvent('content c', 1005),
    ];
    const items = groupSessionEvents(events);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('group');
    if (items[0].kind === 'group') {
      expect(items[0].toolName).toBe('Read');
      expect(items[0].calls).toHaveLength(3);
    }
  });

  it('renders grouped events with detail in the component header', () => {
    const events = [
      makeToolUseTextEvent('Read', { file_path: '/a.ts' }),
      makeToolResultEvent('a'),
      makeToolUseTextEvent('Read', { file_path: '/b.ts' }),
      makeToolResultEvent('b'),
      makeToolUseTextEvent('Read', { file_path: '/c.ts' }),
      makeToolResultEvent('c'),
    ];
    const items = groupSessionEvents(events);
    expect(items).toHaveLength(1);
    if (items[0].kind === 'group') {
      render(
        <ToolCallGroup toolName={items[0].toolName} calls={items[0].calls} />,
      );
      expect(screen.getByText(/🔧 Read \(a\.ts\) ×3/)).toBeTruthy();
    }
  });

  it('single tool call becomes a single-call group', () => {
    const events = [
      makeToolUseTextEvent('Read', { file_path: '/a.ts' }),
      makeToolResultEvent('content a'),
    ];
    const items = groupSessionEvents(events);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('group');
    if (items[0].kind === 'group') {
      expect(items[0].calls).toHaveLength(1);
    }
  });

  it('mixed tool calls each become single-call groups', () => {
    const events = [
      makeToolUseTextEvent('Read', { file_path: '/a.ts' }, 1000),
      makeToolResultEvent('a', 1001),
      makeToolUseTextEvent('Grep', { pattern: 'foo' }, 1002),
      makeToolResultEvent('grep output', 1003),
      makeToolUseTextEvent('Read', { file_path: '/b.ts' }, 1004),
      makeToolResultEvent('b', 1005),
    ];
    const items = groupSessionEvents(events);
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.kind === 'group')).toBe(true);
    expect(items.every((i) => i.kind === 'group' && i.calls.length === 1)).toBe(
      true,
    );
  });

  it('two separate Read groups are not merged when separated by Grep', () => {
    const events = [
      makeToolUseTextEvent('Read', { file_path: '/a.ts' }, 1000),
      makeToolResultEvent('a', 1001),
      makeToolUseTextEvent('Read', { file_path: '/b.ts' }, 1002),
      makeToolResultEvent('b', 1003),
      makeToolUseTextEvent('Grep', { pattern: 'foo' }, 1004),
      makeToolResultEvent('g', 1005),
      makeToolUseTextEvent('Read', { file_path: '/c.ts' }, 1006),
      makeToolResultEvent('c', 1007),
      makeToolUseTextEvent('Read', { file_path: '/d.ts' }, 1008),
      makeToolResultEvent('d', 1009),
    ];
    const items = groupSessionEvents(events);
    // Two Read groups + one Grep single-call group
    const groups = items.filter((i) => i.kind === 'group');
    expect(groups).toHaveLength(3);
    const readGroups = groups.filter(
      (g) => g.kind === 'group' && g.toolName === 'Read',
    );
    expect(readGroups).toHaveLength(2);
  });

  it('standalone tool_use events between text and tool_result are skipped in grouping', () => {
    const events = [
      makeToolUseTextEvent('Read', { file_path: '/a.ts' }, 1000),
      makeEvent(
        'tool_use',
        JSON.stringify({ name: 'Read', input: { file_path: '/a.ts' } }),
        1000,
      ),
      makeToolResultEvent('content a', 1001),
      makeToolUseTextEvent('Read', { file_path: '/b.ts' }, 1002),
      makeEvent(
        'tool_use',
        JSON.stringify({ name: 'Read', input: { file_path: '/b.ts' } }),
        1002,
      ),
      makeToolResultEvent('content b', 1003),
    ];
    const items = groupSessionEvents(events);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('group');
    if (items[0].kind === 'group') {
      expect(items[0].calls).toHaveLength(2);
    }
  });

  it('non-tool text events are not grouped', () => {
    const events = [
      makeEvent('text', 'Hello from Claude'),
      makeEvent('text', 'Working on it…'),
    ];
    const items = groupSessionEvents(events);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === 'event')).toBe(true);
  });
});
