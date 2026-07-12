import { describe, it, expect } from 'vitest';
import { checkGroomingPromotionGate } from '../groomGate';

describe('checkGroomingPromotionGate', () => {
  it('rejects a Ready flip whose type_check is absent', () => {
    const result = checkGroomingPromotionGate({
      size_check: { decision: 'n/a' },
      type_check: null,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('type_check'))).toBe(true);
  });

  it('rejects a Ready flip whose type_check is flagged but undispositioned', () => {
    const result = checkGroomingPromotionGate({
      size_check: { decision: 'n/a' },
      type_check: { decision: 'flagged', signals: ['api key'] },
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('type_check'))).toBe(true);
  });

  it('accepts a Ready flip with type_check {decision: "none"}', () => {
    const result = checkGroomingPromotionGate({
      size_check: { decision: 'n/a' },
      type_check: { decision: 'none' },
    });
    expect(result.allowed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('accepts a Ready flip with a recorded disposition for a flagged type_check', () => {
    const result = checkGroomingPromotionGate({
      size_check: { decision: 'no_split' },
      type_check: {
        decision: 'flagged',
        signals: ['api key'],
        disposition: 'split-filed:38b22f91-52f3-8146',
      },
    });
    expect(result.allowed).toBe(true);
  });

  it('still rejects when size_check is missing, independent of type_check', () => {
    const result = checkGroomingPromotionGate({
      size_check: null,
      type_check: { decision: 'none' },
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('size_check'))).toBe(true);
  });
});
