import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ContextBadge } from '../ContextBadge';

describe('ContextBadge', () => {
  it('renders the correct percentage for given occupancy tokens', () => {
    render(
      <ContextBadge contextOccupancyTokens={50_000} compactionCount={0} />,
    );
    expect(screen.getByText('25% ctx')).toBeDefined();
  });

  it('renders nothing when contextOccupancyTokens is undefined', () => {
    const { container } = render(
      <ContextBadge contextOccupancyTokens={undefined} compactionCount={0} />,
    );
    expect(container.textContent).toBe('');
  });

  it('renders compacted badge when compaction_count > 0', () => {
    render(
      <ContextBadge contextOccupancyTokens={50_000} compactionCount={3} />,
    );
    expect(screen.getByText('compacted 3×')).toBeDefined();
  });

  it('does not render compacted badge when compaction_count is 0', () => {
    render(
      <ContextBadge contextOccupancyTokens={50_000} compactionCount={0} />,
    );
    expect(screen.queryByText(/compacted/)).toBeNull();
  });

  it('does not render compacted badge when compaction_count is undefined', () => {
    render(
      <ContextBadge
        contextOccupancyTokens={50_000}
        compactionCount={undefined}
      />,
    );
    expect(screen.queryByText(/compacted/)).toBeNull();
  });

  it('caps displayed percentage at 100% when tokens exceed context window', () => {
    render(
      <ContextBadge contextOccupancyTokens={250_000} compactionCount={0} />,
    );
    expect(screen.getByText('125% ctx')).toBeDefined();
  });

  it('renders correct title attribute with token count', () => {
    render(
      <ContextBadge contextOccupancyTokens={100_000} compactionCount={0} />,
    );
    const badge = screen.getByTitle('100,000 of 200,000 tokens');
    expect(badge).toBeDefined();
  });

  it('uses 1M window when model contains [1m]', () => {
    render(
      <ContextBadge
        contextOccupancyTokens={500_000}
        compactionCount={0}
        model="claude-opus-4-7[1m]"
      />,
    );
    expect(screen.getByText('50% ctx')).toBeDefined();
  });

  it('uses 200k window when model does not contain [1m]', () => {
    render(
      <ContextBadge
        contextOccupancyTokens={100_000}
        compactionCount={0}
        model="claude-sonnet-4-6"
      />,
    );
    expect(screen.getByText('50% ctx')).toBeDefined();
  });

  it('uses 200k window when model is null', () => {
    render(
      <ContextBadge
        contextOccupancyTokens={100_000}
        compactionCount={0}
        model={null}
      />,
    );
    expect(screen.getByText('50% ctx')).toBeDefined();
  });

  it('renders correct title with 1M window for [1m] model', () => {
    render(
      <ContextBadge
        contextOccupancyTokens={500_000}
        compactionCount={0}
        model="claude-opus-4-7[1m]"
      />,
    );
    const badge = screen.getByTitle('500,000 of 1,000,000 tokens');
    expect(badge).toBeDefined();
  });
});
