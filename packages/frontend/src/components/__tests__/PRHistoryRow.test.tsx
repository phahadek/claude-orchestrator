import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PRHistoryRow } from '../PRHistoryRow';
import type { PRWorkItem } from '../WorkItemCard';

function makePR(overrides: Partial<PRWorkItem> = {}): PRWorkItem {
  return {
    type: 'pr',
    prNumber: 42,
    prUrl: 'https://github.com/owner/repo/pull/42',
    repo: 'owner/repo',
    title: 'feat: my feature',
    headBranch: 'feature/my-feature',
    branchName: 'feature/my-feature',
    baseBranch: 'dev',
    state: 'merged',
    notionTaskId: null,
    notionTaskTitle: null,
    sessionId: null,
    reviewSessionId: null,
    reviewResult: null,
    reviewedAt: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    mergeState: null,
    autoMergeEnabled: false,
    ...overrides,
  };
}

describe('PRHistoryRow', () => {
  it('renders PR title linking to prUrl', () => {
    const pr = makePR({
      title: 'feat: add dashboard',
      prUrl: 'https://github.com/owner/repo/pull/42',
    });
    render(<PRHistoryRow pr={pr} />);
    const link = screen.getByRole('link', { name: 'feat: add dashboard' });
    expect(link).toBeDefined();
    expect(link.getAttribute('href')).toBe(
      'https://github.com/owner/repo/pull/42',
    );
  });

  it('renders Notion task link when notionTaskId is set', () => {
    const pr = makePR({ notionTaskId: 'abc-123-def' });
    render(<PRHistoryRow pr={pr} />);
    const taskLink = screen.getByRole('link', { name: 'Task' });
    expect(taskLink).toBeDefined();
    expect(taskLink.getAttribute('href')).toContain('notion.so');
  });

  it('does not render Notion task link when notionTaskId is null', () => {
    const pr = makePR({ notionTaskId: null });
    render(<PRHistoryRow pr={pr} />);
    expect(screen.queryByRole('link', { name: 'Task' })).toBeNull();
  });

  it('shows "Merged Xd ago" for a merged PR', () => {
    const fourteenDaysAgo = new Date(
      Date.now() - 14 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const pr = makePR({ state: 'merged', updatedAt: fourteenDaysAgo });
    render(<PRHistoryRow pr={pr} />);
    expect(screen.getByText(/Merged 14d ago/)).toBeDefined();
  });

  it('shows "Closed Xd ago" for a closed PR', () => {
    const threeDaysAgo = new Date(
      Date.now() - 3 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const pr = makePR({ state: 'closed', updatedAt: threeDaysAgo });
    render(<PRHistoryRow pr={pr} />);
    expect(screen.getByText(/Closed 3d ago/)).toBeDefined();
  });

  it('shows "Merged today" for a PR merged less than 1 day ago', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const pr = makePR({ state: 'merged', updatedAt: oneHourAgo });
    render(<PRHistoryRow pr={pr} />);
    expect(screen.getByText(/Merged today/)).toBeDefined();
  });

  it('renders Coder button when sessionId is present and calls onViewSession', () => {
    const onViewSession = vi.fn();
    const pr = makePR({ sessionId: 'session-abc' });
    render(<PRHistoryRow pr={pr} onViewSession={onViewSession} />);
    const btn = screen.getByRole('button', { name: 'Coder' });
    expect(btn).toBeDefined();
    fireEvent.click(btn);
    expect(onViewSession).toHaveBeenCalledWith('session-abc');
  });

  it('renders Reviewer button when reviewSessionId is present and calls onViewSession', () => {
    const onViewSession = vi.fn();
    const pr = makePR({ reviewSessionId: 'session-xyz' });
    render(<PRHistoryRow pr={pr} onViewSession={onViewSession} />);
    const btn = screen.getByRole('button', { name: 'Reviewer' });
    expect(btn).toBeDefined();
    fireEvent.click(btn);
    expect(onViewSession).toHaveBeenCalledWith('session-xyz');
  });

  it('does not render Coder button when sessionId is null', () => {
    const onViewSession = vi.fn();
    const pr = makePR({ sessionId: null });
    render(<PRHistoryRow pr={pr} onViewSession={onViewSession} />);
    expect(screen.queryByRole('button', { name: 'Coder' })).toBeNull();
  });

  it('does not render Reviewer button when reviewSessionId is null', () => {
    const onViewSession = vi.fn();
    const pr = makePR({ reviewSessionId: null });
    render(<PRHistoryRow pr={pr} onViewSession={onViewSession} />);
    expect(screen.queryByRole('button', { name: 'Reviewer' })).toBeNull();
  });

  it('does not render Coder/Reviewer buttons when onViewSession is not provided', () => {
    const pr = makePR({
      sessionId: 'session-abc',
      reviewSessionId: 'session-xyz',
    });
    render(<PRHistoryRow pr={pr} />);
    expect(screen.queryByRole('button', { name: 'Coder' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reviewer' })).toBeNull();
  });

  it('still renders Notion task link alongside session links (regression guard)', () => {
    const onViewSession = vi.fn();
    const pr = makePR({
      notionTaskId: 'abc-123',
      sessionId: 'session-abc',
      reviewSessionId: 'session-xyz',
    });
    render(<PRHistoryRow pr={pr} onViewSession={onViewSession} />);
    expect(screen.getByRole('link', { name: 'Task' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Coder' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Reviewer' })).toBeDefined();
  });
});
