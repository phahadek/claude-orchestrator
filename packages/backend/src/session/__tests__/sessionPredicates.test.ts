import { describe, it, expect } from 'vitest';
import {
  countsAgainstConcurrency,
  isCodeSession,
  isPlanningSession,
  movesTargetInProgress,
  opensPr,
  writesTaskStatus,
} from '../sessionPredicates';

describe('sessionPredicates', () => {
  it('isCodeSession is true only for standard', () => {
    expect(isCodeSession('standard')).toBe(true);
    expect(isCodeSession('review')).toBe(false);
    expect(isCodeSession('groom')).toBe(false);
    expect(isCodeSession('design')).toBe(false);
    expect(isCodeSession('ops')).toBe(false);
  });

  it('opensPr is true only for standard', () => {
    expect(opensPr('standard')).toBe(true);
    expect(opensPr('review')).toBe(false);
    expect(opensPr('groom')).toBe(false);
    expect(opensPr('design')).toBe(false);
    expect(opensPr('ops')).toBe(false);
  });

  it('countsAgainstConcurrency is true for everything but review', () => {
    expect(countsAgainstConcurrency('standard')).toBe(true);
    expect(countsAgainstConcurrency('review')).toBe(false);
    expect(countsAgainstConcurrency('groom')).toBe(true);
    expect(countsAgainstConcurrency('design')).toBe(true);
    expect(countsAgainstConcurrency('ops')).toBe(true);
  });

  it('writesTaskStatus is true only for standard', () => {
    expect(writesTaskStatus('standard')).toBe(true);
    expect(writesTaskStatus('review')).toBe(false);
    expect(writesTaskStatus('groom')).toBe(false);
    expect(writesTaskStatus('design')).toBe(false);
    expect(writesTaskStatus('ops')).toBe(false);
  });

  it('movesTargetInProgress is true for standard and design, false for review, groom and ops', () => {
    expect(movesTargetInProgress('standard')).toBe(true);
    expect(movesTargetInProgress('review')).toBe(false);
    expect(movesTargetInProgress('groom')).toBe(false);
    expect(movesTargetInProgress('design')).toBe(true);
    expect(movesTargetInProgress('ops')).toBe(false);
  });

  it('isPlanningSession is true for groom, design and ops', () => {
    expect(isPlanningSession('standard')).toBe(false);
    expect(isPlanningSession('review')).toBe(false);
    expect(isPlanningSession('groom')).toBe(true);
    expect(isPlanningSession('design')).toBe(true);
    expect(isPlanningSession('ops')).toBe(true);
  });
});
