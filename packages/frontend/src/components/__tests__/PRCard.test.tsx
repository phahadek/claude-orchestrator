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
  reviewInFlight: false,
  mergeInFlight: false,
  fixInFlight: false,
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
});
