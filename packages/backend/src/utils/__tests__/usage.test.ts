import { describe, it, expect } from 'vitest';
import {
  calculateCost,
  categoryForSessionType,
  SESSION_TYPE_CATEGORIES,
} from '../usage';

describe('calculateCost', () => {
  it('prices cache_read/cache_creation tokens on their own tier, distinct from input/output', () => {
    const base = calculateCost(1000, 1000, 'claude-sonnet-4-6');
    const withCache = calculateCost(
      1000,
      1000,
      'claude-sonnet-4-6',
      1000,
      1000,
    );
    expect(withCache).toBeGreaterThan(base);
  });

  it('prices cache reads cheaper than cache writes for the same token count', () => {
    const readOnly = calculateCost(0, 0, 'claude-sonnet-4-6', 1000, 0);
    const writeOnly = calculateCost(0, 0, 'claude-sonnet-4-6', 0, 1000);
    expect(readOnly).toBeGreaterThan(0);
    expect(writeOnly).toBeGreaterThan(readOnly);
  });

  it('defaults cache tokens to 0 when omitted', () => {
    expect(calculateCost(1000, 500, 'claude-sonnet-4-6')).toBe(
      calculateCost(1000, 500, 'claude-sonnet-4-6', 0, 0),
    );
  });
});

describe('SESSION_TYPE_CATEGORIES / categoryForSessionType', () => {
  it('categorizes planning session types', () => {
    for (const t of SESSION_TYPE_CATEGORIES.planning) {
      expect(categoryForSessionType(t)).toBe('planning');
    }
  });

  it('categorizes execution session types', () => {
    for (const t of SESSION_TYPE_CATEGORIES.execution) {
      expect(categoryForSessionType(t)).toBe('execution');
    }
  });

  it('defaults unknown session types to execution', () => {
    expect(categoryForSessionType('some-future-type')).toBe('execution');
  });
});
