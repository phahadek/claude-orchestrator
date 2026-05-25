import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { WorkItemCard } from '../WorkItemCard';
import type { PRWorkItem, LocalBranchWorkItem } from '../WorkItemCard';

function makePR(overrides: Partial<PRWorkItem> = {}): PRWorkItem {
  return {
    type: 'pr',
    prNumber: 42,
    prUrl: 'https://github.com/owner/repo/pull/42',
    title: 'Test PR',
    headBranch: 'feature/test',
    branchName: 'feature/test',
    baseBranch: 'dev',
    state: 'open',
    notionTaskId: null,
    notionTaskTitle: null,
    sessionId: null,
    reviewSessionId: null,
    repo: 'owner/repo',
    reviewResult: null,
    reviewedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    mergeState: null,
    autoMergeEnabled: false,
    ...overrides,
  };
}

function makeLocal(overrides: Partial<LocalBranchWorkItem> = {}): LocalBranchWorkItem {
  return {
    type: 'local_branch',
    sessionId: 'sess-abc',
    branchName: 'session/sess-abc',
    baseBranch: 'dev',
    status: 'done',
    reviewResult: null,
    createdAt: '2026-01-01T00:00:00Z',
    autoMergeEnabled: false,
    notionTaskId: null,
    notionTaskTitle: null,
    ...overrides,
  };
}

const defaultProps = {
  onReview: vi.fn(),
  onMerge: vi.fn(),
  onRemove: vi.fn(),
  onReReview: vi.fn(),
  onFixConflicts: vi.fn(),
  onApprove: vi.fn(),
  reviewInFlight: false,
  mergeInFlight: false,
  removeInFlight: false,
  reReviewInFlight: false,
  fixConflictsInFlight: false,
  approveInFlight: false,
  reviewElapsed: 0,
  error: null,
};

// ── local_branch acceptance criteria ─────────────────────────────────────────

describe('WorkItemCard — local_branch', () => {
  it('renders "Local" badge for type === local_branch', () => {
    render(<WorkItemCard item={makeLocal()} {...defaultProps} />);
    expect(screen.getByText('Local')).toBeDefined();
  });

  it('hides "Open on GitHub" link for type === local_branch', () => {
    render(<WorkItemCard item={makeLocal()} {...defaultProps} />);
    expect(screen.queryByTitle('Open on GitHub')).toBeNull();
    expect(screen.queryByText('↗')).toBeNull();
  });

  it('shows branch name as title for local_branch', () => {
    render(<WorkItemCard item={makeLocal({ branchName: 'session/my-session' })} {...defaultProps} />);
    expect(screen.getByText('session/my-session')).toBeDefined();
  });

  it('shows "Not reviewed" verdict badge when reviewResult is null', () => {
    render(<WorkItemCard item={makeLocal()} {...defaultProps} />);
    expect(screen.getByText('— Not reviewed')).toBeDefined();
  });

  it('shows approved verdict badge for local_branch', () => {
    render(
      <WorkItemCard
        item={makeLocal({
          reviewResult: { verdict: 'approved', summary: 'Looks good', dimensions: [] },
        })}
        {...defaultProps}
      />,
    );
    expect(screen.getByText('✅ Approved')).toBeDefined();
  });

  it('shows needs_changes verdict badge for local_branch', () => {
    render(
      <WorkItemCard
        item={makeLocal({
          reviewResult: { verdict: 'needs_changes', summary: 'Fix this', dimensions: [] },
        })}
        {...defaultProps}
      />,
    );
    expect(screen.getByText('⚠️ Needs Changes')).toBeDefined();
  });

  it('does NOT render PR-specific action buttons for local_branch', () => {
    render(<WorkItemCard item={makeLocal()} {...defaultProps} />);
    expect(screen.queryByRole('button', { name: /run review/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /merge/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('shows Notion task title when present', () => {
    render(
      <WorkItemCard
        item={makeLocal({ notionTaskTitle: 'My Task', notionTaskId: null })}
        {...defaultProps}
      />,
    );
    expect(screen.getByText('My Task')).toBeDefined();
  });

  it('shows Session link when onViewSession is provided', () => {
    render(
      <WorkItemCard
        item={makeLocal({ sessionId: 'sess-xyz' })}
        {...defaultProps}
        onViewSession={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /session ⇗/i })).toBeDefined();
  });
});

// ── pr regression tests ───────────────────────────────────────────────────────

describe('WorkItemCard — pr (regression)', () => {
  it('does NOT render "Local" badge for type === pr', () => {
    render(<WorkItemCard item={makePR()} {...defaultProps} />);
    expect(screen.queryByText('Local')).toBeNull();
  });

  it('renders "Open on GitHub" link for type === pr', () => {
    render(<WorkItemCard item={makePR()} {...defaultProps} />);
    expect(screen.getByTitle('Open on GitHub')).toBeDefined();
  });

  it('shows "Not reviewed" badge when reviewResult is null', () => {
    render(<WorkItemCard item={makePR()} {...defaultProps} />);
    expect(screen.getByText('— Not reviewed')).toBeDefined();
  });

  it('shows approved badge when verdict is approved', () => {
    render(
      <WorkItemCard
        item={makePR({ reviewResult: { verdict: 'approved', dimensions: [], summary: 'Looks good' } })}
        {...defaultProps}
      />,
    );
    expect(screen.getByText('✅ Approved')).toBeDefined();
  });

  it('disables Merge button when verdict is not approved', () => {
    render(<WorkItemCard item={makePR()} {...defaultProps} />);
    const mergeBtn = screen.getByRole('button', { name: /merge/i });
    expect(mergeBtn.hasAttribute('disabled')).toBe(true);
  });

  it('enables Merge button when verdict is approved and state is open', () => {
    render(
      <WorkItemCard
        item={makePR({ reviewResult: { verdict: 'approved', dimensions: [], summary: '' } })}
        {...defaultProps}
      />,
    );
    const mergeBtn = screen.getByRole('button', { name: /merge/i });
    expect(mergeBtn.hasAttribute('disabled')).toBe(false);
  });

  it('shows "Run Review" button when no prior review exists', () => {
    render(<WorkItemCard item={makePR()} {...defaultProps} />);
    expect(screen.getByRole('button', { name: /run review/i })).toBeDefined();
  });

  it('shows "Merged" badge when state is merged', () => {
    render(<WorkItemCard item={makePR({ state: 'merged' })} {...defaultProps} />);
    expect(screen.getByText('✓ Merged')).toBeDefined();
  });

  it('shows "Closed" badge when state is closed', () => {
    render(<WorkItemCard item={makePR({ state: 'closed' })} {...defaultProps} />);
    expect(screen.getByText('✕ Closed')).toBeDefined();
  });

  it('shows merge-conflict badge for mergeState=dirty', () => {
    render(
      <WorkItemCard
        item={makePR({ reviewResult: { verdict: 'approved', dimensions: [], summary: '' }, mergeState: 'dirty' })}
        {...defaultProps}
      />,
    );
    expect(screen.getByText('⚠ Merge Conflicts')).toBeDefined();
  });

  it('shows "Review ⇗" button when reviewSessionId is present', () => {
    render(
      <WorkItemCard
        item={makePR({ reviewSessionId: 'review-session-abc' })}
        {...defaultProps}
        onViewSession={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /review ⇗/i })).toBeDefined();
  });
});

// ── verdict badge renders for both types ─────────────────────────────────────

describe('WorkItemCard — verdict badge for both types', () => {
  it('renders approved verdict for pr type', () => {
    render(
      <WorkItemCard
        item={makePR({ reviewResult: { verdict: 'approved', summary: 'ok', dimensions: [] } })}
        {...defaultProps}
      />,
    );
    expect(screen.getByText('✅ Approved')).toBeDefined();
  });

  it('renders approved verdict for local_branch type', () => {
    render(
      <WorkItemCard
        item={makeLocal({ reviewResult: { verdict: 'approved', summary: 'ok', dimensions: [] } })}
        {...defaultProps}
      />,
    );
    expect(screen.getByText('✅ Approved')).toBeDefined();
  });

  it('renders needs_changes verdict for pr type', () => {
    render(
      <WorkItemCard
        item={makePR({ reviewResult: { verdict: 'needs_changes', summary: 'fix', dimensions: [] } })}
        {...defaultProps}
      />,
    );
    expect(screen.getByText('⚠️ Needs Changes')).toBeDefined();
  });

  it('renders needs_changes verdict for local_branch type', () => {
    render(
      <WorkItemCard
        item={makeLocal({ reviewResult: { verdict: 'needs_changes', summary: 'fix', dimensions: [] } })}
        {...defaultProps}
      />,
    );
    expect(screen.getByText('⚠️ Needs Changes')).toBeDefined();
  });
});
