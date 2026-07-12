import { describe, it, expect } from 'vitest';
import {
  detectSplitCandidate,
  confirmSplitCandidate,
  estimateLoc,
  SIZE_FLOOR_LOC,
} from '../splitCandidate';

describe('detectSplitCandidate', () => {
  it('is not a candidate when the estimate is under the size floor', () => {
    const result = detectSplitCandidate({ files: 2 }); // 2 * 75 = 150 LoC
    expect(result.isCandidate).toBe(false);
    expect(result.locEstimate).toBe(150);
    expect(result.floor).toBe(SIZE_FLOOR_LOC);
  });

  it('trips when the size floor is exceeded', () => {
    const result = detectSplitCandidate({ files: 10 }); // 10 * 75 = 750 LoC
    expect(result.isCandidate).toBe(true);
    expect(result.locEstimate).toBe(750);
  });

  it('respects an explicit locEstimate over the files-derived one', () => {
    const result = detectSplitCandidate({ files: 1, locEstimate: 900 });
    expect(result.locEstimate).toBe(900);
    expect(result.isCandidate).toBe(true);
  });

  it('does not trip exactly at the floor', () => {
    const result = detectSplitCandidate(
      { files: 1, locEstimate: SIZE_FLOOR_LOC },
      SIZE_FLOOR_LOC,
    );
    expect(result.isCandidate).toBe(false);
  });

  it('estimateLoc derives from files when no explicit estimate is given', () => {
    expect(estimateLoc({ files: 4 })).toBe(300);
  });
});

describe('confirmSplitCandidate', () => {
  it('does not confirm a non-candidate', () => {
    const candidate = detectSplitCandidate({ files: 1 });
    const result = confirmSplitCandidate(candidate);
    expect(result.confirmed).toBe(false);
  });

  it('auto-confirms well past the floor without an operator', () => {
    const candidate = detectSplitCandidate({ files: 1, locEstimate: 1200 }); // > 2x floor
    const result = confirmSplitCandidate(candidate);
    expect(result.confirmed).toBe(true);
    expect(result.reason).toMatch(/heuristic auto-confirm/);
  });

  it('requires operator approval just past the floor', () => {
    const candidate = detectSplitCandidate({ files: 1, locEstimate: 600 });
    expect(confirmSplitCandidate(candidate).confirmed).toBe(false);
    expect(
      confirmSplitCandidate(candidate, { operatorApproved: true }).confirmed,
    ).toBe(true);
  });
});
