import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SubagentBlock } from '../SubagentBlock';
import { groupSessionEvents } from '../EventTranscript.helpers';

// ── Test helpers ──────────────────────────────────────────────────

function makeEvent(eventType: string, content: string, timestamp = 1000) {
  return { eventType, content, timestamp };
}

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

// ── SubagentBlock rendering ─────────────────────────────────────────

describe('SubagentBlock', () => {
  it('renders a collapsed header with the subagent description', () => {
    const calls = [
      makeCallPair(
        'Task',
        {
          description: 'Find auth bug',
          prompt: 'Investigate...',
          subagent_type: 'Explore',
        },
        'Found it in auth.ts',
      ),
    ];
    render(<SubagentBlock toolName="Task" calls={calls} />);
    expect(screen.getByText(/Subagent: Find auth bug/)).toBeTruthy();
    expect(screen.getByText(/\(Explore\)/)).toBeTruthy();
  });

  it('does not show prompt or result when collapsed', () => {
    const calls = [
      makeCallPair(
        'Task',
        { description: 'Find auth bug', prompt: 'Investigate the login flow' },
        'Found it in auth.ts',
      ),
    ];
    render(<SubagentBlock toolName="Task" calls={calls} />);
    expect(screen.queryByText(/Investigate the login flow/)).toBeNull();
    expect(screen.queryByText(/Found it in auth\.ts/)).toBeNull();
  });

  it('expands to show prompt and result on click', () => {
    const calls = [
      makeCallPair(
        'Task',
        { description: 'Find auth bug', prompt: 'Investigate the login flow' },
        'Found it in auth.ts',
      ),
    ];
    render(<SubagentBlock toolName="Task" calls={calls} />);
    fireEvent.click(
      screen.getByRole('button', { name: /Subagent: Find auth bug/ }),
    );
    expect(screen.getByText(/Investigate the login flow/)).toBeTruthy();
    expect(screen.getByText(/Found it in auth\.ts/)).toBeTruthy();
  });

  it('aria-expanded reflects open/closed state', () => {
    const calls = [
      makeCallPair('Task', { description: 'Do thing', prompt: 'p' }, 'r'),
    ];
    render(<SubagentBlock toolName="Task" calls={calls} />);
    const header = screen.getByRole('button', { name: /Subagent: Do thing/ });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
  });
});

// ── groupSessionEvents: subagent grouping ──────────────────────────

describe('groupSessionEvents (subagent grouping)', () => {
  it('groups a Task tool_use + result as a distinct subagent block', () => {
    const events = [
      makeToolUseTextEvent(
        'Task',
        { description: 'Find bug', prompt: 'go' },
        1000,
      ),
      makeToolResultEvent('done', 1001),
    ];
    const items = groupSessionEvents(events);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('subagent');
    if (items[0].kind === 'subagent') {
      expect(items[0].toolName).toBe('Task');
      expect(items[0].calls).toHaveLength(1);
    }
  });

  it('does not merge consecutive Task calls into one block', () => {
    const events = [
      makeToolUseTextEvent('Task', { description: 'First' }, 1000),
      makeToolResultEvent('result 1', 1001),
      makeToolUseTextEvent('Task', { description: 'Second' }, 1002),
      makeToolResultEvent('result 2', 1003),
    ];
    const items = groupSessionEvents(events);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === 'subagent')).toBe(true);
    expect(
      items.every((i) => i.kind === 'subagent' && i.calls.length === 1),
    ).toBe(true);
  });

  it('keeps non-subagent tool calls in regular groups', () => {
    const events = [
      makeToolUseTextEvent('Read', { file_path: '/a.ts' }, 1000),
      makeToolResultEvent('content', 1001),
    ];
    const items = groupSessionEvents(events);
    expect(items[0].kind).toBe('group');
  });

  it('a Task call surrounded by other events stays visually distinct', () => {
    const events = [
      makeEvent('text', 'Starting work'),
      makeToolUseTextEvent('Task', { description: 'Explore repo' }, 1000),
      makeToolResultEvent('found nothing', 1001),
      makeEvent('text', 'Done'),
    ];
    const items = groupSessionEvents(events);
    expect(items).toHaveLength(3);
    expect(items[0].kind).toBe('event');
    expect(items[1].kind).toBe('subagent');
    expect(items[2].kind).toBe('event');
  });
});
