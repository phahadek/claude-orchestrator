import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CIBadges, PipelineStageBadge } from '../CIBadges';

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
    const { container } = render(
      <CIBadges mergeState="clean" pauseReason={null} />,
    );
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
      <CIBadges mergeState="ci_failed" failingChecks={['lint', 'test']} />,
    );
    expect(screen.getByText('❌ CI failing: lint, test')).toBeDefined();
  });

  it('renders yellow CI running badge with spinner when mergeState is ci_running', () => {
    render(<CIBadges mergeState="ci_running" />);
    expect(screen.getByText('CI running')).toBeDefined();
    // spinner element should be present
    expect(document.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('does not render ⚠ CI unstable when mergeState is ci_running', () => {
    render(<CIBadges mergeState="ci_running" />);
    expect(screen.queryByText('⚠ CI unstable')).toBeNull();
  });

  it('does not render CI running badge when mergeState is unstable', () => {
    render(<CIBadges mergeState="unstable" />);
    expect(screen.queryByText('CI running')).toBeNull();
  });

  it('renders nothing for ci_running when prState is merged', () => {
    const { container } = render(
      <CIBadges mergeState="ci_running" prState="merged" />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('PipelineStageBadge', () => {
  it('renders running autofix badge', () => {
    render(<PipelineStageBadge stage="autofix" />);
    expect(screen.getByText(/Running autofix/)).toBeDefined();
  });

  it('renders running verify badge', () => {
    render(<PipelineStageBadge stage="verify" />);
    expect(screen.getByText(/Running verify/)).toBeDefined();
  });

  it('renders running tests badge', () => {
    render(<PipelineStageBadge stage="tests" />);
    expect(screen.getByText(/Running tests/)).toBeDefined();
  });

  it('renders awaiting review badge', () => {
    render(<PipelineStageBadge stage="awaiting_review" />);
    expect(screen.getByText(/Awaiting review/)).toBeDefined();
  });

  it('renders blocked by autofix gate badge', () => {
    render(<PipelineStageBadge stage="blocked_autofix" />);
    expect(screen.getByText(/Blocked by autofix gate/)).toBeDefined();
  });

  it('renders blocked by verify gate badge', () => {
    render(<PipelineStageBadge stage="blocked_verify" />);
    expect(screen.getByText(/Blocked by verify gate/)).toBeDefined();
  });

  it('renders compact label when compact=true', () => {
    render(<PipelineStageBadge stage="tests" compact />);
    expect(screen.getByText(/🧪 Tests/)).toBeDefined();
    expect(screen.queryByText(/Running tests/)).toBeNull();
  });

  it('renders nothing when stage is null', () => {
    const { container } = render(<PipelineStageBadge stage={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when prState is merged', () => {
    const { container } = render(
      <PipelineStageBadge stage="autofix" prState="merged" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when prState is closed', () => {
    const { container } = render(
      <PipelineStageBadge stage="tests" prState="closed" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders title with failedCommand for blocked stages', () => {
    render(
      <PipelineStageBadge
        stage="blocked_verify"
        failedCommand="npx tsc --noEmit"
      />,
    );
    const badge = screen.getByTitle(/npx tsc --noEmit/);
    expect(badge).toBeDefined();
  });

  it('shows spinner for running stages (autofix)', () => {
    render(<PipelineStageBadge stage="autofix" />);
    expect(document.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('does not show spinner for awaiting_review stage', () => {
    render(<PipelineStageBadge stage="awaiting_review" />);
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
  });
});
