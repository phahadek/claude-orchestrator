import { describe, it, expect } from 'vitest';
import { isNewer, getCurrentVersion } from '../UpdateChecker.js';

describe('isNewer', () => {
  it('returns false when current equals candidate (same release — no spurious update)', () => {
    expect(isNewer('1.4.0', '1.4.0')).toBe(false);
    expect(isNewer('1.4.0', 'v1.4.0')).toBe(false);
  });

  it('returns true when candidate is a newer patch', () => {
    expect(isNewer('1.4.0', '1.4.1')).toBe(true);
    expect(isNewer('1.4.0', 'v1.4.1')).toBe(true);
  });

  it('returns false when candidate is an older version', () => {
    expect(isNewer('1.4.0', '1.3.9')).toBe(false);
    expect(isNewer('1.4.0', 'v1.3.9')).toBe(false);
  });

  it('returns true when candidate is a newer minor', () => {
    expect(isNewer('1.4.0', '1.5.0')).toBe(true);
  });

  it('returns true when candidate is a newer major', () => {
    expect(isNewer('1.4.0', '2.0.0')).toBe(true);
  });
});

describe('getCurrentVersion', () => {
  it('returns a non-placeholder semver string matching package.json', () => {
    const version = getCurrentVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(version).not.toBe('0.0.0');
    expect(version).not.toBe('');
  });
});
