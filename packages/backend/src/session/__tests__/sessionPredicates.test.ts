import { describe, it, expect } from 'vitest';
import {
  countsAgainstConcurrency,
  isCodeSession,
  isPlanningSession,
  movesTargetInProgress,
  opensPr,
  usesWorktree,
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

  it('opensPr is true for standard, docs, and ops', () => {
    expect(opensPr('standard')).toBe(true);
    expect(opensPr('docs')).toBe(true);
    expect(opensPr('ops')).toBe(true);
    expect(opensPr('review')).toBe(false);
    expect(opensPr('groom')).toBe(false);
    expect(opensPr('design')).toBe(false);
  });

  it('usesWorktree is true only for standard and ops', () => {
    expect(usesWorktree('standard')).toBe(true);
    expect(usesWorktree('ops')).toBe(true);
    expect(usesWorktree('review')).toBe(false);
    expect(usesWorktree('groom')).toBe(false);
    expect(usesWorktree('design')).toBe(false);
    expect(usesWorktree('split')).toBe(false);
    expect(usesWorktree('docs')).toBe(false);
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

  it('movesTargetInProgress is true for standard, design, ops and docs, false for review and groom', () => {
    expect(movesTargetInProgress('standard')).toBe(true);
    expect(movesTargetInProgress('review')).toBe(false);
    expect(movesTargetInProgress('groom')).toBe(false);
    expect(movesTargetInProgress('design')).toBe(true);
    expect(movesTargetInProgress('ops')).toBe(true);
    expect(movesTargetInProgress('docs')).toBe(true);
  });

  it('isPlanningSession is true for groom, design, ops and docs', () => {
    expect(isPlanningSession('standard')).toBe(false);
    expect(isPlanningSession('review')).toBe(false);
    expect(isPlanningSession('groom')).toBe(true);
    expect(isPlanningSession('design')).toBe(true);
    expect(isPlanningSession('ops')).toBe(true);
    expect(isPlanningSession('docs')).toBe(true);
  });

  it('isCodeSession is false for docs', () => {
    expect(isCodeSession('docs')).toBe(false);
  });
});
