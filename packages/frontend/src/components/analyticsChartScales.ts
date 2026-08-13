// Domain helpers for the token-consumption-over-time chart's two Y axes.
//
// Cost and token count are NOT proportional — per-model pricing differs up
// to ~8x, input/output differ up to ~5x within one model, and cache tokens
// have their own sub-tier rates — so the token axis must never be derived
// from the cost axis (or vice versa) via a fixed ratio. Each domain function
// below reads only its own field from the bucket data, independently of the
// other, so the two axes scale to their own data range.

export interface TokenBucket {
  bucketStart: number;
  totalTokens: number;
  totalCost: number;
}

export function costAxisDomain(buckets: TokenBucket[]): [number, number] {
  const max = buckets.reduce((m, b) => Math.max(m, b.totalCost), 0);
  return [0, max === 0 ? 1 : max * 1.1];
}

export function tokenAxisDomain(buckets: TokenBucket[]): [number, number] {
  const max = buckets.reduce((m, b) => Math.max(m, b.totalTokens), 0);
  return [0, max === 0 ? 1 : max * 1.1];
}
