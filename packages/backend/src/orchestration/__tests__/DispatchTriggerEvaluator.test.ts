import { describe, it, expect } from 'vitest';
import {
  computeAvailableCapacity,
  rotateFromIndex,
} from '../DispatchTriggerEvaluator';

describe('computeAvailableCapacity', () => {
  it('dispatches at most cap - humanReserve - active and leaves the reserve', () => {
    const available = computeAvailableCapacity({
      maxConcurrentPlanningSessions: 5,
      humanReserve: 1,
      activePlanningSessions: 2,
    });
    expect(available).toBe(2); // 5 - 1 - 2

    // Dispatching `available` more sessions lands exactly at cap - humanReserve,
    // leaving the reserve slot untouched.
    const afterDispatch = computeAvailableCapacity({
      maxConcurrentPlanningSessions: 5,
      humanReserve: 1,
      activePlanningSessions: 2 + available,
    });
    expect(afterDispatch).toBe(0);
  });

  it('never goes negative when active + humanReserve exceeds the cap', () => {
    const available = computeAvailableCapacity({
      maxConcurrentPlanningSessions: 5,
      humanReserve: 1,
      activePlanningSessions: 10,
    });
    expect(available).toBe(0);
  });

  it('is zero when the reserve alone consumes the whole cap', () => {
    const available = computeAvailableCapacity({
      maxConcurrentPlanningSessions: 1,
      humanReserve: 1,
      activePlanningSessions: 0,
    });
    expect(available).toBe(0);
  });
});

describe('rotateFromIndex', () => {
  it('rotates the start project across successive indices (round-robin fairness)', () => {
    const projects = ['a', 'b', 'c'];
    expect(rotateFromIndex(projects, 0)).toEqual(['a', 'b', 'c']);
    expect(rotateFromIndex(projects, 1)).toEqual(['b', 'c', 'a']);
    expect(rotateFromIndex(projects, 2)).toEqual(['c', 'a', 'b']);
    // Wraps back around.
    expect(rotateFromIndex(projects, 3)).toEqual(['a', 'b', 'c']);
  });

  it('handles an empty list', () => {
    expect(rotateFromIndex([], 5)).toEqual([]);
  });
});
