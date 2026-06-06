import { describe, it, expect, vi } from 'vitest';
import { runWithConcurrency } from '../concurrency.js';

describe('runWithConcurrency', () => {
  it('returns empty array for empty input without calling fn', async () => {
    const fn = vi.fn();
    const results = await runWithConcurrency([], 3, fn);
    expect(results).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns empty array when concurrency is 0', async () => {
    const fn = vi.fn().mockResolvedValue(1);
    const results = await runWithConcurrency([1, 2, 3], 0, fn);
    expect(results).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('processes all items and returns results in original order', async () => {
    const results = await runWithConcurrency(
      [1, 2, 3, 4, 5],
      3,
      async (x) => x * 2,
    );
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it('respects concurrency cap', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const fn = async (x: number): Promise<number> => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      concurrent--;
      return x;
    };

    const results = await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, fn);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(maxConcurrent).toBeGreaterThan(0);
    expect(results).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('propagates throws from fn', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(runWithConcurrency([1], 2, fn)).rejects.toThrow('boom');
  });

  it('works with concurrency=1 (serial)', async () => {
    const order: number[] = [];
    const fn = async (x: number): Promise<number> => {
      order.push(x);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      return x;
    };

    const results = await runWithConcurrency([1, 2, 3], 1, fn);
    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('works when concurrency exceeds items.length', async () => {
    const results = await runWithConcurrency([10, 20], 10, async (x) => x + 1);
    expect(results).toEqual([11, 21]);
  });

  it('handles a single item', async () => {
    const results = await runWithConcurrency(['only'], 5, async (s) =>
      s.toUpperCase(),
    );
    expect(results).toEqual(['ONLY']);
  });
});
