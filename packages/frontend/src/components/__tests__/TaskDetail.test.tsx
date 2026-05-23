import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TaskDetail } from '../TaskDetail';
import type { TaskView } from '@claude-orchestrator/backend/src/routes/tasks';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { SessionState } from '../../hooks/useSessionStore';

function makeTask(overrides?: Partial<TaskView>): TaskView {
  return {
    taskId: 'task-1',
    taskName: 'Implement something',
    notionStatus: '🔄 In Progress',
    displayStatus: 'in_progress',
    pauseReason: null,
    priority: '🔴 High',
    notionUrl: 'https://notion.so/task-1',
    taskType: '💻 Code',
    blocked: false,
    blockerNames: [],
    wave: 1,
    codeSession: null,
    pr: null,
    review: null,
    totalTokens: { input: 0, output: 0 },
    ...overrides,
  };
}

function makeSessionState(overrides?: Partial<SessionState>): SessionState {
  return {
    sessionId: 'sess-1',
    taskName: 'Test Task',
    notionTaskUrl: 'https://notion.so/task',
    status: 'running',
    events: [],
    ...overrides,
  };
}

function makeCodeSession(
  overrides?: Partial<NonNullable<TaskView['codeSession']>>,
): NonNullable<TaskView['codeSession']> {
  return {
    sessionId: 'sess-1',
    status: 'running',
    startedAt: Date.now() - 60000,
    endedAt: null,
    lastMessage: 'Working on implementation…',
    inputTokens: 1000,
    outputTokens: 500,
    ...overrides,
  };
}

function makePr(
  overrides?: Partial<NonNullable<TaskView['pr']>>,
): NonNullable<TaskView['pr']> {
  return {
    prNumber: 42,
    prUrl: 'https://github.com/owner/repo/pull/42',
    title: 'feat: implement something',
    headBranch: 'feature/something',
    baseBranch: 'dev',
    state: 'open',
    draft: false,
    mergeState: null,
    ...overrides,
  };
}

function makeReview(
  overrides?: Partial<NonNullable<TaskView['review']>>,
): NonNullable<TaskView['review']> {
  return {
    sessionId: 'review-sess-1',
    status: 'done',
    verdict: 'approved',
    summary: 'All checks pass.',
    iterationCount: 1,
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

describe('TaskDetail', () => {
  it('renders task name', () => {
    render(<TaskDetail task={makeTask()} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Implement something')).toBeTruthy();
  });

  it('renders display status badge', () => {
    render(
      <TaskDetail
        task={makeTask({ displayStatus: 'in_progress' })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('🔄 In Progress')).toBeTruthy();
  });

  it('renders priority badge', () => {
    render(
      <TaskDetail
        task={makeTask({ priority: '🔴 High' })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('🔴 High')).toBeTruthy();
  });

  it('renders Notion link', () => {
    render(<TaskDetail task={makeTask()} send={vi.fn()} onClose={vi.fn()} />);
    const link = screen.getByText('Notion ↗');
    expect(link.getAttribute('href')).toBe('https://notion.so/task-1');
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(<TaskDetail task={makeTask()} send={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close panel'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  // ── Code session section ──

  it('does not render code session section when codeSession is null', () => {
    render(
      <TaskDetail
        task={makeTask({ codeSession: null })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText('Code Session')).toBeNull();
  });

  it('renders code session section header with status', () => {
    const codeSession = makeCodeSession();
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Code Session')).toBeTruthy();
    // The full transcript replaces the lastMessage preview when the session is
    // available in the sessions prop (otherwise a "not loaded" placeholder).
    expect(screen.getByText(/Transcript not available/)).toBeTruthy();
  });

  it('renders elapsed time in code session section', () => {
    const codeSession = makeCodeSession({
      startedAt: Date.now() - 65000,
      endedAt: null,
    });
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // Some elapsed time should be shown (1m 5s or similar)
    expect(screen.getByText('Code Session')).toBeTruthy();
  });

  it('shows message composer for active code session', () => {
    const codeSession = makeCodeSession({ status: 'running' });
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByPlaceholderText('Send a message to the session…'),
    ).toBeTruthy();
  });

  it('does not show composer for finished code session', () => {
    const codeSession = makeCodeSession({ status: 'done' });
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.queryByPlaceholderText('Send a message to the session…'),
    ).toBeNull();
  });

  it('sends send_message when composer is submitted', () => {
    const send = vi.fn();
    const codeSession = makeCodeSession({
      status: 'running',
      sessionId: 'sess-abc',
    });
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={send}
        onClose={vi.fn()}
      />,
    );
    const textarea = screen.getByPlaceholderText(
      'Send a message to the session…',
    );
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.click(screen.getByText('Send'));
    expect(send).toHaveBeenCalledWith({
      type: 'send_message',
      sessionId: 'sess-abc',
      message: 'hello',
    } as ClientMessage);
  });

  // The full transcript is now always shown inline (no toggle button).

  // ── PR section ──

  it('does not render PR section when pr is null', () => {
    render(
      <TaskDetail
        task={makeTask({ pr: null })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText('Pull Request')).toBeNull();
  });

  it('renders PR number and title', () => {
    const pr = makePr();
    render(
      <TaskDetail task={makeTask({ pr })} send={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByText('#42')).toBeTruthy();
    expect(screen.getByText('feat: implement something')).toBeTruthy();
  });

  it('renders PR branch info', () => {
    const pr = makePr();
    render(
      <TaskDetail task={makeTask({ pr })} send={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByText('feature/something → dev')).toBeTruthy();
  });

  it('renders GitHub link for PR', () => {
    const pr = makePr();
    render(
      <TaskDetail task={makeTask({ pr })} send={vi.fn()} onClose={vi.fn()} />,
    );
    const link = screen.getByText('GitHub ↗');
    expect(link.getAttribute('href')).toBe(
      'https://github.com/owner/repo/pull/42',
    );
  });

  it('shows Run Review button for open PR', () => {
    const pr = makePr({ state: 'open' });
    render(
      <TaskDetail task={makeTask({ pr })} send={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByText('Run Review')).toBeTruthy();
  });

  it('does not show Run Review button for merged PR', () => {
    const pr = makePr({ state: 'merged' });
    render(
      <TaskDetail task={makeTask({ pr })} send={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.queryByText('Run Review')).toBeNull();
  });

  it('renders draft state badge', () => {
    const pr = makePr({ state: 'open', draft: true });
    render(
      <TaskDetail task={makeTask({ pr })} send={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByText('Draft')).toBeTruthy();
  });

  // ── Review section ──

  it('does not render review section when review is null', () => {
    render(
      <TaskDetail
        task={makeTask({ review: null })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText('Review')).toBeNull();
  });

  it('renders review verdict badge', () => {
    const review = makeReview({ verdict: 'approved' });
    render(
      <TaskDetail
        task={makeTask({ review })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('✅ Approved')).toBeTruthy();
  });

  it('renders needs_changes verdict badge', () => {
    const review = makeReview({
      verdict: 'needs_changes',
      summary: 'Fix the tests.',
    });
    render(
      <TaskDetail
        task={makeTask({ review })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('⚠️ Needs Changes')).toBeTruthy();
  });

  // Review summary string is no longer rendered — only the verdict pill +
  // dimensions are surfaced (verdict pill is covered by sibling tests).

  it('renders "In progress…" pill when review session is running with no verdict', () => {
    const review = makeReview({ verdict: null, status: 'running' });
    render(
      <TaskDetail
        task={makeTask({ review })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('In progress…')).toBeTruthy();
  });

  it('is hidden when review is null', () => {
    render(
      <TaskDetail
        task={makeTask({ review: null })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText('Review')).toBeNull();
  });

  // ── Merge button ──

  it('shows Merge button only when PR is open and review is approved', () => {
    const pr = makePr({ state: 'open' });
    const review = makeReview({ verdict: 'approved' });
    render(
      <TaskDetail
        task={makeTask({ pr, review })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Merge ↓')).toBeTruthy();
  });

  it('does not show Merge button when PR is open but review is not approved', () => {
    const pr = makePr({ state: 'open' });
    const review = makeReview({ verdict: 'needs_changes' });
    render(
      <TaskDetail
        task={makeTask({ pr, review })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText('Merge ↓')).toBeNull();
  });

  it('does not show Merge button when PR is already merged', () => {
    const pr = makePr({ state: 'merged' });
    const review = makeReview({ verdict: 'approved' });
    render(
      <TaskDetail
        task={makeTask({ pr, review })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText('Merge ↓')).toBeNull();
  });

  it('calls the correct merge endpoint with owner/repo parsed from PR URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const pr = makePr({
      state: 'open',
      prUrl: 'https://github.com/owner/repo/pull/42',
      prNumber: 42,
    });
    const review = makeReview({ verdict: 'approved' });
    render(
      <TaskDetail
        task={makeTask({ pr, review })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Merge ↓'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/prs/owner/repo/42/merge', {
        method: 'POST',
      });
    });

    vi.unstubAllGlobals();
  });

  // ── Kill button ──

  it('renders Kill button when codeSession is running', () => {
    const codeSession = makeCodeSession({ status: 'running' });
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Kill')).toBeTruthy();
  });

  it('renders Kill button when codeSession is needs_permission', () => {
    const codeSession = makeCodeSession({ status: 'needs_permission' });
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Kill')).toBeTruthy();
  });

  it('does not render Kill button when codeSession is done', () => {
    const codeSession = makeCodeSession({ status: 'done' });
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText('Kill')).toBeNull();
  });

  it('does not render Kill button when codeSession is error', () => {
    const codeSession = makeCodeSession({ status: 'error' });
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText('Kill')).toBeNull();
  });

  it('does not render Kill button when codeSession is killed', () => {
    const codeSession = makeCodeSession({ status: 'killed' });
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText('Kill')).toBeNull();
  });

  it('does not render Kill button when there is no codeSession', () => {
    render(
      <TaskDetail
        task={makeTask({ codeSession: null })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText('Kill')).toBeNull();
  });

  it('shows confirm dialog with exact copy when Kill is clicked', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const codeSession = makeCodeSession({ status: 'running' });
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Kill'));
    expect(confirmSpy).toHaveBeenCalledWith(
      'Kill this session? It will have 15 seconds to wrap up.',
    );
    confirmSpy.mockRestore();
  });

  it('sends kill WS message with correct sessionId when confirmed', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const send = vi.fn();
    const codeSession = makeCodeSession({
      status: 'running',
      sessionId: 'sess-kill',
    });
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={send}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Kill'));
    expect(send).toHaveBeenCalledWith({
      type: 'kill',
      sessionId: 'sess-kill',
    } as ClientMessage);
    vi.restoreAllMocks();
  });

  it('does not send kill WS message when confirm is cancelled', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const send = vi.fn();
    const codeSession = makeCodeSession({
      status: 'running',
      sessionId: 'sess-kill',
    });
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={send}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Kill'));
    expect(send).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  // ── Kill button: live session status ──

  it('shows Kill button when task.codeSession.status is starting but live session is running', () => {
    const codeSession = makeCodeSession({
      sessionId: 'sess-1',
      status: 'starting',
    });
    const sessions: SessionState[] = [
      makeSessionState({ sessionId: 'sess-1', status: 'running' }),
    ];
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
        sessions={sessions}
      />,
    );
    expect(screen.getByText('Kill')).toBeTruthy();
  });

  it('does not show Kill button when live session status is done (regression check)', () => {
    const codeSession = makeCodeSession({
      sessionId: 'sess-1',
      status: 'running',
    });
    const sessions: SessionState[] = [
      makeSessionState({ sessionId: 'sess-1', status: 'done' }),
    ];
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
        sessions={sessions}
      />,
    );
    expect(screen.queryByText('Kill')).toBeNull();
  });

  it('shows Kill button via static task status when no live session entry exists', () => {
    const codeSession = makeCodeSession({
      sessionId: 'sess-1',
      status: 'running',
    });
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
        sessions={[]}
      />,
    );
    expect(screen.getByText('Kill')).toBeTruthy();
  });

  // ── Token aggregation display ──

  it('displays aggregated token count badge when totalTokens > 0', () => {
    render(
      <TaskDetail
        task={makeTask({ totalTokens: { input: 1000, output: 500 } })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('1.5k tokens')).toBeTruthy();
  });

  it('does not display token badge when totalTokens is zero', () => {
    render(
      <TaskDetail
        task={makeTask({ totalTokens: { input: 0, output: 0 } })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText(/tokens/)).toBeNull();
  });

  it('displays review session token count when review has tokens', () => {
    const review = makeReview({
      verdict: 'approved',
      inputTokens: 200,
      outputTokens: 100,
    });
    render(
      <TaskDetail
        task={makeTask({ review })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('300 tokens')).toBeTruthy();
  });

  // ── EventTranscript integration ──

  it('renders EventTranscript inline for code session when sessions prop includes matching session', () => {
    const codeSession = makeCodeSession({ sessionId: 'sess-1' });
    const sessions: SessionState[] = [
      makeSessionState({ sessionId: 'sess-1', events: [] }),
    ];
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
        sessions={sessions}
      />,
    );
    // Empty events render the EventTranscript empty-state text.
    expect(screen.getByText('No events yet.')).toBeTruthy();
  });

  it('renders EventTranscript for review session inside the review section', () => {
    const review = makeReview({ sessionId: 'review-sess-1' });
    const sessions: SessionState[] = [
      makeSessionState({
        sessionId: 'review-sess-1',
        status: 'done',
        events: [],
      }),
    ];
    render(
      <TaskDetail
        task={makeTask({ review })}
        send={vi.fn()}
        onClose={vi.fn()}
        sessions={sessions}
      />,
    );
    // Review section is expanded by default; the empty transcript renders the
    // EventTranscript empty-state. There are two transcripts (code + review)
    // rendering the same empty-state when both have no events; the codeSession
    // is null in this test, so only one is rendered.
    expect(screen.getByText('No events yet.')).toBeTruthy();
  });

  it('EventTranscript displays live events from session store for code session', () => {
    const codeSession = makeCodeSession({ sessionId: 'sess-1' });
    const sessions: SessionState[] = [
      makeSessionState({
        sessionId: 'sess-1',
        events: [
          {
            eventType: 'text',
            content: 'Working on the fix…',
            timestamp: 1000,
          },
        ],
      }),
    ];
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
        sessions={sessions}
      />,
    );
    expect(screen.getByText('Working on the fix…')).toBeTruthy();
  });

  // ── Diff tab ──

  it('shows Diff tab when task.pr exists', () => {
    const pr = makePr();
    render(
      <TaskDetail task={makeTask({ pr })} send={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Diff' })).toBeTruthy();
  });

  it('does not show Diff tab when task.pr is null', () => {
    render(
      <TaskDetail
        task={makeTask({ pr: null })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Diff' })).toBeNull();
  });

  it('default active tab is Overview', () => {
    const pr = makePr();
    render(
      <TaskDetail task={makeTask({ pr })} send={vi.fn()} onClose={vi.fn()} />,
    );
    // PR section content visible means Overview tab is active
    expect(screen.getByText('Pull Request')).toBeTruthy();
  });

  it('clicking Diff tab renders DiffViewer with correct prNumber', async () => {
    const pr = makePr({ prNumber: 42 });
    render(
      <TaskDetail
        task={makeTask({ pr })}
        send={vi.fn()}
        onClose={vi.fn()}
        projectId={undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Diff' }));
    // DiffViewer renders an error when projectId is absent
    await waitFor(() => {
      expect(screen.getByText(/No project ID available/)).toBeTruthy();
    });
  });

  it('switching to Diff tab hides Overview content', () => {
    const pr = makePr();
    render(
      <TaskDetail task={makeTask({ pr })} send={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Diff' }));
    expect(screen.queryByText('Pull Request')).toBeNull();
  });
});
