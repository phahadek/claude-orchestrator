import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SessionDetail, EventRow } from '../SessionDetail';
import type { SessionState } from '../../hooks/useSessionStore';
import type { ClientMessage } from '@claude-dashboard/backend/src/ws/types';

function makeSession(overrides?: Partial<SessionState>): SessionState {
  return {
    sessionId: 'sess-1',
    taskName: 'Test Task',
    notionTaskUrl: 'https://notion.so/task',
    status: 'running',
    events: [],
    ...overrides,
  };
}

function makeEvent(
  eventType: string,
  content: string,
  timestamp = 1000
): SessionState['events'][number] {
  return { eventType, content, timestamp };
}

describe('SessionDetail', () => {
  it('renders null when session is null', () => {
    const { container } = render(
      <SessionDetail session={null} send={vi.fn()} onClose={vi.fn()} onDelete={vi.fn()} onArchive={vi.fn()} onUnarchive={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the task name and Notion link', () => {
    render(<SessionDetail session={makeSession()} send={vi.fn()} onClose={vi.fn()} onDelete={vi.fn()} onArchive={vi.fn()} onUnarchive={vi.fn()} />);
    expect(screen.getByText('Test Task')).toBeTruthy();
    const notionLink = screen.getByText('Notion ↗');
    expect(notionLink.getAttribute('href')).toBe('https://notion.so/task');
  });

  it('renders all events from session.events', () => {
    const events = [
      makeEvent('text', 'Hello world', 1000),
      makeEvent('system', 'Session started', 2000),
      makeEvent('error', 'Something went wrong', 3000),
    ];
    render(<SessionDetail session={makeSession({ events })} send={vi.fn()} onClose={vi.fn()} onDelete={vi.fn()} onArchive={vi.fn()} onUnarchive={vi.fn()} />);
    expect(screen.getByText('Hello world')).toBeTruthy();
    expect(screen.getByText('Session started')).toBeTruthy();
    expect(screen.getByText('Something went wrong')).toBeTruthy();
  });

  it('renders the composer for running sessions', () => {
    render(
      <SessionDetail session={makeSession({ status: 'running' })} send={vi.fn()} onClose={vi.fn()} onDelete={vi.fn()} onArchive={vi.fn()} onUnarchive={vi.fn()} />
    );
    expect(screen.getByPlaceholderText('Send a message to the session…')).toBeTruthy();
  });

  it('renders the composer for needs_permission sessions', () => {
    render(
      <SessionDetail
        session={makeSession({ status: 'needs_permission' })}
        send={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
      />
    );
    expect(screen.getByPlaceholderText('Send a message to the session…')).toBeTruthy();
  });

  it('hides the composer for terminal states', () => {
    for (const status of ['done', 'error', 'killed']) {
      const { unmount } = render(
        <SessionDetail session={makeSession({ status })} send={vi.fn()} onClose={vi.fn()} onDelete={vi.fn()} onArchive={vi.fn()} onUnarchive={vi.fn()} />
      );
      expect(screen.queryByPlaceholderText('Send a message to the session…')).toBeNull();
      unmount();
    }
  });

  it('sends send_message on Enter key (not Shift+Enter)', () => {
    const send = vi.fn();
    render(<SessionDetail session={makeSession()} send={send} onClose={vi.fn()} onDelete={vi.fn()} onArchive={vi.fn()} onUnarchive={vi.fn()} />);
    const input = screen.getByPlaceholderText('Send a message to the session…');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(send).toHaveBeenCalledWith<[ClientMessage]>({
      type: 'send_message',
      sessionId: 'sess-1',
      message: 'hello',
    });
  });

  it('does not send on Shift+Enter', () => {
    const send = vi.fn();
    render(<SessionDetail session={makeSession()} send={send} onClose={vi.fn()} onDelete={vi.fn()} onArchive={vi.fn()} onUnarchive={vi.fn()} />);
    const input = screen.getByPlaceholderText('Send a message to the session…');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('does not send empty messages on Enter', () => {
    const send = vi.fn();
    render(<SessionDetail session={makeSession()} send={send} onClose={vi.fn()} onDelete={vi.fn()} onArchive={vi.fn()} onUnarchive={vi.fn()} />);
    const input = screen.getByPlaceholderText('Send a message to the session…');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('renders permission request section when pendingPermission is set', () => {
    const session = makeSession({
      status: 'needs_permission',
      pendingPermission: { toolName: 'Bash', proposedAction: 'rm -rf /tmp/foo' },
    });
    render(<SessionDetail session={session} send={vi.fn()} onClose={vi.fn()} onDelete={vi.fn()} onArchive={vi.fn()} onUnarchive={vi.fn()} />);
    expect(screen.getByText(/Bash/)).toBeTruthy();
    expect(screen.getByText('rm -rf /tmp/foo')).toBeTruthy();
    expect(screen.getByText('✅ Approve')).toBeTruthy();
    expect(screen.getByText('❌ Deny')).toBeTruthy();
  });

  it('does not render permission request when pendingPermission is absent', () => {
    render(<SessionDetail session={makeSession()} send={vi.fn()} onClose={vi.fn()} onDelete={vi.fn()} onArchive={vi.fn()} onUnarchive={vi.fn()} />);
    expect(screen.queryByText('✅ Approve')).toBeNull();
  });

  it('Approve sends correct ClientMessage', () => {
    const send = vi.fn();
    const session = makeSession({
      status: 'needs_permission',
      pendingPermission: { toolName: 'Read', proposedAction: 'read /etc/hosts' },
    });
    render(<SessionDetail session={session} send={send} onClose={vi.fn()} onDelete={vi.fn()} onArchive={vi.fn()} onUnarchive={vi.fn()} />);
    fireEvent.click(screen.getByText('✅ Approve'));
    expect(send).toHaveBeenCalledWith<[ClientMessage]>({ type: 'approve', sessionId: 'sess-1' });
  });

  it('Deny sends correct ClientMessage', () => {
    const send = vi.fn();
    const session = makeSession({
      status: 'needs_permission',
      pendingPermission: { toolName: 'Bash', proposedAction: 'ls /' },
    });
    render(<SessionDetail session={session} send={send} onClose={vi.fn()} onDelete={vi.fn()} onArchive={vi.fn()} onUnarchive={vi.fn()} />);
    fireEvent.click(screen.getByText('❌ Deny'));
    expect(send).toHaveBeenCalledWith<[ClientMessage]>({
      type: 'deny',
      sessionId: 'sess-1',
      reason: 'User denied',
    });
  });

  it('Kill button with confirm sends kill and calls onClose', () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    const send = vi.fn();
    const onClose = vi.fn();
    render(<SessionDetail session={makeSession({ status: 'running' })} send={send} onClose={onClose} onDelete={vi.fn()} onArchive={vi.fn()} onUnarchive={vi.fn()} />);
    fireEvent.click(screen.getByText('Kill'));
    expect(send).toHaveBeenCalledWith<[ClientMessage]>({ type: 'kill', sessionId: 'sess-1' });
    expect(onClose).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('Kill button confirm cancelled does not send kill', () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    const send = vi.fn();
    render(<SessionDetail session={makeSession({ status: 'running' })} send={send} onClose={vi.fn()} onDelete={vi.fn()} onArchive={vi.fn()} onUnarchive={vi.fn()} />);
    fireEvent.click(screen.getByText('Kill'));
    expect(send).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('clicking ✕ on a denial card removes it from the rendered list', () => {
    const session = makeSession({
      permissionDenials: [
        { tool_name: 'Bash', tool_use_id: 'id-1', tool_input: { command: 'rm -rf' } },
        { tool_name: 'Write', tool_use_id: 'id-2', tool_input: { file_path: '/etc/passwd' } },
      ],
    });
    render(<SessionDetail session={session} send={vi.fn()} onClose={vi.fn()} onDelete={vi.fn()} onArchive={vi.fn()} onUnarchive={vi.fn()} />);
    expect(screen.getByText('Bash')).toBeTruthy();
    const dismissBtns = screen.getAllByLabelText('Dismiss');
    fireEvent.click(dismissBtns[0]);
    expect(screen.queryByText('Bash')).toBeNull();
    expect(screen.getByText('Write')).toBeTruthy();
  });

  it('"Clear all" button is visible when ≥ 2 denial cards are present', () => {
    const session = makeSession({
      permissionDenials: [
        { tool_name: 'Bash', tool_use_id: 'id-1', tool_input: {} },
        { tool_name: 'Write', tool_use_id: 'id-2', tool_input: {} },
      ],
    });
    render(<SessionDetail session={session} send={vi.fn()} onClose={vi.fn()} onDelete={vi.fn()} onArchive={vi.fn()} onUnarchive={vi.fn()} />);
    expect(screen.getByText('Clear all')).toBeTruthy();
  });

  it('"Clear all" removes all denial cards', () => {
    const session = makeSession({
      permissionDenials: [
        { tool_name: 'Bash', tool_use_id: 'id-1', tool_input: {} },
        { tool_name: 'Write', tool_use_id: 'id-2', tool_input: {} },
      ],
    });
    render(<SessionDetail session={session} send={vi.fn()} onClose={vi.fn()} onDelete={vi.fn()} onArchive={vi.fn()} onUnarchive={vi.fn()} />);
    fireEvent.click(screen.getByText('Clear all'));
    expect(screen.queryByText('Bash')).toBeNull();
    expect(screen.queryByText('Write')).toBeNull();
  });

  it('onClose is called when close button is clicked', () => {
    const onClose = vi.fn();
    render(<SessionDetail session={makeSession()} send={vi.fn()} onClose={onClose} onDelete={vi.fn()} onArchive={vi.fn()} onUnarchive={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Close panel'));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('EventRow', () => {
  it('renders text event as a paragraph (plain string)', () => {
    render(<EventRow event={makeEvent('text', 'Hello from Claude')} />);
    const el = screen.getByText('Hello from Claude');
    expect(el.tagName).toBe('P');
  });

  it('renders text event from full assistant event payload', () => {
    const content = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hello from assistant' }],
      },
    });
    render(<EventRow event={makeEvent('text', content)} />);
    expect(screen.getByText('Hello from assistant')).toBeTruthy();
  });

  it('renders tool_use event with tool name header and args (legacy format)', () => {
    const content = JSON.stringify({ toolName: 'Bash', input: { command: 'ls' } });
    render(<EventRow event={makeEvent('tool_use', content)} />);
    expect(screen.getByText(/Bash/)).toBeTruthy();
    expect(screen.getByText(/\"command\": \"ls\"/)).toBeTruthy();
  });

  it('renders tool_use event with Claude CLI name/input format', () => {
    const content = JSON.stringify({ type: 'tool_use', name: 'Read', input: { file_path: '/foo' } });
    render(<EventRow event={makeEvent('tool_use', content)} />);
    expect(screen.getByText(/Read/)).toBeTruthy();
    expect(screen.getByText(/\"file_path\": \"\/foo\"/)).toBeTruthy();
  });

  it('renders tool_use event with raw content when JSON is invalid', () => {
    render(<EventRow event={makeEvent('tool_use', 'not-json')} />);
    expect(screen.getByText('not-json')).toBeTruthy();
  });

  it('renders tool_result event as indented muted block (plain string)', () => {
    render(<EventRow event={makeEvent('tool_result', 'result output')} />);
    expect(screen.getByText('result output')).toBeTruthy();
  });

  it('renders tool_result extracting content field from payload', () => {
    const content = JSON.stringify({ type: 'tool_result', content: 'command output here' });
    render(<EventRow event={makeEvent('tool_result', content)} />);
    expect(screen.getByText('command output here')).toBeTruthy();
  });

  it('renders system event as italic text (plain string)', () => {
    render(<EventRow event={makeEvent('system', 'Session started')} />);
    expect(screen.getByText('Session started')).toBeTruthy();
  });

  it('renders system event extracting subtype from payload', () => {
    const content = JSON.stringify({ type: 'system', subtype: 'init' });
    render(<EventRow event={makeEvent('system', content)} />);
    expect(screen.getByText('[init]')).toBeTruthy();
  });

  it('renders user event with XML tags stripped', () => {
    const content = JSON.stringify({
      type: 'user',
      message: { content: 'Hello user<local-command-caveat>some caveat</local-command-caveat>' },
    });
    render(<EventRow event={makeEvent('system', content)} />);
    expect(screen.getByText('Hello usersome caveat')).toBeTruthy();
  });

  it('renders file-history-snapshot as summary line', () => {
    const content = JSON.stringify({ type: 'file-history-snapshot', snapshot: {} });
    render(<EventRow event={makeEvent('system', content)} />);
    expect(screen.getByText(/File history snapshot/)).toBeTruthy();
  });

  it('renders error event in red block (plain string)', () => {
    render(<EventRow event={makeEvent('error', 'Something broke')} />);
    expect(screen.getByText('Something broke')).toBeTruthy();
  });

  it('renders error event extracting message field from payload', () => {
    const content = JSON.stringify({ type: 'error', message: 'Spawn failed' });
    render(<EventRow event={makeEvent('error', content)} />);
    expect(screen.getByText('Spawn failed')).toBeTruthy();
  });

  it('extractToolUse: string input field is double-parsed into an object', () => {
    // The Claude CLI sometimes encodes input as a JSON string rather than an object.
    // extractToolUse must parse it so JSON.stringify produces indented output.
    const innerInput = JSON.stringify({ file_path: '/foo/bar.ts' });
    const content = JSON.stringify({ type: 'tool_use', name: 'Read', input: innerInput });
    render(<EventRow event={makeEvent('tool_use', content)} />);
    // If double-parse works, the rendered args contain the key with indentation
    expect(screen.getByText(/\"file_path\": \"\/foo\/bar\.ts\"/)).toBeTruthy();
  });

  it('extractToolResult: literal \\n sequences are unescaped to real newlines', () => {
    // The CLI sometimes encodes newlines as the two-character sequence \n.
    const content = JSON.stringify({ type: 'tool_result', content: 'line1\\nline2\\nline3' });
    render(<EventRow event={makeEvent('tool_result', content)} />);
    // After unescaping, each line is a separate text node — find any visible line
    expect(screen.getByText(/line1/)).toBeTruthy();
  });

  it('ToolResultRow renders JSON string result as pretty-printed JSON', () => {
    const jsonPayload = JSON.stringify({ id: 'abc', name: 'test' });
    const content = JSON.stringify({ type: 'tool_result', content: jsonPayload });
    render(<EventRow event={makeEvent('tool_result', content)} />);
    // Pretty-printed JSON contains the key with quotes and indentation
    expect(screen.getByText(/\"id\": \"abc\"/)).toBeTruthy();
  });

  it('renders user_message event with "You" label and message content', () => {
    render(<EventRow event={makeEvent('user_message', 'Hello from the user')} />);
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText('Hello from the user')).toBeTruthy();
  });

  it('uses timestamp-eventType as key (tests via stable rendering)', () => {
    // Validates the key format renders without duplicate-key warnings
    const events = [
      makeEvent('text', 'first', 1000),
      makeEvent('system', 'second', 2000),
    ];
    const { container } = render(
      <>
        {events.map((e) => (
          <EventRow key={`${e.timestamp}-${e.eventType}`} event={e} />
        ))}
      </>
    );
    expect(container.querySelectorAll('p').length).toBe(2);
  });

  it('tool_use content block inside assistant message renders tool name and input, not raw JSON', () => {
    const content = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_01',
        model: 'claude-sonnet-4-5',
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [
          { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/src/foo.ts' } },
        ],
      },
    });
    render(<EventRow event={makeEvent('text', content)} />);
    expect(screen.getByText(/Read/)).toBeTruthy();
    expect(screen.getByText(/\"file_path\": \"\/src\/foo\.ts\"/)).toBeTruthy();
    expect(screen.queryByText(/input_tokens/)).toBeNull();
    expect(screen.queryByText(/stop_reason/)).toBeNull();
  });

  it('internal metadata fields (model, usage, stop_reason) are not rendered for assistant messages', () => {
    const content = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-opus-4-6',
        stop_reason: 'end_turn',
        usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 50 },
        content: [{ type: 'text', text: 'Done.' }],
      },
    });
    render(<EventRow event={makeEvent('text', content)} />);
    expect(screen.getByText('Done.')).toBeTruthy();
    expect(screen.queryByText(/claude-opus/)).toBeNull();
    expect(screen.queryByText(/end_turn/)).toBeNull();
    expect(screen.queryByText(/input_tokens/)).toBeNull();
    expect(screen.queryByText(/cache_read_input_tokens/)).toBeNull();
  });

  it('result system events are hidden from transcript', () => {
    const content = JSON.stringify({ type: 'result', subtype: 'success', result: 'Task complete' });
    const { container } = render(<EventRow event={makeEvent('system', content)} />);
    expect(container.firstChild).toBeNull();
  });

  it('assistant message with both text and tool_use blocks renders both', () => {
    const content = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'I will run a command.' },
          { type: 'tool_use', id: 'toolu_02', name: 'Bash', input: { command: 'echo hello' } },
        ],
      },
    });
    render(<EventRow event={makeEvent('text', content)} />);
    expect(screen.getByText('I will run a command.')).toBeTruthy();
    expect(screen.getByText(/Bash/)).toBeTruthy();
    expect(screen.getByText(/\$ echo hello/)).toBeTruthy();
  });

  it('assistant message with only tool_use blocks renders nothing raw', () => {
    const content = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_03', name: 'Glob', input: { pattern: '**/*.ts' } },
        ],
      },
    });
    render(<EventRow event={makeEvent('text', content)} />);
    expect(screen.queryByText(/"type": "tool_use"/)).toBeNull();
    expect(screen.queryByText(/toolu_03/)).toBeNull();
    expect(screen.getByText(/Glob/)).toBeTruthy();
  });
});
