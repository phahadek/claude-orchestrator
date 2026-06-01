import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
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
});
