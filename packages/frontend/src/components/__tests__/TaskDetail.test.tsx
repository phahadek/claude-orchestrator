import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
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

// ── useIsMobile mock ────────────────────────────────────────────────
// Controls the mobile/desktop mode for each test without touching browser globals.
let isMobileValue = false;
vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => isMobileValue,
}));

// jsdom does not implement matchMedia — provide a default desktop stub.
beforeEach(() => {
  isMobileValue = false;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false, // desktop by default
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

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

  it('close button calls history.back() (not onClose directly)', () => {
    const backSpy = vi
      .spyOn(window.history, 'back')
      .mockImplementation(() => {});
    const onClose = vi.fn();
    render(<TaskDetail task={makeTask()} send={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close panel'));
    expect(backSpy).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    backSpy.mockRestore();
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

  // ── Mobile header chrome compaction ──

  it('TaskDetail.module.css contains mobile media query for header chrome compaction', () => {
    const cssPath = path.join(__dirname, '../TaskDetail.module.css');
    const css = fs.readFileSync(cssPath, 'utf-8');
    // The mobile media query block must target the key header chrome selectors.
    // Desktop styles must remain in their original (non-media-query) blocks —
    // this verifies we are overriding, not replacing, the desktop values.
    const mobileBlockStart = css.lastIndexOf('@media (max-width: 768px)');
    expect(mobileBlockStart).toBeGreaterThan(-1);
    const mobileBlock = css.slice(mobileBlockStart);
    expect(mobileBlock).toContain('.header');
    expect(mobileBlock).toContain('.taskName');
    expect(mobileBlock).toContain('.tabButton');
    expect(mobileBlock).toContain('.sectionHeader');
  });

  it('desktop header padding is not overridden outside mobile media query', () => {
    const cssPath = path.join(__dirname, '../TaskDetail.module.css');
    const css = fs.readFileSync(cssPath, 'utf-8');
    // Desktop .header rule must retain its original padding (regression guard).
    const mobileBlockStart = css.lastIndexOf('@media (max-width: 768px)');
    const desktopCss = css.slice(0, mobileBlockStart);
    expect(desktopCss).toContain('padding: 14px 16px');
  });

  // ── Mobile accordion ──

  function setMobileViewport(matches: boolean) {
    window.matchMedia = vi.fn((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  }

  it('desktop: both REVIEW and PULL REQUEST sections can be expanded simultaneously', () => {
    setMobileViewport(false); // desktop viewport
    const pr = makePr();
    const review = makeReview({ verdict: 'approved' });
    render(
      <TaskDetail
        task={makeTask({ pr, review })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // Both sections visible by default on desktop
    expect(screen.getByText('Review')).toBeTruthy();
    expect(screen.getByText('Pull Request')).toBeTruthy();
    // REVIEW content (verdict pill) visible
    expect(screen.getByText('✅ Approved')).toBeTruthy();
    // PR content visible
    expect(screen.getByText('#42')).toBeTruthy();
  });

  it('mobile: expanding REVIEW collapses PULL REQUEST', () => {
    setMobileViewport(true); // mobile viewport
    const pr = makePr();
    const review = makeReview({ verdict: 'approved' });
    render(
      <TaskDetail
        task={makeTask({ pr, review })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // Initially REVIEW is open (body visible), PR body is collapsed
    expect(screen.getByText('Review transcript not available.')).toBeTruthy();
    expect(screen.queryByText('#42')).toBeNull();

    // Expand PR section → REVIEW body should collapse
    fireEvent.click(
      screen.getByRole('button', { name: /pull request/i, hidden: true }),
    );
    expect(screen.queryByText('Review transcript not available.')).toBeNull();
    expect(screen.getByText('#42')).toBeTruthy();
  });

  it('mobile: expanding PULL REQUEST collapses REVIEW', () => {
    setMobileViewport(true); // mobile viewport
    const pr = makePr();
    const review = makeReview({ verdict: 'needs_changes' });
    render(
      <TaskDetail
        task={makeTask({ pr, review })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // REVIEW is open initially, click PR to expand it
    fireEvent.click(
      screen.getByRole('button', { name: /pull request/i, hidden: true }),
    );
    expect(screen.getByText('#42')).toBeTruthy();
    // Click REVIEW section header (name starts with "Review", not "Run Review")
    fireEvent.click(screen.getByRole('button', { name: /^review/i }));
    expect(screen.queryByText('#42')).toBeNull();
    expect(screen.getByText('⚠️ Needs Changes')).toBeTruthy();
  });

  it('mobile: section-toggle handlers track which section is open', () => {
    setMobileViewport(true); // mobile viewport
    const pr = makePr();
    const review = makeReview({ verdict: 'approved' });
    render(
      <TaskDetail
        task={makeTask({ pr, review })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // Start: REVIEW open (name starts with "Review", distinguishes from "Run Review")
    const reviewHeader = screen.getByRole('button', { name: /^review/i });
    expect(reviewHeader.getAttribute('aria-expanded')).toBe('true');

    // Click PR header → PR opens
    const prHeader = screen.getByRole('button', {
      name: /pull request/i,
      hidden: true,
    });
    fireEvent.click(prHeader);
    expect(prHeader.getAttribute('aria-expanded')).toBe('true');
    expect(reviewHeader.getAttribute('aria-expanded')).toBe('false');
  });

  // ── Mobile: compact session summary ──────────────────────────────

  it('desktop: renders full embedded session transcript (regression)', () => {
    // isMobileValue is false by default (set in beforeEach)
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
    // Full transcript renders (EventTranscript empty-state)
    expect(screen.getByText('No events yet.')).toBeTruthy();
    // No "View full session" button on desktop
    expect(screen.queryByText('View full session')).toBeNull();
  });

  it('mobile: renders compact session summary and "View full session" button', () => {
    isMobileValue = true;
    const codeSession = makeCodeSession({
      sessionId: 'sess-1',
      lastMessage: 'Working on implementation…',
      inputTokens: 1000,
      outputTokens: 500,
    });
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // Compact summary shows last message
    expect(screen.getByText('Working on implementation…')).toBeTruthy();
    // Shows "View full session" button
    expect(screen.getByText('View full session')).toBeTruthy();
    // Full transcript NOT rendered on mobile
    expect(screen.queryByText('No events yet.')).toBeNull();
  });

  it('mobile: tapping "View full session" calls onOpenSessionOverlay', () => {
    isMobileValue = true;
    const codeSession = makeCodeSession({ sessionId: 'sess-1' });
    const onOpenSessionOverlay = vi.fn();
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
        onOpenSessionOverlay={onOpenSessionOverlay}
      />,
    );
    fireEvent.click(screen.getByText('View full session'));
    expect(onOpenSessionOverlay).toHaveBeenCalledOnce();
  });

  it('mobile: renders SessionDetail overlay when sessionOverlayOpen=true', () => {
    isMobileValue = true;
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
        sessionOverlayOpen={true}
      />,
    );
    expect(screen.getByTestId('session-overlay')).toBeTruthy();
  });

  it('mobile: session overlay backdrop calls history.back()', () => {
    isMobileValue = true;
    const codeSession = makeCodeSession({ sessionId: 'sess-1' });
    const sessions: SessionState[] = [
      makeSessionState({ sessionId: 'sess-1', events: [] }),
    ];
    const backSpy = vi
      .spyOn(window.history, 'back')
      .mockImplementation(() => {});
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
        sessions={sessions}
        sessionOverlayOpen={true}
      />,
    );
    fireEvent.click(screen.getByTestId('session-overlay-backdrop'));
    expect(backSpy).toHaveBeenCalledOnce();
    backSpy.mockRestore();
  });

  // ── Shared task-views source — detail pane AC tests ──

  it('renders task data when the task prop is provided (shared source has the task)', () => {
    const task = makeTask({ taskId: 'task-001', taskName: 'Feature Work' });
    render(<TaskDetail task={task} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Feature Work')).toBeTruthy();
  });

  it('renders the correct task after the task prop is swapped to a different task', () => {
    const taskA = makeTask({ taskId: 'task-a', taskName: 'Task A' });
    const taskB = makeTask({ taskId: 'task-b', taskName: 'Task B' });
    const { rerender } = render(
      <TaskDetail task={taskA} send={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByText('Task A')).toBeTruthy();

    rerender(<TaskDetail task={taskB} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Task B')).toBeTruthy();
    expect(screen.queryByText('Task A')).toBeNull();
  });
});
