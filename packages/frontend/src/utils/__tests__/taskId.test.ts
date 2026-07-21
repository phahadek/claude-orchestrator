// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { bareTaskId } from '../taskId';

describe('bareTaskId', () => {
  it('strips a leading source: prefix', () => {
    expect(bareTaskId('notion:abc')).toBe('abc');
  });

  it('returns bare ids unchanged', () => {
    expect(bareTaskId('abc')).toBe('abc');
  });

  it('leaves an unrecognized prefix untouched', () => {
    expect(bareTaskId('unknown:abc')).toBe('unknown:abc');
  });
});
