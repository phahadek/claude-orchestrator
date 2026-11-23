import { describe, it, expect } from 'vitest';
import { findHeadroomBreaches } from '../testRunMemoryHeadroom';

describe('findHeadroomBreaches', () => {
  it('returns [] for disabled cap, null/empty stats, and null peaks', () => {
    expect(findHeadroomBreaches([{ command: 'a', peakRssMb: 9999 }], 0)).toEqual(
      [],
    );
    expect(findHeadroomBreaches(null, 5120)).toEqual([]);
    expect(findHeadroomBreaches(undefined, 5120)).toEqual([]);
    expect(findHeadroomBreaches([], 5120)).toEqual([]);
    expect(findHeadroomBreaches([{ command: 'a', peakRssMb: null }], 5120)).toEqual(
      [],
    );
  });

  it('flags a peak above the default fraction and not one below', () => {
    const out = findHeadroomBreaches([{ command: 'a', peakRssMb: 4700 }], 5120);
    expect(out).toHaveLength(1);
    expect(out[0].command).toBe('a');
    expect(out[0].maxRssMb).toBe(5120);
    expect(out[0].fraction).toBeCloseTo(0.918, 3);
    expect(
      findHeadroomBreaches([{ command: 'a', peakRssMb: 4500 }], 5120),
    ).toEqual([]);
  });
});
