import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TaskDetail } from '../TaskDetail';
import type { TaskView } from '@claude-orchestrator/backend/src/routes/tasks';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { SessionState } from '../../hooks/useSessionStore';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';

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

function makeProject(overrides?: Partial<ProjectConfig>): ProjectConfig {
  return {
    id: 'proj-1',
    name: 'Test Project',
    taskSource: 'notion',
    ...overrides,
  } as ProjectConfig;
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
let isMobileValue = false;
vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => isMobileValue,
}));

beforeEach(() => {
  isMobileValue = false;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
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

  it('renders source-aware link for notion-source project', () => {
    render(
      <TaskDetail
        task={makeTask()}
        send={vi.fn()}
        onClose={vi.fn()}
        project={makeProject({ taskSource: 'notion' })}
      />,
    );
    const link = screen.getByText('Notion ↗');
    expect(link.getAttribute('href')).toBe('https://notion.so/task-1');
  });

  it('renders Issue ↗ link for github-source project', () => {
    render(
      <TaskDetail
        task={makeTask({ notionUrl: 'https://github.com/owner/repo/issues/1' })}
        send={vi.fn()}
        onClose={vi.fn()}
        project={makeProject({ taskSource: 'github' })}
      />,
    );
    const link = screen.getByText('Issue ↗');
    expect(link.getAttribute('href')).toBe(
      'https://github.com/owner/repo/issues/1',
    );
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

  // ── Code session — embedded SessionPanel ──

  it('does not render code session when codeSession is null', () => {
    render(
      <TaskDetail
        task={makeTask({ codeSession: null })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // No session transcript placeholder when there is no code session
    expect(screen.queryByText(/Transcript not available/)).toBeNull();
  });

  it('shows placeholder when codeSession is set but not in sessions store', () => {
    const codeSession = makeCodeSession();
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
        sessions={[]}
      />,
    );
    expect(screen.getByText(/Transcript not available/)).toBeTruthy();
  });

  it('renders SessionPanel for code session when sessions prop includes matching session', () => {
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
    // SessionPanel renders empty transcript state
    expect(screen.getByText('No events yet.')).toBeTruthy();
  });

  it('code session SessionPanel exposes Kill button for running session', () => {
    const codeSession = makeCodeSession({ sessionId: 'sess-1', status: 'running' });
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

  it('code session SessionPanel exposes Favorite button', () => {
    const codeSession = makeCodeSession({ sessionId: 'sess-1', status: 'running' });
    const sessions: SessionState[] = [
      makeSessionState({ sessionId: 'sess-1', status: 'running' }),
    ];
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
        sessions={sessions}
        setSessionFavorited={vi.fn()}
      />,
    );
    // SessionControls renders a favorite button (☆ for unfavorited)
    expect(screen.getByLabelText('Favorite session')).toBeTruthy();
  });

  it('code session SessionPanel exposes Archive button for finished session', () => {
    const codeSession = makeCodeSession({ sessionId: 'sess-1', status: 'done' });
    const sessions: SessionState[] = [
      makeSessionState({ sessionId: 'sess-1', status: 'done' }),
    ];
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={vi.fn()}
        onClose={vi.fn()}
        sessions={sessions}
        setSessionArchived={vi.fn()}
      />,
    );
    expect(screen.getByText('Archive')).toBeTruthy();
  });

  it('code session SessionPanel exposes Delete button for finished session', () => {
    const codeSession = makeCodeSession({ sessionId: 'sess-1', status: 'done' });
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
    expect(screen.getByText('Delete')).toBeTruthy();
  });

  it('does not show Kill for finished code session', () => {
    const codeSession = makeCodeSession({ sessionId: 'sess-1', status: 'done' });
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

  it('shows message composer for active code session via SessionPanel', () => {
    const codeSession = makeCodeSession({ sessionId: 'sess-1', status: 'running' });
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
    expect(
      screen.getByPlaceholderText('Send a message to the session…'),
    ).toBeTruthy();
  });

  it('does not show composer for finished code session', () => {
    const codeSession = makeCodeSession({ sessionId: 'sess-1', status: 'done' });
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
    expect(
      screen.queryByPlaceholderText('Send a message to the session…'),
    ).toBeNull();
  });

  it('sends send_message when composer is submitted via SessionPanel', () => {
    const send = vi.fn();
    const codeSession = makeCodeSession({
      status: 'running',
      sessionId: 'sess-abc',
    });
    const sessions: SessionState[] = [
      makeSessionState({ sessionId: 'sess-abc', status: 'running' }),
    ];
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={send}
        onClose={vi.fn()}
        sessions={sessions}
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

  it('Kill button in code SessionPanel sends kill WS message', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const send = vi.fn();
    const codeSession = makeCodeSession({
      status: 'running',
      sessionId: 'sess-kill',
    });
    const sessions: SessionState[] = [
      makeSessionState({ sessionId: 'sess-kill', status: 'running' }),
    ];
    render(
      <TaskDetail
        task={makeTask({ codeSession })}
        send={send}
        onClose={vi.fn()}
        sessions={sessions}
      />,
    );
    fireEvent.click(screen.getByText('Kill'));
    expect(send).toHaveBeenCalledWith({
      type: 'kill',
      sessionId: 'sess-kill',
    } as ClientMessage);
    vi.restoreAllMocks();
  });

  // ── No task-level Overview/Diff tabs ──

  it('has no Overview tab at task level', () => {
    const pr = makePr();
    render(
      <TaskDetail task={makeTask({ pr })} send={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Overview' })).toBeNull();
  });

  it('has no Diff tab at task level', () => {
    const pr = makePr();
    render(
      <TaskDetail task={makeTask({ pr })} send={vi.fn()} onClose={vi.fn()} />,
    );
    // The PR section is rendered but there is no Diff tab at the task level
    expect(screen.getByText('Pull Request')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Diff' })).toBeNull();
  });

  it('PR section is always visible without tabs', () => {
    const pr = makePr();
    render(
      <TaskDetail task={makeTask({ pr })} send={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByText('Pull Request')).toBeTruthy();
    expect(screen.getByText('#42')).toBeTruthy();
  });

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

  it('Run Review button fires the review endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    const pr = makePr({ state: 'open', prNumber: 42 });
    render(
      <TaskDetail
        task={makeTask({ pr })}
        send={vi.fn()}
        onClose={vi.fn()}
        projectId="proj-1"
      />,
    );

    fireEvent.click(screen.getByText('Run Review'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/prs/42/review?projectId=proj-1',
        { method: 'POST' },
      );
    });

    vi.unstubAllGlobals();
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

  it('shows review transcript not available placeholder when review session not loaded', () => {
    const review = makeReview({ sessionId: 'review-sess-1' });
    render(
      <TaskDetail
        task={makeTask({ review })}
        send={vi.fn()}
        onClose={vi.fn()}
        sessions={[]}
      />,
    );
    // Expanded by default, shows placeholder
    expect(screen.getByText('Review transcript not available.')).toBeTruthy();
  });

  it('renders review SessionPanel when review session is in store', () => {
    const review = makeReview({ sessionId: 'review-sess-1' });
    const sessions: SessionState[] = [
      makeSessionState({
        sessionId: 'review-sess-1',
        status: 'done',
        sessionType: 'review',
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
    // ReviewDetailView renders "No result" when there are no events
    expect(screen.getByText('No result')).toBeTruthy();
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

  it('renders EventTranscript via SessionPanel for code session when sessions has matching session', () => {
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

  // ── InlineComposer / ReviewDimensions are gone ──

  it('TaskDetail.tsx does not reference InlineComposer', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../TaskDetail.tsx'),
      'utf-8',
    );
    expect(src).not.toContain('InlineComposer');
  });

  it('TaskDetail.tsx does not reference ReviewDimensions', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../TaskDetail.tsx'),
      'utf-8',
    );
    expect(src).not.toContain('ReviewDimensions');
  });

  // ── Mobile header chrome compaction ──

  it('TaskDetail.module.css contains mobile media query for header chrome compaction', () => {
    const cssPath = path.join(__dirname, '../TaskDetail.module.css');
    const css = fs.readFileSync(cssPath, 'utf-8');
    const mobileBlockStart = css.lastIndexOf('@media (max-width: 768px)');
    expect(mobileBlockStart).toBeGreaterThan(-1);
    const mobileBlock = css.slice(mobileBlockStart);
    expect(mobileBlock).toContain('.header');
    expect(mobileBlock).toContain('.taskName');
    expect(mobileBlock).toContain('.sectionHeader');
  });

  it('desktop header padding is not overridden outside mobile media query', () => {
    const cssPath = path.join(__dirname, '../TaskDetail.module.css');
    const css = fs.readFileSync(cssPath, 'utf-8');
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
    setMobileViewport(false);
    const pr = makePr();
    const review = makeReview({ verdict: 'approved' });
    render(
      <TaskDetail
        task={makeTask({ pr, review })}
        send={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Review')).toBeTruthy();
    expect(screen.getByText('Pull Request')).toBeTruthy();
    expect(screen.getByText('✅ Approved')).toBeTruthy();
    expect(screen.getByText('#42')).toBeTruthy();
  });

  it('mobile: expanding REVIEW collapses PULL REQUEST', () => {
    isMobileValue = true;
    const pr = makePr();
    const review = makeReview({ verdict: 'approved' });
    render(
      <TaskDetail
        task={makeTask({ pr, review })}
        send={vi.fn()}
        onClose={vi.fn()}
        sessions={[]}
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
    isMobileValue = true;
    const pr = makePr();
    const review = makeReview({ verdict: 'needs_changes' });
    render(
      <TaskDetail
        task={makeTask({ pr, review })}
        send={vi.fn()}
        onClose={vi.fn()}
        sessions={[]}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: /pull request/i, hidden: true }),
    );
    expect(screen.getByText('#42')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^review/i }));
    expect(screen.queryByText('#42')).toBeNull();
    expect(screen.getByText('⚠️ Needs Changes')).toBeTruthy();
  });

  it('mobile: section-toggle handlers track which section is open', () => {
    isMobileValue = true;
    const pr = makePr();
    const review = makeReview({ verdict: 'approved' });
    render(
      <TaskDetail
        task={makeTask({ pr, review })}
        send={vi.fn()}
        onClose={vi.fn()}
        sessions={[]}
      />,
    );
    const reviewHeader = screen.getByRole('button', { name: /^review/i });
    expect(reviewHeader.getAttribute('aria-expanded')).toBe('true');

    const prHeader = screen.getByRole('button', {
      name: /pull request/i,
      hidden: true,
    });
    fireEvent.click(prHeader);
    expect(prHeader.getAttribute('aria-expanded')).toBe('true');
    expect(reviewHeader.getAttribute('aria-expanded')).toBe('false');
  });

  // ── Shared task-views source — detail pane AC tests ──

  it('renders task data when the task prop is provided', () => {
    const task = makeTask({ taskId: 'task-001', taskName: 'Feature Work' });
    render(<TaskDetail task={task} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Feature Work')).toBeTruthy();
  });

  it('renders the correct task after the task prop is swapped', () => {
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
