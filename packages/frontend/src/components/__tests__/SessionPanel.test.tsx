import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionPanel } from '../SessionPanel';
import { SessionDetail } from '../SessionDetail';
import type { SessionState } from '../../hooks/useSessionStore';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ diff: '' }), { status: 200 }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

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

const defaultProps = {
  send: vi.fn() as (msg: ClientMessage) => void,
  setSessionArchived: vi.fn(),
  setSessionFavorited: vi.fn(),
};

describe('SessionPanel — code session', () => {
  it('renders controls and transcript for a running code session', () => {
    render(<SessionPanel session={makeSession()} {...defaultProps} />);
    // SessionControls renders a Kill button for running sessions
    expect(screen.getByText('Kill')).toBeTruthy();
    // Transcript area is present (EventTranscript renders its container)
    expect(
      screen.queryByPlaceholderText('Send a message to the session…'),
    ).toBeTruthy();
  });

  it('renders the Composer for an active (running) session', () => {
    render(
      <SessionPanel
        session={makeSession({ status: 'running' })}
        {...defaultProps}
      />,
    );
    expect(
      screen.getByPlaceholderText('Send a message to the session…'),
    ).toBeTruthy();
  });

  it('renders the Composer for needs_permission session', () => {
    render(
      <SessionPanel
        session={makeSession({ status: 'needs_permission' })}
        {...defaultProps}
      />,
    );
    expect(
      screen.getByPlaceholderText('Send a message to the session…'),
    ).toBeTruthy();
  });

  it('renders the Composer for idle session', () => {
    render(
      <SessionPanel
        session={makeSession({ status: 'idle' })}
        {...defaultProps}
      />,
    );
    expect(
      screen.getByPlaceholderText('Send a message to the session…'),
    ).toBeTruthy();
  });

  it('hides the Composer for terminal sessions', () => {
    for (const status of ['done', 'error', 'killed']) {
      const { unmount } = render(
        <SessionPanel session={makeSession({ status })} {...defaultProps} />,
      );
      expect(
        screen.queryByPlaceholderText('Send a message to the session…'),
      ).toBeNull();
      unmount();
    }
  });

  it('does not render Diff tab when session has no PR', () => {
    render(
      <SessionPanel
        session={makeSession({ prUrl: undefined })}
        {...defaultProps}
      />,
    );
    expect(screen.queryByText('Diff')).toBeNull();
    expect(screen.queryByText('Transcript')).toBeNull();
  });

  it('renders Transcript and Diff tabs when session has a PR', () => {
    render(
      <SessionPanel
        session={makeSession({
          status: 'done',
          prUrl: 'https://github.com/owner/repo/pull/42',
        })}
        {...defaultProps}
      />,
    );
    expect(screen.getByText('Transcript')).toBeTruthy();
    expect(screen.getByText('Diff')).toBeTruthy();
  });

  it('switching to Diff tab renders DiffViewer (refresh button present)', () => {
    render(
      <SessionPanel
        session={makeSession({
          status: 'done',
          prUrl: 'https://github.com/owner/repo/pull/42',
          project_id: 'proj-1',
        })}
        {...defaultProps}
      />,
    );
    fireEvent.click(screen.getByText('Diff'));
    // DiffViewer always renders its refresh button
    expect(screen.getByTitle('Refresh diff')).toBeTruthy();
  });

  it('switching back to Transcript tab hides DiffViewer', () => {
    render(
      <SessionPanel
        session={makeSession({
          status: 'done',
          prUrl: 'https://github.com/owner/repo/pull/42',
          project_id: 'proj-1',
        })}
        {...defaultProps}
      />,
    );
    fireEvent.click(screen.getByText('Diff'));
    fireEvent.click(screen.getByText('Transcript'));
    expect(screen.queryByTitle('Refresh diff')).toBeNull();
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(
      <SessionPanel
        session={makeSession()}
        {...defaultProps}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByLabelText('Close panel'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('SessionPanel — review session', () => {
  it('renders ReviewDetailView for a review-type session', () => {
    render(
      <SessionPanel
        session={makeSession({ sessionType: 'review', status: 'done' })}
        {...defaultProps}
      />,
    );
    // ReviewDetailView renders "No result" when there are no events and session is done
    expect(screen.getByText('No result')).toBeTruthy();
  });

  it('does not render Transcript/Diff tabs for a review session', () => {
    render(
      <SessionPanel
        session={makeSession({ sessionType: 'review', status: 'done' })}
        {...defaultProps}
      />,
    );
    expect(screen.queryByText('Transcript')).toBeNull();
    expect(screen.queryByText('Diff')).toBeNull();
  });

  it('shows transcript toggle for review session', () => {
    render(
      <SessionPanel
        session={makeSession({ sessionType: 'review', status: 'done' })}
        {...defaultProps}
      />,
    );
    expect(screen.getByText('▶ Show session transcript')).toBeTruthy();
  });
});

describe('SessionPanel — showTaskName prop', () => {
  it('renders task name by default (showTaskName unset)', () => {
    render(<SessionPanel session={makeSession()} {...defaultProps} />);
    expect(screen.getByText('Test Task')).toBeTruthy();
  });

  it('renders task name when showTaskName={true}', () => {
    render(
      <SessionPanel
        session={makeSession()}
        {...defaultProps}
        showTaskName={true}
      />,
    );
    expect(screen.getByText('Test Task')).toBeTruthy();
  });

  it('omits task name when showTaskName={false} but still renders SessionControls', () => {
    render(
      <SessionPanel
        session={makeSession()}
        {...defaultProps}
        showTaskName={false}
      />,
    );
    expect(screen.queryByText('Test Task')).toBeNull();
    // SessionControls still renders (Kill button visible for running session)
    expect(screen.getByText('Kill')).toBeTruthy();
  });
});

describe('SessionDetail as thin wrapper', () => {
  it('renders null when session is null', () => {
    const { container } = render(
      <SessionDetail session={null} {...defaultProps} onClose={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders SessionPanel content for a valid session', () => {
    render(
      <SessionDetail
        session={makeSession({ status: 'running' })}
        {...defaultProps}
        onClose={vi.fn()}
      />,
    );
    // SessionPanel renders Composer for active sessions
    expect(
      screen.getByPlaceholderText('Send a message to the session…'),
    ).toBeTruthy();
    // SessionPanel renders the task name
    expect(screen.getByText('Test Task')).toBeTruthy();
  });

  it('close button calls history.back() not onClose', () => {
    const backSpy = vi
      .spyOn(window.history, 'back')
      .mockImplementation(() => {});
    const onClose = vi.fn();
    render(
      <SessionDetail
        session={makeSession()}
        {...defaultProps}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByLabelText('Close panel'));
    expect(backSpy).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    backSpy.mockRestore();
  });
});
