import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionControls } from '../SessionControls';
import type { SessionState } from '../../hooks/useSessionStore';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
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

describe('SessionControls — active session', () => {
  it('shows End Session and Kill buttons for running sessions', () => {
    render(<SessionControls session={makeSession()} {...defaultProps} />);
    expect(screen.getByText('End Session')).toBeTruthy();
    expect(screen.getByText('Kill')).toBeTruthy();
  });

  it('hides Archive and Delete buttons for active sessions', () => {
    render(<SessionControls session={makeSession()} {...defaultProps} />);
    expect(screen.queryByText('Archive')).toBeNull();
    expect(screen.queryByText('Delete')).toBeNull();
  });

  it('shows End Session and Kill for needs_permission status', () => {
    render(
      <SessionControls
        session={makeSession({ status: 'needs_permission' })}
        {...defaultProps}
      />,
    );
    expect(screen.getByText('End Session')).toBeTruthy();
    expect(screen.getByText('Kill')).toBeTruthy();
  });
});

describe('SessionControls — inactive session', () => {
  it('shows Archive and Delete buttons for done sessions', () => {
    render(
      <SessionControls
        session={makeSession({ status: 'done' })}
        {...defaultProps}
      />,
    );
    expect(screen.getByText('Archive')).toBeTruthy();
    expect(screen.getByText('Delete')).toBeTruthy();
  });

  it('hides End Session and Kill buttons for done sessions', () => {
    render(
      <SessionControls
        session={makeSession({ status: 'done' })}
        {...defaultProps}
      />,
    );
    expect(screen.queryByText('End Session')).toBeNull();
    expect(screen.queryByText('Kill')).toBeNull();
  });

  it('shows Unarchive instead of Archive for archived sessions', () => {
    render(
      <SessionControls
        session={makeSession({ status: 'done', archived: true })}
        {...defaultProps}
      />,
    );
    expect(screen.getByText('Unarchive')).toBeTruthy();
    expect(screen.queryByText('Archive')).toBeNull();
  });
});

describe('SessionControls — Kill action', () => {
  it('sends kill WS message when confirmed', () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    const send = vi.fn();
    render(
      <SessionControls session={makeSession()} {...defaultProps} send={send} />,
    );
    fireEvent.click(screen.getByText('Kill'));
    expect(send).toHaveBeenCalledWith<[ClientMessage]>({
      type: 'kill',
      sessionId: 'sess-1',
    });
    vi.unstubAllGlobals();
  });

  it('does not send kill when confirm is cancelled', () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    const send = vi.fn();
    render(
      <SessionControls session={makeSession()} {...defaultProps} send={send} />,
    );
    fireEvent.click(screen.getByText('Kill'));
    expect(send).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('SessionControls — End Session action', () => {
  it('sends end_session WS message when confirmed', () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    const send = vi.fn();
    render(
      <SessionControls session={makeSession()} {...defaultProps} send={send} />,
    );
    fireEvent.click(screen.getByText('End Session'));
    expect(send).toHaveBeenCalledWith<[ClientMessage]>({
      type: 'end_session',
      sessionId: 'sess-1',
    });
    vi.unstubAllGlobals();
  });

  it('does not send end_session when confirm is cancelled', () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    const send = vi.fn();
    render(
      <SessionControls session={makeSession()} {...defaultProps} send={send} />,
    );
    fireEvent.click(screen.getByText('End Session'));
    expect(send).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('SessionControls — Delete action', () => {
  it('calls DELETE endpoint and invokes onDeleted when confirmed', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    const onDeleted = vi.fn();
    render(
      <SessionControls
        session={makeSession({ status: 'done' })}
        {...defaultProps}
        onDeleted={onDeleted}
      />,
    );
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/sessions/sess-1', {
        method: 'DELETE',
      });
      expect(onDeleted).toHaveBeenCalledWith('sess-1');
    });
    vi.unstubAllGlobals();
  });

  it('does not call DELETE when confirm is cancelled', () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    render(
      <SessionControls
        session={makeSession({ status: 'done' })}
        {...defaultProps}
      />,
    );
    fireEvent.click(screen.getByText('Delete'));
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('SessionControls — Archive action', () => {
  it('calls archive endpoint and invokes setSessionArchived(id, true)', async () => {
    const setSessionArchived = vi.fn();
    render(
      <SessionControls
        session={makeSession({ status: 'done' })}
        {...defaultProps}
        setSessionArchived={setSessionArchived}
      />,
    );
    fireEvent.click(screen.getByText('Archive'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/sessions/sess-1/archive', {
        method: 'PATCH',
      });
      expect(setSessionArchived).toHaveBeenCalledWith('sess-1', true);
    });
  });

  it('calls unarchive endpoint and invokes setSessionArchived(id, false)', async () => {
    const setSessionArchived = vi.fn();
    render(
      <SessionControls
        session={makeSession({ status: 'done', archived: true })}
        {...defaultProps}
        setSessionArchived={setSessionArchived}
      />,
    );
    fireEvent.click(screen.getByText('Unarchive'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/sessions/sess-1/unarchive', {
        method: 'PATCH',
      });
      expect(setSessionArchived).toHaveBeenCalledWith('sess-1', false);
    });
  });
});

describe('SessionControls — Favorite action', () => {
  it('calls favorite endpoint and invokes setSessionFavorited(id, true) when not favorited', async () => {
    const setSessionFavorited = vi.fn();
    render(
      <SessionControls
        session={makeSession({ favorited: false })}
        {...defaultProps}
        setSessionFavorited={setSessionFavorited}
      />,
    );
    fireEvent.click(screen.getByLabelText('Favorite session'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/sessions/sess-1/favorite', {
        method: 'PATCH',
      });
      expect(setSessionFavorited).toHaveBeenCalledWith('sess-1', true);
    });
  });

  it('calls unfavorite endpoint and invokes setSessionFavorited(id, false) when favorited', async () => {
    const setSessionFavorited = vi.fn();
    render(
      <SessionControls
        session={makeSession({ favorited: true })}
        {...defaultProps}
        setSessionFavorited={setSessionFavorited}
      />,
    );
    fireEvent.click(screen.getByLabelText('Unfavorite session'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/sessions/sess-1/unfavorite',
        { method: 'PATCH' },
      );
      expect(setSessionFavorited).toHaveBeenCalledWith('sess-1', false);
    });
  });
});

describe('SessionControls — Resume action', () => {
  it('shows Resume button when session is rate-limited and onResume is provided', () => {
    render(
      <SessionControls
        session={makeSession({ isRateLimited: true })}
        {...defaultProps}
        onResume={vi.fn()}
      />,
    );
    expect(screen.getByText('Resume')).toBeTruthy();
  });

  it('calls onResume with sessionId when Resume is clicked', () => {
    const onResume = vi.fn();
    render(
      <SessionControls
        session={makeSession({ isRateLimited: true })}
        {...defaultProps}
        onResume={onResume}
      />,
    );
    fireEvent.click(screen.getByText('Resume'));
    expect(onResume).toHaveBeenCalledWith('sess-1');
  });

  it('does not show Resume button when isRateLimited is false', () => {
    render(
      <SessionControls
        session={makeSession({ isRateLimited: false })}
        {...defaultProps}
        onResume={vi.fn()}
      />,
    );
    expect(screen.queryByText('Resume')).toBeNull();
  });

  it('does not show Resume button when onResume is not provided', () => {
    render(
      <SessionControls
        session={makeSession({ isRateLimited: true })}
        {...defaultProps}
      />,
    );
    expect(screen.queryByText('Resume')).toBeNull();
  });
});

describe('SessionControls — Note editor', () => {
  it('shows Add a note placeholder when no note is set', () => {
    render(<SessionControls session={makeSession()} {...defaultProps} />);
    expect(screen.getByText('+ Add a note...')).toBeTruthy();
  });

  it('shows existing note text as the placeholder button', () => {
    render(
      <SessionControls
        session={makeSession({ note: 'My note here' })}
        {...defaultProps}
      />,
    );
    expect(screen.getByText('My note here')).toBeTruthy();
  });

  it('clicking note placeholder shows input', () => {
    render(<SessionControls session={makeSession()} {...defaultProps} />);
    fireEvent.click(screen.getByText('+ Add a note...'));
    expect(screen.getByPlaceholderText('Add a note...')).toBeTruthy();
  });

  it('commits note via PATCH on Enter', async () => {
    render(<SessionControls session={makeSession()} {...defaultProps} />);
    fireEvent.click(screen.getByText('+ Add a note...'));
    const input = screen.getByPlaceholderText('Add a note...');
    fireEvent.change(input, { target: { value: 'hello note' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/sessions/sess-1/note', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'hello note' }),
      });
    });
  });

  it('commits note via PATCH on blur', async () => {
    render(<SessionControls session={makeSession()} {...defaultProps} />);
    fireEvent.click(screen.getByText('+ Add a note...'));
    const input = screen.getByPlaceholderText('Add a note...');
    fireEvent.change(input, { target: { value: 'blur note' } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/sessions/sess-1/note', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'blur note' }),
      });
    });
  });

  it('cancels note editing on Escape without committing', () => {
    render(
      <SessionControls
        session={makeSession({ note: 'original' })}
        {...defaultProps}
      />,
    );
    fireEvent.click(screen.getByText('original'));
    const input = screen.getByPlaceholderText('Add a note...');
    fireEvent.change(input, { target: { value: 'changed' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByPlaceholderText('Add a note...')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('SessionControls — Tags', () => {
  it('renders existing tags as pills', () => {
    render(
      <SessionControls
        session={makeSession({ tags: ['alpha', 'beta'] })}
        {...defaultProps}
      />,
    );
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText('beta')).toBeTruthy();
  });

  it('adds a tag via PATCH on Enter', async () => {
    render(
      <SessionControls session={makeSession({ tags: [] })} {...defaultProps} />,
    );
    const input = screen.getByPlaceholderText('Add tag...');
    fireEvent.change(input, { target: { value: 'newtag' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/sessions/sess-1/tags', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: ['newtag'] }),
      });
    });
  });

  it('removes a tag via PATCH when × is clicked', async () => {
    render(
      <SessionControls
        session={makeSession({ tags: ['keep', 'remove'] })}
        {...defaultProps}
      />,
    );
    fireEvent.click(screen.getByLabelText('Remove tag remove'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/sessions/sess-1/tags', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: ['keep'] }),
      });
    });
  });

  it('does not add a duplicate tag', async () => {
    render(
      <SessionControls
        session={makeSession({ tags: ['existing'] })}
        {...defaultProps}
      />,
    );
    const input = screen.getByPlaceholderText('Add tag...');
    fireEvent.change(input, { target: { value: 'existing' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe('SessionControls — Close button', () => {
  it('renders close button when onClose is provided', () => {
    render(
      <SessionControls
        session={makeSession()}
        {...defaultProps}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Close panel')).toBeTruthy();
  });

  it('does not render close button when onClose is not provided', () => {
    render(<SessionControls session={makeSession()} {...defaultProps} />);
    expect(screen.queryByLabelText('Close panel')).toBeNull();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(
      <SessionControls
        session={makeSession()}
        {...defaultProps}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByLabelText('Close panel'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
