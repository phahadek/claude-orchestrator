import { describe, it, expect } from 'vitest';
import {
  countsAgainstConcurrency,
  isCodeSession,
  isGateVerifySession,
  isInvestigateSession,
  isMachineParkedIdle,
  isPlanningSession,
  isTaskTypeCompatibleWithSessionType,
  movesTargetInProgress,
  opensPr,
  PLANNING_SESSION_TYPES,
  usesWorktree,
  writesTaskStatus,
  type SessionType,
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

  it('usesWorktree for docs is Target-surface-aware: repo-file gets a worktree, Notion-page/undeclared does not', () => {
    expect(usesWorktree('docs', 'docs/api/webhooks.md')).toBe(true);
    expect(usesWorktree('docs', 'packages/backend/README.md')).toBe(true);
    expect(usesWorktree('docs', '20a1b2c3-d4e5-4f60-8a1b-2c3d4e5f6071')).toBe(
      false,
    );
    expect(
      usesWorktree(
        'docs',
        'https://www.notion.so/My-Page-20a1b2c3d4e54f608a1b2c3d4e5f6071',
      ),
    ).toBe(false);
    expect(usesWorktree('docs', '')).toBe(false);
    expect(usesWorktree('docs')).toBe(false);
    // Non-docs types are unaffected by a docsTargetSurface argument.
    expect(usesWorktree('groom', 'docs/api/webhooks.md')).toBe(false);
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

  it('isPlanningSession is true for split', () => {
    expect(isPlanningSession('split')).toBe(true);
  });

  it('isPlanningSession and PLANNING_SESSION_TYPES agree for every SessionType member', () => {
    const ALL_SESSION_TYPES: SessionType[] = [
      'standard',
      'review',
      'groom',
      'design',
      'ops',
      'split',
      'docs',
      'depth_review',
    ];
    for (const type of ALL_SESSION_TYPES) {
      expect(isPlanningSession(type)).toBe(
        (PLANNING_SESSION_TYPES as readonly string[]).includes(type),
      );
    }
  });

  it('isGateVerifySession is true only for a gate-item: taskId', () => {
    expect(isGateVerifySession('gate-item:abc123')).toBe(true);
    expect(isGateVerifySession('report-batch:abc123')).toBe(false);
    expect(isGateVerifySession('report:abc123')).toBe(false);
    expect(isGateVerifySession(null)).toBe(false);
    expect(isGateVerifySession(undefined)).toBe(false);
  });

  it('isInvestigateSession is true only for a report-batch: taskId', () => {
    expect(isInvestigateSession('report-batch:abc123')).toBe(true);
    expect(isInvestigateSession('gate-item:abc123')).toBe(false);
    expect(isInvestigateSession('report:abc123')).toBe(false);
    expect(isInvestigateSession(null)).toBe(false);
    expect(isInvestigateSession(undefined)).toBe(false);
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

  describe('isMachineParkedIdle', () => {
    it('is true only for archived=1 with archive_kind="machine_park"', () => {
      expect(
        isMachineParkedIdle({ archived: 1, archive_kind: 'machine_park' }),
      ).toBe(true);
    });

    it('is false for archived=1 with archive_kind="operator"', () => {
      expect(
        isMachineParkedIdle({ archived: 1, archive_kind: 'operator' }),
      ).toBe(false);
    });

    it('fails closed for archived=1 with legacy archive_kind NULL', () => {
      expect(isMachineParkedIdle({ archived: 1, archive_kind: null })).toBe(
        false,
      );
    });

    it('is false when not archived, regardless of archive_kind', () => {
      expect(
        isMachineParkedIdle({ archived: 0, archive_kind: 'machine_park' }),
      ).toBe(false);
      expect(isMachineParkedIdle({ archived: 0, archive_kind: null })).toBe(
        false,
      );
    });
  });
});
