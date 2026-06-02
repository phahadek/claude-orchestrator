import { describe, it, expect } from 'vitest';
import { isNewer, getCurrentVersion } from '../UpdateChecker.js';

describe('isNewer', () => {
  it('returns false when versions are identical', () => {
    expect(isNewer('1.4.0', '1.4.0')).toBe(false);
  });

  it('returns false when versions are identical with v prefix', () => {
    expect(isNewer('1.4.0', 'v1.4.0')).toBe(false);
  });

  it('returns true when candidate has a newer patch', () => {
    expect(isNewer('1.4.0', '1.4.1')).toBe(true);
  });

  it('returns false when candidate has an older minor', () => {
    expect(isNewer('1.4.0', '1.3.9')).toBe(false);
  });

  it('returns true when candidate has a newer minor', () => {
    expect(isNewer('1.4.0', '1.5.0')).toBe(true);
  });

  it('returns true when candidate has a newer major', () => {
    expect(isNewer('1.4.0', '2.0.0')).toBe(true);
  });

  it('returns false when candidate has an older major', () => {
    expect(isNewer('2.0.0', '1.9.9')).toBe(false);
  });
});

describe('getCurrentVersion', () => {
  it('returns a non-placeholder semver string', () => {
    const version = getCurrentVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(version).not.toBe('0.0.0');
  });

  it('matches the package.json version', () => {
     
    const pkg = require('../../../package.json') as { version: string };
    expect(getCurrentVersion()).toBe(pkg.version);
  });
});
