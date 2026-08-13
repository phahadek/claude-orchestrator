import { describe, it, expect } from 'vitest';
import {
  costAxisDomain,
  tokenAxisDomain,
  type TokenBucket,
} from '../analyticsChartScales';

describe('analytics chart axis scales', () => {
  // Mixed model mix: cheap-per-token bucket has the most tokens but not the
  // most cost, and vice versa — a fixed cost->token ratio would get this
  // backwards, so the two axes must be computed independently.
  const buckets: TokenBucket[] = [
    { bucketStart: 1, totalTokens: 100_000, totalCost: 1 }, // cheap model, huge token count
    { bucketStart: 2, totalTokens: 10_000, totalCost: 50 }, // expensive model, few tokens
  ];

  it('computes the token axis domain from totalTokens alone', () => {
    const [min, max] = tokenAxisDomain(buckets);
    expect(min).toBe(0);
    expect(max).toBeCloseTo(100_000 * 1.1);
  });

  it('computes the cost axis domain from totalCost alone', () => {
    const [min, max] = costAxisDomain(buckets);
    expect(min).toBe(0);
    expect(max).toBeCloseTo(50 * 1.1);
  });

  it('does not derive the token axis from the cost axis by a fixed ratio', () => {
    const [, costMax] = costAxisDomain(buckets);
    const [, tokenMax] = tokenAxisDomain(buckets);
    // If the token axis were wrongly derived as `costMax * constant`, the
    // bucket with the highest cost (bucket 2, cost=50) would also have to
    // be the bucket with the highest tokens — it isn't (bucket 1 has 10x
    // the tokens with 1/50th the cost).
    const highestCostBucket = buckets.reduce((a, b) =>
      b.totalCost > a.totalCost ? b : a,
    );
    const highestTokenBucket = buckets.reduce((a, b) =>
      b.totalTokens > a.totalTokens ? b : a,
    );
    expect(highestCostBucket.bucketStart).not.toBe(
      highestTokenBucket.bucketStart,
    );
    expect(costMax).not.toBeCloseTo(tokenMax);
  });

  it('returns a non-zero domain for an empty bucket list', () => {
    expect(tokenAxisDomain([])).toEqual([0, 1]);
    expect(costAxisDomain([])).toEqual([0, 1]);
  });
});
