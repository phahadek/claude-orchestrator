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
    mergeState: null,
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

describe('PRCard', () => {
  it('shows "Not reviewed" badge when reviewResult is null', () => {
    render(<PRCard pr={makePR()} {...defaultProps} />);
    expect(screen.getByText('— Not reviewed')).toBeDefined();
  });

  it('shows approved badge when verdict is approved', () => {
    const pr = makePR({
      reviewResult: {
        verdict: 'approved',
        dimensions: [],
        summary: 'Looks good',
      },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.getByText('✅ Approved')).toBeDefined();
  });

  it('disables Merge button when verdict is not approved', () => {
    render(<PRCard pr={makePR()} {...defaultProps} />);
    const mergeBtn = screen.getByRole('button', { name: /merge/i });
    expect(mergeBtn.hasAttribute('disabled')).toBe(true);
  });

  it('disables Merge button when verdict is needs_changes', () => {
    const pr = makePR({
      reviewResult: { verdict: 'needs_changes', dimensions: [], summary: '' },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    const mergeBtn = screen.getByRole('button', { name: /merge/i });
    expect(mergeBtn.hasAttribute('disabled')).toBe(true);
  });

  it('enables Merge button when verdict is approved and state is open', () => {
    const pr = makePR({
      reviewResult: { verdict: 'approved', dimensions: [], summary: '' },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    const mergeBtn = screen.getByRole('button', { name: /merge/i });
    expect(mergeBtn.hasAttribute('disabled')).toBe(false);
  });

  it('shows "Run Review" button when no prior review exists', () => {
    render(<PRCard pr={makePR()} {...defaultProps} />);
    expect(screen.getByRole('button', { name: /run review/i })).toBeDefined();
  });

  it('shows "Re-review" button when verdict is needs_changes and coding session is alive', () => {
    const pr = makePR({
      sessionId: 'session-123',
      reviewResult: { verdict: 'needs_changes', dimensions: [], summary: '' },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.getByRole('button', { name: /re-review/i })).toBeDefined();
  });

  it('shows "Re-review" button when verdict is incomplete and coding session is alive', () => {
    const pr = makePR({
      sessionId: 'session-123',
      reviewResult: { verdict: 'incomplete', dimensions: [], summary: '' },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.getByRole('button', { name: /re-review/i })).toBeDefined();
  });

  it('hides the review button when verdict is approved', () => {
    const pr = makePR({
      reviewResult: { verdict: 'approved', dimensions: [], summary: '' },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.queryByRole('button', { name: /run review/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /re-review/i })).toBeNull();
  });

  it('shows "Run Review" (not "Re-review") when verdict is needs_changes but coding session is dead', () => {
    const pr = makePR({
      sessionId: null,
      reviewResult: { verdict: 'needs_changes', dimensions: [], summary: '' },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.getByRole('button', { name: /run review/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /re-review/i })).toBeNull();
  });

  it('calls onReReview when "Re-review" button is clicked', () => {
    const onReReview = vi.fn();
    const pr = makePR({
      prNumber: 7,
      sessionId: 'session-abc',
      reviewResult: { verdict: 'needs_changes', dimensions: [], summary: '' },
    });
    render(<PRCard pr={pr} {...defaultProps} onReReview={onReReview} />);
    fireEvent.click(screen.getByRole('button', { name: /re-review/i }));
    expect(onReReview).toHaveBeenCalledWith(7);
  });

  it('disables "Re-review" button when reReviewInFlight is true', () => {
    const pr = makePR({
      sessionId: 'session-123',
      reviewResult: { verdict: 'needs_changes', dimensions: [], summary: '' },
    });
    render(<PRCard pr={pr} {...defaultProps} reReviewInFlight={true} />);
    const btn = screen.getByRole('button', { name: /reviewing/i });
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('disables Run Review button when reviewInFlight is true', () => {
    render(<PRCard pr={makePR()} {...defaultProps} reviewInFlight={true} />);
    const btn = screen.getByRole('button', { name: /reviewing/i });
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('shows inline error when error prop is set', () => {
    render(
      <PRCard pr={makePR()} {...defaultProps} error="Review failed: timeout" />,
    );
    expect(screen.getByText('Review failed: timeout')).toBeDefined();
  });

  it('shows "Merged" badge when state is merged, regardless of reviewResult', () => {
    const pr = makePR({ state: 'merged' });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.getByText('✓ Merged')).toBeDefined();
  });

  it('shows "Merged" badge when state is merged even if reviewResult is set', () => {
    const pr = makePR({
      state: 'merged',
      reviewResult: { verdict: 'approved', dimensions: [], summary: '' },
    });
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
    const pr = makePR({
      state: 'merged',
      reviewResult: { verdict: 'approved', dimensions: [], summary: '' },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    const mergeBtn = screen.getByRole('button', { name: /merge/i });
    expect(mergeBtn.hasAttribute('disabled')).toBe(true);
  });

  it('renders without crash when reviewResult has no dimensions property', () => {
    const pr = makePR({
      reviewResult: { verdict: 'needs_changes', summary: 'Review timed out' },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    fireEvent.click(screen.getByText(/review details/i));
    expect(screen.getByText('Review timed out')).toBeDefined();
  });

  it('renders without crash when reviewResult.dimensions is an empty array', () => {
    const pr = makePR({
      reviewResult: {
        verdict: 'needs_changes',
        dimensions: [],
        summary: 'All good',
      },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    fireEvent.click(screen.getByText(/review details/i));
    expect(screen.getByText('All good')).toBeDefined();
  });

  it('shows error verdict summary instead of dimensions list', () => {
    const pr = makePR({
      reviewResult: { verdict: 'error', summary: 'Review timed out' },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    fireEvent.click(screen.getByText(/review details/i));
    expect(screen.getByText('Review failed: Review timed out')).toBeDefined();
  });

  it('shows Approve button when verdict is null', () => {
    render(<PRCard pr={makePR()} {...defaultProps} />);
    expect(screen.getByRole('button', { name: /approve/i })).toBeDefined();
  });

  it('shows Approve button when verdict is needs_changes', () => {
    const pr = makePR({
      reviewResult: { verdict: 'needs_changes', dimensions: [], summary: '' },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.getByRole('button', { name: /approve/i })).toBeDefined();
  });

  it('does NOT show Approve button when verdict is already approved', () => {
    const pr = makePR({
      reviewResult: { verdict: 'approved', dimensions: [], summary: '' },
    });
    render(<PRCard pr={pr} {...defaultProps} />);
    expect(screen.queryByRole('button', { name: /✓ approve/i })).toBeNull();
  });

  it('calls onApprove with prNumber when Approve button is clicked', () => {
    const onApprove = vi.fn();
    render(
      <PRCard
        pr={makePR({ prNumber: 7 })}
        {...defaultProps}
        onApprove={onApprove}
      />,
    );
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

  // ── merge_state category labels & merge-button blocking ─────────────────────

  describe('merge_state category labels', () => {
    function approved(overrides: Partial<PRListItem> = {}): PRListItem {
      return makePR({
        reviewResult: { verdict: 'approved', dimensions: [], summary: '' },
        ...overrides,
      });
    }

    it('shows merge-conflict badge for mergeState=dirty', () => {
      render(
        <PRCard pr={approved({ mergeState: 'dirty' })} {...defaultProps} />,
      );
      expect(screen.getByText('⚠ Merge Conflicts')).toBeDefined();
    });

    it('shows CI-failing badge with check names for mergeState=ci_failed', () => {
      const pr = approved({
        mergeState: 'ci_failed',
        failingChecks: ['lint', 'unit-tests'],
      });
      render(<PRCard pr={pr} {...defaultProps} />);
      expect(screen.getByText(/CI failing: lint, unit-tests/)).toBeDefined();
    });

    it('shows blocked badge for mergeState=blocked', () => {
      render(
        <PRCard pr={approved({ mergeState: 'blocked' })} {...defaultProps} />,
      );
      expect(screen.getByText(/Blocked by branch protection/)).toBeDefined();
    });

    it('shows unstable badge for mergeState=unstable', () => {
      render(
        <PRCard pr={approved({ mergeState: 'unstable' })} {...defaultProps} />,
      );
      expect(screen.getByText(/CI unstable/)).toBeDefined();
    });

    it('shows unknown badge for mergeState=unknown', () => {
      render(
        <PRCard pr={approved({ mergeState: 'unknown' })} {...defaultProps} />,
      );
      expect(screen.getByText(/Mergeability unknown/)).toBeDefined();
    });

    it('disables Merge button when mergeState is dirty (approved)', () => {
      render(
        <PRCard pr={approved({ mergeState: 'dirty' })} {...defaultProps} />,
      );
      expect(
        screen.getByRole('button', { name: /merge/i }).hasAttribute('disabled'),
      ).toBe(true);
    });

    it('disables Merge button when mergeState is ci_failed (approved)', () => {
      render(
        <PRCard
          pr={approved({ mergeState: 'ci_failed', failingChecks: ['lint'] })}
          {...defaultProps}
        />,
      );
      expect(
        screen.getByRole('button', { name: /merge/i }).hasAttribute('disabled'),
      ).toBe(true);
    });

    it('disables Merge button when mergeState is blocked (approved)', () => {
      render(
        <PRCard pr={approved({ mergeState: 'blocked' })} {...defaultProps} />,
      );
      expect(
        screen.getByRole('button', { name: /merge/i }).hasAttribute('disabled'),
      ).toBe(true);
    });

    it('disables Merge button when mergeState is unstable (approved)', () => {
      render(
        <PRCard pr={approved({ mergeState: 'unstable' })} {...defaultProps} />,
      );
      expect(
        screen.getByRole('button', { name: /merge/i }).hasAttribute('disabled'),
      ).toBe(true);
    });

    it('disables Merge button when mergeState is unknown (approved)', () => {
      render(
        <PRCard pr={approved({ mergeState: 'unknown' })} {...defaultProps} />,
      );
      expect(
        screen.getByRole('button', { name: /merge/i }).hasAttribute('disabled'),
      ).toBe(true);
    });

    it('enables Merge button when mergeState is clean (approved)', () => {
      render(
        <PRCard pr={approved({ mergeState: 'clean' })} {...defaultProps} />,
      );
      expect(
        screen.getByRole('button', { name: /merge/i }).hasAttribute('disabled'),
      ).toBe(false);
    });
  });

  describe('pause reason badge', () => {
    it('shows "Review failed" badge when pauseReason is review_failed', () => {
      render(
        <PRCard pr={makePR({ pauseReason: 'review_failed' })} {...defaultProps} />,
      );
      expect(screen.getByText(/⚠ Review failed/)).toBeDefined();
    });

    it('does NOT show "Review failed" badge when pauseReason is null', () => {
      render(<PRCard pr={makePR({ pauseReason: null })} {...defaultProps} />);
      expect(screen.queryByText(/⚠ Review failed/)).toBeNull();
    });

    it('does NOT show "Review failed" badge when pauseReason is a different reason', () => {
      render(
        <PRCard pr={makePR({ pauseReason: 'stuck_timeout' })} {...defaultProps} />,
      );
      expect(screen.queryByText(/⚠ Review failed/)).toBeNull();
    });
  });
});
