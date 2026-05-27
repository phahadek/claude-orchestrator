import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CIBadges } from '../CIBadges';

describe('CIBadges', () => {
  it('renders ❌ CI failing when mergeState is ci_failed', () => {
    render(<CIBadges mergeState="ci_failed" />);
    expect(screen.getByText('❌ CI failing')).toBeDefined();
  });

  it('renders ⚠ CI unstable when mergeState is unstable', () => {
    render(<CIBadges mergeState="unstable" />);
    expect(screen.getByText('⚠ CI unstable')).toBeDefined();
  });

  it('renders ❌ CI failing when pauseReason is ci_failing regardless of mergeState', () => {
    render(<CIBadges mergeState={null} pauseReason="ci_failing" />);
    expect(screen.getByText('❌ CI failing')).toBeDefined();
  });

  it('renders nothing when mergeState is clean and pauseReason is null', () => {
    const { container } = render(<CIBadges mergeState="clean" pauseReason={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when mergeState is null and no pauseReason', () => {
    const { container } = render(<CIBadges mergeState={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when prState is merged', () => {
    const { container } = render(
      <CIBadges mergeState="ci_failed" prState="merged" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when prState is closed', () => {
    const { container } = render(
      <CIBadges mergeState="ci_failed" prState="closed" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('does not suppress badges when prState is open', () => {
    render(<CIBadges mergeState="ci_failed" prState="open" />);
    expect(screen.getByText('❌ CI failing')).toBeDefined();
  });

  it('renders as link when ciChecksUrl is provided', () => {
    render(
      <CIBadges
        mergeState="ci_failed"
        ciChecksUrl="https://github.com/owner/repo/pull/1/checks"
      />,
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe(
      'https://github.com/owner/repo/pull/1/checks',
    );
  });

  it('includes failing check names in CI failing text when failingChecks provided', () => {
    render(
      <CIBadges
        mergeState="ci_failed"
        failingChecks={['lint', 'test']}
      />,
    );
    expect(screen.getByText('❌ CI failing: lint, test')).toBeDefined();
  });
});
