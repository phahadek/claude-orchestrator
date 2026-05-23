import { describe, it, expect } from 'vitest';
import { shouldAutoReview } from './reviewUtils';

describe('shouldAutoReview()', () => {
  const withCap = (
    reviewIteration: number,
    headSha: string | null,
    lastReviewedSha: string | null,
  ) => ({ reviewIteration, headSha, lastReviewedSha });

  it('returns false when reviewIteration >= maxIterations', () => {
    expect(shouldAutoReview(withCap(3, 'abc', null), 3)).toBe(false);
    expect(shouldAutoReview(withCap(4, 'abc', null), 3)).toBe(false);
    expect(shouldAutoReview(withCap(5, 'abc', null), 3)).toBe(false);
  });

  it('returns false when headSha is null', () => {
    expect(shouldAutoReview(withCap(0, null, null), 3)).toBe(false);
    expect(shouldAutoReview(withCap(1, null, 'old'), 3)).toBe(false);
  });

  it('returns false when headSha === lastReviewedSha (no new commits)', () => {
    expect(shouldAutoReview(withCap(0, 'abc123', 'abc123'), 3)).toBe(false);
    expect(shouldAutoReview(withCap(2, 'def456', 'def456'), 3)).toBe(false);
  });

  it('returns true when iteration below cap and new commits exist', () => {
    expect(shouldAutoReview(withCap(0, 'newsha', null), 3)).toBe(true);
    expect(shouldAutoReview(withCap(0, 'newsha', 'oldsha'), 3)).toBe(true);
    expect(shouldAutoReview(withCap(2, 'newsha', 'oldsha'), 3)).toBe(true);
  });

  it('returns true with iteration exactly one below the cap', () => {
    expect(shouldAutoReview(withCap(2, 'newsha', 'oldsha'), 3)).toBe(true);
  });

  it('handles maxIterations = 1 correctly', () => {
    expect(shouldAutoReview(withCap(0, 'newsha', 'oldsha'), 1)).toBe(true);
    expect(shouldAutoReview(withCap(1, 'newsha', 'oldsha'), 1)).toBe(false);
  });
});
