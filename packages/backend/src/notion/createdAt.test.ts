import { describe, it, expect } from 'vitest';
import { parseCreatedAt } from './types';

describe('parseCreatedAt', () => {
  it('converts an ISO string to epoch ms', () => {
    expect(parseCreatedAt('2024-05-01T12:00:00.000Z')).toBe(
      Date.UTC(2024, 4, 1, 12),
    );
  });

  it('accepts Jira-style offsets', () => {
    expect(parseCreatedAt('2024-05-01T12:00:00.000+0000')).toBe(
      Date.UTC(2024, 4, 1, 12),
    );
  });

  it('accepts a Date (js-yaml timestamps)', () => {
    const d = new Date('2024-05-01T12:00:00Z');
    expect(parseCreatedAt(d)).toBe(d.getTime());
  });

  it('leaves absent or invalid values undefined', () => {
    expect(parseCreatedAt(undefined)).toBeUndefined();
    expect(parseCreatedAt(null)).toBeUndefined();
    expect(parseCreatedAt('not a date')).toBeUndefined();
  });
});
