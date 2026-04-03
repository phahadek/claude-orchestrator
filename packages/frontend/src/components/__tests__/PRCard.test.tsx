import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PRCard } from '../PRCard';
import type { PRListItem } from '../PRCard';

function makePR(overrides: Partial<PRListItem> = {}): PRListItem {
  return {
    prNumber: 42,
    prUrl: 'https://github.com/owner/repo/pull/42',
    title: 'Test PR',
    headBranch: 'feature/test',
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
    ...overrides,
  };
}

const defaultProps = {
  onReview: vi.fn(),
  onMerge: vi.fn(),
  onFix: vi.fn(),
  onRemove: vi.fn(),
  onReReview: vi.fn(),
  onApprove: vi.fn(),
  reviewInFlight: false,
  mergeInFlight: false,
  fixInFlight: false,
  removeInFlight: false,
  reReviewInFlight: false,
  approveInFlight: false,
  reviewElapsed: 0,
  error: null,
};

describe('PRCard', () => {
  it('shows "Not reviewed" badge when reviewResult is null', () => {
    render(<PRCard pr={makePR()} {...defaultProps} />);
    expect(screen.getByText('— Not reviewed')).toBeDefined();
  });

  it('shows approved badge when verdict is approved', () => {
    const pr = makePR({ reviewResult: { verdict: 'approved', dimensions: [], summary: 'Looks good' } });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.getByText('✅ Approved')).toBeDefined();
  });

  it('disables Merge button when verdict is not approved', () => {
    render(<PRCard pr={makePR()} {...defaultProps} />);
    const mergeBtn = screen.getByRole('button', { name: /merge/i });
    expect(mergeBtn.hasAttribute('disabled')).toBe(true);
  });

  it('disables Merge button when verdict is needs_changes', () => {
    const pr = makePR({ reviewResult: { verdict: 'needs_changes', dimensions: [], summary: '' } });
    render(<PRCard pr={pr} {...defaultProps} />);
    const mergeBtn = screen.getByRole('button', { name: /merge/i });
    expect(mergeBtn.hasAttribute('disabled')).toBe(true);
  });

  it('enables Merge button when verdict is approved and state is open', () => {
    const pr = makePR({ reviewResult: { verdict: 'approved', dimensions: [], summary: '' } });
    render(<PRCard pr={pr} {...defaultProps} />);
    const mergeBtn = screen.getByRole('button', { name: /merge/i });
    expect(mergeBtn.hasAttribute('disabled')).toBe(false);
  });

  it('shows Send to Session button when verdict is needs_changes', () => {
    const pr = makePR({ reviewResult: { verdict: 'needs_changes', dimensions: [], summary: '' } });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.getByText(/send to session/i)).toBeDefined();
  });

  it('shows Send to Session button when verdict is incomplete', () => {
    const pr = makePR({ reviewResult: { verdict: 'incomplete', dimensions: [], summary: '' } });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.getByText(/send to session/i)).toBeDefined();
  });

  it('does not show Send to Session button when verdict is approved', () => {
    const pr = makePR({ reviewResult: { verdict: 'approved', dimensions: [], summary: '' } });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.queryByText(/send to session/i)).toBeNull();
  });

  it('calls onFix with prNumber when Send to Session is clicked', () => {
    const onFix = vi.fn();
    const pr = makePR({ prNumber: 7, reviewResult: { verdict: 'needs_changes', dimensions: [], summary: '' } });
    render(<PRCard pr={pr} {...defaultProps} onFix={onFix} />);
    fireEvent.click(screen.getByText(/send to session/i));
    expect(onFix).toHaveBeenCalledWith(7);
  });

  it('disables Send to Session button when fixInFlight is true', () => {
    const pr = makePR({ reviewResult: { verdict: 'needs_changes', dimensions: [], summary: '' } });
    render(<PRCard pr={pr} {...defaultProps} fixInFlight={true} />);
    const btn = screen.getByRole('button', { name: /sending/i });
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('disables Run Review button when reviewInFlight is true', () => {
    render(<PRCard pr={makePR()} {...defaultProps} reviewInFlight={true} />);
    const btn = screen.getByRole('button', { name: /reviewing/i });
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('shows inline error when error prop is set', () => {
    render(<PRCard pr={makePR()} {...defaultProps} error="Review failed: timeout" />);
    expect(screen.getByText('Review failed: timeout')).toBeDefined();
  });

  it('shows "Merged" badge when state is merged, regardless of reviewResult', () => {
    const pr = makePR({ state: 'merged' });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.getByText('✓ Merged')).toBeDefined();
  });

  it('shows "Merged" badge when state is merged even if reviewResult is set', () => {
    const pr = makePR({ state: 'merged', reviewResult: { verdict: 'approved', dimensions: [], summary: '' } });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.getByText('✓ Merged')).toBeDefined();
    expect(screen.queryByText('✅ Approved')).toBeNull();
  });

  it('shows "Closed" badge when state is closed', () => {
    const pr = makePR({ state: 'closed' });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.getByText('✕ Closed')).toBeDefined();
  });

  it('hides Run Review button when state is merged', () => {
    const pr = makePR({ state: 'merged' });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.queryByRole('button', { name: /run review/i })).toBeNull();
  });

  it('disables Merge button when state is merged', () => {
    const pr = makePR({ state: 'merged', reviewResult: { verdict: 'approved', dimensions: [], summary: '' } });
    render(<PRCard pr={pr} {...defaultProps} />);
    const mergeBtn = screen.getByRole('button', { name: /merge/i });
    expect(mergeBtn.hasAttribute('disabled')).toBe(true);
  });

  it('renders without crash when reviewResult has no dimensions property', () => {
    const pr = makePR({ reviewResult: { verdict: 'needs_changes', summary: 'Review timed out' } });
    render(<PRCard pr={pr} {...defaultProps} />);
    fireEvent.click(screen.getByText(/review details/i));
    expect(screen.getByText('Review timed out')).toBeDefined();
  });

  it('renders without crash when reviewResult.dimensions is an empty array', () => {
    const pr = makePR({ reviewResult: { verdict: 'needs_changes', dimensions: [], summary: 'All good' } });
    render(<PRCard pr={pr} {...defaultProps} />);
    fireEvent.click(screen.getByText(/review details/i));
    expect(screen.getByText('All good')).toBeDefined();
  });

  it('shows error verdict summary instead of dimensions list', () => {
    const pr = makePR({ reviewResult: { verdict: 'error', summary: 'Review timed out' } });
    render(<PRCard pr={pr} {...defaultProps} />);
    fireEvent.click(screen.getByText(/review details/i));
    expect(screen.getByText('Review failed: Review timed out')).toBeDefined();
  });

  it('shows Approve button when verdict is null', () => {
    render(<PRCard pr={makePR()} {...defaultProps} />);
    expect(screen.getByRole('button', { name: /approve/i })).toBeDefined();
  });

  it('shows Approve button when verdict is needs_changes', () => {
    const pr = makePR({ reviewResult: { verdict: 'needs_changes', dimensions: [], summary: '' } });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.getByRole('button', { name: /approve/i })).toBeDefined();
  });

  it('does NOT show Approve button when verdict is already approved', () => {
    const pr = makePR({ reviewResult: { verdict: 'approved', dimensions: [], summary: '' } });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.queryByRole('button', { name: /✓ approve/i })).toBeNull();
  });

  it('calls onApprove with prNumber when Approve button is clicked', () => {
    const onApprove = vi.fn();
    render(<PRCard pr={makePR({ prNumber: 7 })} {...defaultProps} onApprove={onApprove} />);
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(onApprove).toHaveBeenCalledWith(7);
  });

  it('disables Approve button when approveInFlight is true', () => {
    render(<PRCard pr={makePR()} {...defaultProps} approveInFlight={true} />);
    const btn = screen.getByRole('button', { name: /approving/i });
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('shows "Review ⇗" button when reviewSessionId is present and onViewSession is provided', () => {
    const pr = makePR({ reviewSessionId: 'review-session-abc' });
    render(<PRCard pr={pr} {...defaultProps} onViewSession={vi.fn()} />);
    expect(screen.getByRole('button', { name: /review ⇗/i })).toBeDefined();
  });

  it('does NOT show "Review ⇗" button when reviewSessionId is null', () => {
    const pr = makePR({ reviewSessionId: null });
    render(<PRCard pr={pr} {...defaultProps} onViewSession={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /review ⇗/i })).toBeNull();
  });

  it('calls onViewSession with reviewSessionId when "Review ⇗" is clicked', () => {
    const onViewSession = vi.fn();
    const pr = makePR({ reviewSessionId: 'review-session-xyz' });
    render(<PRCard pr={pr} {...defaultProps} onViewSession={onViewSession} />);
    fireEvent.click(screen.getByRole('button', { name: /review ⇗/i }));
    expect(onViewSession).toHaveBeenCalledWith('review-session-xyz');
  });
});
