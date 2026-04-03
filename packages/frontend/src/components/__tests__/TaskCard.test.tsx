import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TaskCard } from '../TaskCard';
import type { TaskView, DisplayStatus } from '../../types/taskView';

function makeTask(overrides?: Partial<TaskView>): TaskView {
  return {
    taskId: 'task-1',
    taskName: 'Implement Feature',
    notionStatus: '🗂️ Ready',
    displayStatus: 'ready',
    priority: '',
    notionUrl: 'https://notion.so/task-1',
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
    startedAt: Date.now() - 60_000,
    endedAt: null,
    lastMessage: 'Writing tests...',
    inputTokens: 100,
    outputTokens: 50,
    ...overrides,
  };
}

function makePr(overrides?: Partial<NonNullable<TaskView['pr']>>): NonNullable<TaskView['pr']> {
  return {
    prNumber: 42,
    prUrl: 'https://github.com/owner/repo/pull/42',
    title: 'feat: implement feature',
    headBranch: 'feature/implement-feature',
    baseBranch: 'dev',
    state: 'open',
    draft: false,
    ...overrides,
  };
}

function makeReview(overrides?: Partial<NonNullable<TaskView['review']>>): NonNullable<TaskView['review']> {
  return {
    sessionId: 'review-1',
    status: 'done',
    verdict: 'approved',
    summary: 'Looks good',
    iterationCount: 1,
    ...overrides,
  };
}

describe('TaskCard', () => {
  it('renders task name', () => {
    render(<TaskCard task={makeTask()} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText('Implement Feature')).toBeDefined();
  });

  it('renders priority badge when priority is set', () => {
    render(<TaskCard task={makeTask({ priority: '🔴 High' })} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText('🔴 High')).toBeDefined();
  });

  it('does not render priority badge when priority is empty', () => {
    render(<TaskCard task={makeTask({ priority: '' })} selected={false} onClick={vi.fn()} />);
    expect(screen.queryByText(/High|Low|Medium/)).toBeNull();
  });

  it('renders code session status line with elapsed time when codeSession is present', () => {
    const session = makeCodeSession({ status: 'running', startedAt: Date.now() - 90_000, endedAt: null });
    render(<TaskCard task={makeTask({ codeSession: session })} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText('running')).toBeDefined();
    // Elapsed should be shown (some time string)
    expect(screen.getByText(/\d+m \d+s|\d+s|< 1s/)).toBeDefined();
  });

  it('renders lastMessage in session line when present', () => {
    const session = makeCodeSession({ lastMessage: 'Writing tests...' });
    render(<TaskCard task={makeTask({ codeSession: session })} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText('Writing tests...')).toBeDefined();
  });

  it('renders — placeholder in session line when codeSession is null', () => {
    render(<TaskCard task={makeTask({ codeSession: null })} selected={false} onClick={vi.fn()} />);
    const placeholders = screen.getAllByText('—');
    expect(placeholders.length).toBeGreaterThanOrEqual(1);
  });

  it('renders — placeholder in meta line when pr is null', () => {
    render(<TaskCard task={makeTask({ pr: null })} selected={false} onClick={vi.fn()} />);
    const placeholders = screen.getAllByText('—');
    expect(placeholders.length).toBeGreaterThanOrEqual(1);
  });

  it('renders PR number and state when pr is present', () => {
    render(<TaskCard task={makeTask({ pr: makePr({ prNumber: 42, state: 'open', draft: false }) })} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText('#42')).toBeDefined();
    expect(screen.getByText('open')).toBeDefined();
  });

  it('renders "draft" as PR state when pr.draft is true', () => {
    render(<TaskCard task={makeTask({ pr: makePr({ draft: true, state: 'open' }) })} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText('draft')).toBeDefined();
  });

  it('renders review verdict badge when review.verdict is present', () => {
    render(<TaskCard task={makeTask({ review: makeReview({ verdict: 'approved' }) })} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText('✅ Approved')).toBeDefined();
  });

  it('renders needs_changes verdict label', () => {
    render(<TaskCard task={makeTask({ review: makeReview({ verdict: 'needs_changes' }) })} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText('🔁 Needs changes')).toBeDefined();
  });

  it('does not render verdict badge when review.verdict is null', () => {
    render(<TaskCard task={makeTask({ review: makeReview({ verdict: null }) })} selected={false} onClick={vi.fn()} />);
    expect(screen.queryByText(/Approved|Needs changes|Incomplete/)).toBeNull();
  });

  it('renders Notion link when notionUrl is set', () => {
    render(<TaskCard task={makeTask({ notionUrl: 'https://notion.so/task-1' })} selected={false} onClick={vi.fn()} />);
    expect(screen.getByText('Notion ↗')).toBeDefined();
  });

  it('calls onClick when card is clicked', () => {
    const onClick = vi.fn();
    render(<TaskCard task={makeTask()} selected={false} onClick={onClick} />);
    fireEvent.click(screen.getByText('Implement Feature'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('applies correct data-display-status for each displayStatus value', () => {
    const statuses: DisplayStatus[] = [
      'ready', 'in_progress', 'in_review', 'needs_attention', 'ready_to_merge', 'done',
    ];
    for (const status of statuses) {
      const { container, unmount } = render(
        <TaskCard task={makeTask({ displayStatus: status })} selected={false} onClick={vi.fn()} />
      );
      const card = container.firstElementChild as HTMLElement;
      expect(card.getAttribute('data-display-status')).toBe(status);
      unmount();
    }
  });

  it('applies status CSS class for each displayStatus value', () => {
    const statuses: DisplayStatus[] = [
      'ready', 'in_progress', 'in_review', 'needs_attention', 'ready_to_merge', 'done',
    ];
    for (const status of statuses) {
      const { container, unmount } = render(
        <TaskCard task={makeTask({ displayStatus: status })} selected={false} onClick={vi.fn()} />
      );
      const card = container.firstElementChild as HTMLElement;
      expect(card.className).toContain(`status-${status}`);
      unmount();
    }
  });
});
