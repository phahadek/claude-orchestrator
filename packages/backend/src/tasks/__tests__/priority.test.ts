import { describe, it, expect } from 'vitest';
import { normalizePriority, priorityLevelRank } from '../priority';

describe('normalizePriority', () => {
  it.each([
    ['🔴 Critical', 'critical'],
    ['🔴 High', 'high'],
    ['🟠 High', 'high'],
    ['🟡 Medium', 'medium'],
    ['🟢 Low', 'low'],
    ['', null],
    [undefined, null],
    ['P2', null],
  ] as const)('maps %s to %s', (raw, level) => {
    expect(normalizePriority(raw)).toBe(level);
  });

  it('ranks critical < high < medium < low < unset', () => {
    const ranks = (['critical', 'high', 'medium', 'low', null] as const).map(
      priorityLevelRank,
    );
    expect(ranks).toEqual([0, 1, 2, 3, 4]);
  });
});
