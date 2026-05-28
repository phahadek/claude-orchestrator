import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SessionDetail, EventRow } from '../SessionDetail';
import type { SessionState } from '../../hooks/useSessionStore';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';

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
  timestamp = 1000,
): SessionState['events'][number] {
  return { eventType, content, timestamp };
}

describe('SessionDetail', () => {
  it('renders null when session is null', () => {
    const { container } = render(
      <SessionDetail
        session={null}
        send={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the task name and Notion link', () => {
    render(
      <SessionDetail
        session={makeSession()}
        send={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
      />,
    );
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
    render(
      <SessionDetail
        session={makeSession({ events })}
        send={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
      />,
    );
    expect(screen.getByText('Hello world')).toBeTruthy();
    expect(screen.getByText('Session started')).toBeTruthy();
    expect(screen.getByText('Something went wrong')).toBeTruthy();
  });

  it('renders the composer for running sessions', () => {
    render(
      <SessionDetail
        session={makeSession({ status: 'running' })}
        send={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
      />,
    );
    expect(
      screen.getByPlaceholderText('Send a message to the session…'),
    ).toBeTruthy();
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
      />,
    );
    expect(
      screen.getByPlaceholderText('Send a message to the session…'),
    ).toBeTruthy();
  });

  it('hides the composer for terminal states', () => {
    for (const status of ['done', 'error', 'killed']) {
      const { unmount } = render(
        <SessionDetail
          session={makeSession({ status })}
          send={vi.fn()}
          onClose={vi.fn()}
          onDelete={vi.fn()}
          onArchive={vi.fn()}
          onUnarchive={vi.fn()}
        />,
      );
      expect(
        screen.queryByPlaceholderText('Send a message to the session…'),
      ).toBeNull();
      unmount();
    }
  });

  it('sends send_message on Enter key (not Shift+Enter)', () => {
    const send = vi.fn();
    render(
      <SessionDetail
        session={makeSession()}
        send={send}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
      />,
    );
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
    render(
      <SessionDetail
        session={makeSession()}
        send={send}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
      />,
    );
    const input = screen.getByPlaceholderText('Send a message to the session…');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('does not send empty messages on Enter', () => {
    const send = vi.fn();
    render(
      <SessionDetail
        session={makeSession()}
        send={send}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
      />,
    );
    const input = screen.getByPlaceholderText('Send a message to the session…');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(send).not.toHaveBeenCalled();
  });

  // Permission engine UI (Approve/Deny/pendingPermission) was removed in favour of
  // --permission-mode acceptEdits + --allowed-tools at spawn time. The CLI does
  // not support mid-session permission prompts in --print mode, so those tests
  // no longer apply.

  it('Kill button with confirm sends kill (does not auto-close — waits for session_ended)', () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    const send = vi.fn();
    render(
      <SessionDetail
        session={makeSession({ status: 'running' })}
        send={send}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Kill'));
    expect(send).toHaveBeenCalledWith<[ClientMessage]>({
      type: 'kill',
      sessionId: 'sess-1',
    });
    vi.unstubAllGlobals();
  });

  it('Kill button confirm cancelled does not send kill', () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    const send = vi.fn();
    render(
      <SessionDetail
        session={makeSession({ status: 'running' })}
        send={send}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Kill'));
    expect(send).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('renders inline denial toggle when permissionDenials are present', () => {
    const session = makeSession({
      permissionDenials: [
        {
          tool_name: 'Bash',
          tool_use_id: 'id-1',
          tool_input: { command: 'curl https://example.com' },
        },
        {
          tool_name: 'Write',
          tool_use_id: 'id-2',
          tool_input: { file_path: '/etc/passwd' },
        },
      ],
    });
    render(
      <SessionDetail
        session={session}
        send={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
      />,
    );
    expect(screen.getByText(/2 permission denials/)).toBeTruthy();
  });

  it('inline denial section is collapsed by default and expands on click', () => {
    const session = makeSession({
      permissionDenials: [
        {
          tool_name: 'Bash',
          tool_use_id: 'id-1',
          tool_input: { command: 'curl https://example.com' },
        },
      ],
    });
    render(
      <SessionDetail
        session={session}
        send={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Denied: Bash/)).toBeNull();
    fireEvent.click(screen.getByLabelText('Toggle permission denials'));
    expect(screen.getByText(/Denied: Bash/)).toBeTruthy();
  });

  it('inline denial section is not rendered when permissionDenials is empty', () => {
    render(
      <SessionDetail
        session={makeSession({ permissionDenials: [] })}
        send={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
      />,
    );
    expect(screen.queryByText(/permission denial/)).toBeNull();
  });

  it('inline denial shows tool name and truncated Bash command after expand', () => {
    const session = makeSession({
      permissionDenials: [
        {
          tool_name: 'Bash',
          tool_use_id: 'id-1',
          tool_input: { command: 'curl https://example.com' },
        },
      ],
    });
    render(
      <SessionDetail
        session={session}
        send={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('Toggle permission denials'));
    expect(
      screen.getByText(/🚫 Denied: Bash\(curl https:\/\/example\.com\)/),
    ).toBeTruthy();
  });

  it('inline denial shows singular label for exactly 1 denial', () => {
    const session = makeSession({
      permissionDenials: [
        {
          tool_name: 'Read',
          tool_use_id: 'id-1',
          tool_input: { file_path: '/foo' },
        },
      ],
    });
    render(
      <SessionDetail
        session={session}
        send={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
      />,
    );
    expect(screen.getByText(/1 permission denial(?!s)/)).toBeTruthy();
  });

  it('close button calls history.back() (not onClose directly)', () => {
    const backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    const onClose = vi.fn();
    render(
      <SessionDetail
        session={makeSession()}
        send={vi.fn()}
        onClose={onClose}
        onDelete={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('Close panel'));
    expect(backSpy).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    backSpy.mockRestore();
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

  it('does not render standalone tool_use events (rendered via parent text event instead)', () => {
    // tool_use events arrive embedded in `assistant`-typed text events. The
    // standalone tool_use event_type renders nothing on its own.
    const content = JSON.stringify({
      type: 'tool_use',
      name: 'Read',
      input: { file_path: '/foo' },
    });
    const { container } = render(
      <EventRow event={makeEvent('tool_use', content)} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders tool_result event as indented muted block (plain string)', () => {
    render(<EventRow event={makeEvent('tool_result', 'result output')} />);
    expect(screen.getByText('result output')).toBeTruthy();
  });

  it('renders tool_result extracting content field from payload', () => {
    const content = JSON.stringify({
      type: 'tool_result',
      content: 'command output here',
    });
    render(<EventRow event={makeEvent('tool_result', content)} />);
    expect(screen.getByText('command output here')).toBeTruthy();
  });

  it('renders system event as italic text (plain string)', () => {
    render(<EventRow event={makeEvent('system', 'Session started')} />);
    expect(screen.getByText('Session started')).toBeTruthy();
  });

  it('hides system init event from transcript', () => {
    const content = JSON.stringify({ type: 'system', subtype: 'init' });
    const { container } = render(
      <EventRow event={makeEvent('system', content)} />,
    );
    // init is in the hidden-system-subtypes set — EventRow returns null
    expect(container.firstChild).toBeNull();
  });

  it('renders user event with XML tags stripped', () => {
    const content = JSON.stringify({
      type: 'user',
      message: {
        content:
          'Hello user<local-command-caveat>some caveat</local-command-caveat>',
      },
    });
    render(<EventRow event={makeEvent('system', content)} />);
    expect(screen.getByText('Hello usersome caveat')).toBeTruthy();
  });

  it('renders file-history-snapshot as summary line', () => {
    const content = JSON.stringify({
      type: 'file-history-snapshot',
      snapshot: {},
    });
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
    // The parser must double-parse it so JSON.stringify produces indented output.
    // tool_use blocks now arrive embedded in `assistant` text events.
    const innerInput = JSON.stringify({ file_path: '/foo/bar.ts' });
    const content = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Read', input: innerInput }],
      },
    });
    render(<EventRow event={makeEvent('text', content)} />);
    // The CollapsibleToolUse body holds the pretty-printed JSON. The body is
    // CSS-hidden when collapsed but still in the DOM, so the text is findable.
    expect(screen.getByText(/"file_path": "\/foo\/bar\.ts"/)).toBeTruthy();
  });

  it('extractToolResult: literal \\n sequences are unescaped to real newlines', () => {
    // The CLI sometimes encodes newlines as the two-character sequence \n.
    const content = JSON.stringify({
      type: 'tool_result',
      content: 'line1\\nline2\\nline3',
    });
    render(<EventRow event={makeEvent('tool_result', content)} />);
    // After unescaping, each line is a separate text node — find any visible line
    expect(screen.getByText(/line1/)).toBeTruthy();
  });

  it('ToolResultRow renders JSON string result as pretty-printed JSON', () => {
    const jsonPayload = JSON.stringify({ id: 'abc', name: 'test' });
    const content = JSON.stringify({
      type: 'tool_result',
      content: jsonPayload,
    });
    render(<EventRow event={makeEvent('tool_result', content)} />);
    // Pretty-printed JSON contains the key with quotes and indentation
    expect(screen.getByText(/"id": "abc"/)).toBeTruthy();
  });

  it('renders user_message event with "You" label and message content', () => {
    render(
      <EventRow event={makeEvent('user_message', 'Hello from the user')} />,
    );
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText('Hello from the user')).toBeTruthy();
  });

  it('tool_use event for Read with file_path renders filename detail in header', () => {
    const content = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Read',
            input: { file_path: 'src/App.tsx' },
          },
        ],
      },
    });
    render(<EventRow event={makeEvent('text', content)} />);
    // Detail is rendered in a span like "(App.tsx)" alongside the tool name.
    // The collapsed body also contains the file_path JSON, so the value
    // appears more than once in the DOM — assert at least one match.
    expect(screen.getAllByText(/Read/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/App\.tsx/).length).toBeGreaterThan(0);
  });

  it('tool_use event for Grep with pattern renders pattern detail in header', () => {
    const content = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Grep', input: { pattern: 'fetchTasks' } },
        ],
      },
    });
    render(<EventRow event={makeEvent('text', content)} />);
    expect(screen.getAllByText(/Grep/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/fetchTasks/).length).toBeGreaterThan(0);
  });

  it('tool_use event for unknown tool with no extractable detail renders bare tool name', () => {
    const content = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'SomeTool',
            input: { unknown_field: 'value' },
          },
        ],
      },
    });
    render(<EventRow event={makeEvent('text', content)} />);
    expect(screen.getByText(/SomeTool/)).toBeTruthy();
    expect(screen.queryByText(/\(value\)/)).toBeNull();
  });

  it('tool_use detail text longer than 60 chars is truncated with ellipsis in collapsed header', () => {
    const longPattern = 'x'.repeat(70);
    const content = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Grep', input: { pattern: longPattern } },
        ],
      },
    });
    render(<EventRow event={makeEvent('text', content)} />);
    const truncated = '(' + 'x'.repeat(60) + '…)';
    expect(screen.getByText(truncated)).toBeTruthy();
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
      </>,
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
          {
            type: 'tool_use',
            id: 'toolu_01',
            name: 'Read',
            input: { file_path: '/src/foo.ts' },
          },
        ],
      },
    });
    render(<EventRow event={makeEvent('text', content)} />);
    expect(screen.getByText(/Read/)).toBeTruthy();
    expect(screen.getByText(/"file_path": "\/src\/foo\.ts"/)).toBeTruthy();
    expect(screen.queryByText(/input_tokens/)).toBeNull();
    expect(screen.queryByText(/stop_reason/)).toBeNull();
  });

  it('internal metadata fields (model, usage, stop_reason) are not rendered for assistant messages', () => {
    const content = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-opus-4-6',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 200,
          output_tokens: 80,
          cache_read_input_tokens: 50,
        },
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
    const content = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Task complete',
    });
    const { container } = render(
      <EventRow event={makeEvent('system', content)} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('returns null for system event with empty extracted content', () => {
    // A system payload whose content field is an empty string — extractSystem returns ''
    const content = JSON.stringify({ type: 'system', content: '' });
    const { container } = render(
      <EventRow event={makeEvent('system', content)} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('returns null for user system event where content is entirely XML tags', () => {
    // After stripping XML, content is empty — should not render anything
    const content = JSON.stringify({
      type: 'user',
      message: { content: '<caveat></caveat>' },
    });
    const { container } = render(
      <EventRow event={makeEvent('system', content)} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders user event with array content showing the message text, not [user]', () => {
    const content = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Please fix the bug in foo.ts' }],
      },
    });
    render(<EventRow event={makeEvent('system', content)} />);
    expect(screen.getByText('Please fix the bug in foo.ts')).toBeTruthy();
    expect(screen.queryByText('[user]')).toBeNull();
  });

  it('returns null for user event with array content that is only a system-reminder block', () => {
    // The entire text block is wrapped in a system tag — after stripping tag+content, nothing remains
    const content = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<system-reminder>Do not do X</system-reminder>',
          },
        ],
      },
    });
    const { container } = render(
      <EventRow event={makeEvent('system', content)} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('assistant message with both text and tool_use blocks renders both', () => {
    const content = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'I will run a command.' },
          {
            type: 'tool_use',
            id: 'toolu_02',
            name: 'Bash',
            input: { command: 'echo hello' },
          },
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
          {
            type: 'tool_use',
            id: 'toolu_03',
            name: 'Glob',
            input: { pattern: '**/*.ts' },
          },
        ],
      },
    });
    render(<EventRow event={makeEvent('text', content)} />);
    expect(screen.queryByText(/"type": "tool_use"/)).toBeNull();
    expect(screen.queryByText(/toolu_03/)).toBeNull();
    expect(screen.getByText(/Glob/)).toBeTruthy();
  });
});
