import { describe, it, expect } from 'vitest';
import {
  countsAgainstConcurrency,
  isCodeSession,
  isPlanningSession,
  isTaskTypeCompatibleWithSessionType,
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

  describe('isTaskTypeCompatibleWithSessionType', () => {
    it('standard is compatible only with 💻 Code', () => {
      expect(isTaskTypeCompatibleWithSessionType('💻 Code', 'standard')).toBe(
        true,
      );
      expect(isTaskTypeCompatibleWithSessionType('📐 Design', 'standard')).toBe(
        false,
      );
      expect(
        isTaskTypeCompatibleWithSessionType('📋 Planning', 'standard'),
      ).toBe(false);
      expect(
        isTaskTypeCompatibleWithSessionType('🔧 Operational', 'standard'),
      ).toBe(false);
      expect(
        isTaskTypeCompatibleWithSessionType('🔎 Investigation', 'standard'),
      ).toBe(false);
      expect(
        isTaskTypeCompatibleWithSessionType('🧪 Testing', 'standard'),
      ).toBe(false);
      expect(isTaskTypeCompatibleWithSessionType('📝 Docs', 'standard')).toBe(
        false,
      );
      expect(isTaskTypeCompatibleWithSessionType('🎨 Assets', 'standard')).toBe(
        false,
      );
    });

    it('design is compatible only with 📐 Design / 📋 Planning', () => {
      expect(isTaskTypeCompatibleWithSessionType('📐 Design', 'design')).toBe(
        true,
      );
      expect(isTaskTypeCompatibleWithSessionType('📋 Planning', 'design')).toBe(
        true,
      );
      expect(isTaskTypeCompatibleWithSessionType('💻 Code', 'design')).toBe(
        false,
      );
      expect(
        isTaskTypeCompatibleWithSessionType('🔧 Operational', 'design'),
      ).toBe(false);
      expect(
        isTaskTypeCompatibleWithSessionType('🔎 Investigation', 'design'),
      ).toBe(false);
      expect(isTaskTypeCompatibleWithSessionType('🧪 Testing', 'design')).toBe(
        false,
      );
      expect(isTaskTypeCompatibleWithSessionType('📝 Docs', 'design')).toBe(
        false,
      );
      expect(isTaskTypeCompatibleWithSessionType('🎨 Assets', 'design')).toBe(
        false,
      );
    });

    it('ops is compatible with 🔧 Operational / 🔎 Investigation / 🧪 Testing', () => {
      expect(isTaskTypeCompatibleWithSessionType('🔧 Operational', 'ops')).toBe(
        true,
      );
      expect(
        isTaskTypeCompatibleWithSessionType('🔎 Investigation', 'ops'),
      ).toBe(true);
      expect(isTaskTypeCompatibleWithSessionType('🧪 Testing', 'ops')).toBe(
        true,
      );
      expect(isTaskTypeCompatibleWithSessionType('💻 Code', 'ops')).toBe(false);
      expect(isTaskTypeCompatibleWithSessionType('📐 Design', 'ops')).toBe(
        false,
      );
      expect(isTaskTypeCompatibleWithSessionType('📋 Planning', 'ops')).toBe(
        false,
      );
      expect(isTaskTypeCompatibleWithSessionType('📝 Docs', 'ops')).toBe(false);
      expect(isTaskTypeCompatibleWithSessionType('🎨 Assets', 'ops')).toBe(
        false,
      );
    });

    it('docs is compatible only with 📝 Docs / 🎨 Assets', () => {
      expect(isTaskTypeCompatibleWithSessionType('📝 Docs', 'docs')).toBe(true);
      expect(isTaskTypeCompatibleWithSessionType('🎨 Assets', 'docs')).toBe(
        true,
      );
      expect(isTaskTypeCompatibleWithSessionType('💻 Code', 'docs')).toBe(
        false,
      );
      expect(isTaskTypeCompatibleWithSessionType('📐 Design', 'docs')).toBe(
        false,
      );
      expect(isTaskTypeCompatibleWithSessionType('📋 Planning', 'docs')).toBe(
        false,
      );
      expect(
        isTaskTypeCompatibleWithSessionType('🔧 Operational', 'docs'),
      ).toBe(false);
      expect(
        isTaskTypeCompatibleWithSessionType('🔎 Investigation', 'docs'),
      ).toBe(false);
      expect(isTaskTypeCompatibleWithSessionType('🧪 Testing', 'docs')).toBe(
        false,
      );
    });

    it('groom, review, depth_review, and split are type-agnostic', () => {
      const types = [
        '💻 Code',
        '📐 Design',
        '📋 Planning',
        '🔧 Operational',
        '🔎 Investigation',
        '🧪 Testing',
        '📝 Docs',
        '🎨 Assets',
      ];
      for (const type of types) {
        expect(isTaskTypeCompatibleWithSessionType(type, 'groom')).toBe(true);
        expect(isTaskTypeCompatibleWithSessionType(type, 'review')).toBe(true);
        expect(isTaskTypeCompatibleWithSessionType(type, 'depth_review')).toBe(
          true,
        );
        expect(isTaskTypeCompatibleWithSessionType(type, 'split')).toBe(true);
      }
    });

    it('returns false for an unrecognized sessionType', () => {
      expect(isTaskTypeCompatibleWithSessionType('💻 Code', 'bogus')).toBe(
        false,
      );
    });
  });
});
