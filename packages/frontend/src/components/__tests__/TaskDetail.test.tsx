import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TaskDetail } from '../TaskDetail';
import type { TaskView } from '@claude-dashboard/backend/src/routes/tasks';
import type { ClientMessage } from '@claude-dashboard/backend/src/ws/types';

function makeTask(overrides?: Partial<TaskView>): TaskView {
  return {
    taskId: 'task-1',
    taskName: 'Implement something',
    notionStatus: '🔄 In Progress',
    displayStatus: 'in_progress',
    priority: '🔴 High',
    notionUrl: 'https://notion.so/task-1',
    taskType: '💻 Code',
    blocked: false,
    blockerNames: [],
    codeSession: null,
    pr: null,
    review: null,
    ...overrides,
  };
}

function makeCodeSession(overrides?: Partial<NonNullable<TaskView['codeSession']>>): NonNullable<TaskView['codeSession']> {
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

function makePr(overrides?: Partial<NonNullable<TaskView['pr']>>): NonNullable<TaskView['pr']> {
  return {
    prNumber: 42,
    prUrl: 'https://github.com/owner/repo/pull/42',
    title: 'feat: implement something',
    headBranch: 'feature/something',
    baseBranch: 'dev',
    state: 'open',
    draft: false,
    ...overrides,
  };
}

function makeReview(overrides?: Partial<NonNullable<TaskView['review']>>): NonNullable<TaskView['review']> {
  return {
    sessionId: 'review-sess-1',
    status: 'done',
    verdict: 'approved',
    summary: 'All checks pass.',
    iterationCount: 1,
    ...overrides,
  };
}

describe('TaskDetail', () => {
  it('renders task name', () => {
    render(<TaskDetail task={makeTask()} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Implement something')).toBeTruthy();
  });

  it('renders display status badge', () => {
    render(<TaskDetail task={makeTask({ displayStatus: 'in_progress' })} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('🔄 In Progress')).toBeTruthy();
  });

  it('renders priority badge', () => {
    render(<TaskDetail task={makeTask({ priority: '🔴 High' })} send={vi.fn()} onClose={vi.fn()} />);
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
    render(<TaskDetail task={makeTask({ codeSession: null })} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByText('Code Session')).toBeNull();
  });

  it('renders code session section with status and last message', () => {
    const codeSession = makeCodeSession({ lastMessage: 'Implementing feature X' });
    render(<TaskDetail task={makeTask({ codeSession })} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Code Session')).toBeTruthy();
    expect(screen.getByText('Implementing feature X')).toBeTruthy();
  });

  it('renders elapsed time in code session section', () => {
    const codeSession = makeCodeSession({ startedAt: Date.now() - 65000, endedAt: null });
    render(<TaskDetail task={makeTask({ codeSession })} send={vi.fn()} onClose={vi.fn()} />);
    // Some elapsed time should be shown (1m 5s or similar)
    expect(screen.getByText('Code Session')).toBeTruthy();
  });

  it('shows message composer for active code session', () => {
    const codeSession = makeCodeSession({ status: 'running' });
    render(<TaskDetail task={makeTask({ codeSession })} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByPlaceholderText('Send a message to the session…')).toBeTruthy();
  });

  it('does not show composer for finished code session', () => {
    const codeSession = makeCodeSession({ status: 'done' });
    render(<TaskDetail task={makeTask({ codeSession })} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByPlaceholderText('Send a message to the session…')).toBeNull();
  });

  it('sends send_message when composer is submitted', () => {
    const send = vi.fn();
    const codeSession = makeCodeSession({ status: 'running', sessionId: 'sess-abc' });
    render(<TaskDetail task={makeTask({ codeSession })} send={send} onClose={vi.fn()} />);
    const textarea = screen.getByPlaceholderText('Send a message to the session…');
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.click(screen.getByText('Send'));
    expect(send).toHaveBeenCalledWith({ type: 'send_message', sessionId: 'sess-abc', message: 'hello' } as ClientMessage);
  });

  it('shows transcript toggle for code session', () => {
    const codeSession = makeCodeSession();
    render(<TaskDetail task={makeTask({ codeSession })} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('▶ View full transcript')).toBeTruthy();
  });

  it('toggles code transcript visibility', () => {
    const codeSession = makeCodeSession();
    render(<TaskDetail task={makeTask({ codeSession })} send={vi.fn()} onClose={vi.fn()} />);
    const toggle = screen.getByText('▶ View full transcript');
    fireEvent.click(toggle);
    expect(screen.getByText('▼ Hide transcript')).toBeTruthy();
  });

  // ── PR section ──

  it('does not render PR section when pr is null', () => {
    render(<TaskDetail task={makeTask({ pr: null })} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByText('Pull Request')).toBeNull();
  });

  it('renders PR number and title', () => {
    const pr = makePr();
    render(<TaskDetail task={makeTask({ pr })} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('#42')).toBeTruthy();
    expect(screen.getByText('feat: implement something')).toBeTruthy();
  });

  it('renders PR branch info', () => {
    const pr = makePr();
    render(<TaskDetail task={makeTask({ pr })} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('feature/something → dev')).toBeTruthy();
  });

  it('renders GitHub link for PR', () => {
    const pr = makePr();
    render(<TaskDetail task={makeTask({ pr })} send={vi.fn()} onClose={vi.fn()} />);
    const link = screen.getByText('GitHub ↗');
    expect(link.getAttribute('href')).toBe('https://github.com/owner/repo/pull/42');
  });

  it('shows Run Review button for open PR', () => {
    const pr = makePr({ state: 'open' });
    render(<TaskDetail task={makeTask({ pr })} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Run Review')).toBeTruthy();
  });

  it('does not show Run Review button for merged PR', () => {
    const pr = makePr({ state: 'merged' });
    render(<TaskDetail task={makeTask({ pr })} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByText('Run Review')).toBeNull();
  });

  it('renders draft state badge', () => {
    const pr = makePr({ state: 'open', draft: true });
    render(<TaskDetail task={makeTask({ pr })} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Draft')).toBeTruthy();
  });

  // ── Review section ──

  it('does not render review section when review is null', () => {
    render(<TaskDetail task={makeTask({ review: null })} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByText('Review')).toBeNull();
  });

  it('renders review verdict badge', () => {
    const review = makeReview({ verdict: 'approved' });
    render(<TaskDetail task={makeTask({ review })} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('✅ Approved')).toBeTruthy();
  });

  it('renders needs_changes verdict badge', () => {
    const review = makeReview({ verdict: 'needs_changes', summary: 'Fix the tests.' });
    render(<TaskDetail task={makeTask({ review })} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('⚠️ Needs Changes')).toBeTruthy();
  });

  it('renders review summary', () => {
    const review = makeReview({ verdict: 'approved', summary: 'All checks pass.' });
    render(<TaskDetail task={makeTask({ review })} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('All checks pass.')).toBeTruthy();
  });

  it('renders "Review in progress" when review session is running', () => {
    const review = makeReview({ verdict: null, status: 'running' });
    render(<TaskDetail task={makeTask({ review })} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Review in progress…')).toBeTruthy();
  });

  it('is hidden when review is null', () => {
    render(<TaskDetail task={makeTask({ review: null })} send={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByText('Review')).toBeNull();
  });
});
