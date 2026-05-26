import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

const { mockRuntimeSettings, mockGetMilestone } = vi.hoisted(() => ({
  mockRuntimeSettings: { corporate_mode_enabled: false },
  mockGetMilestone: vi.fn(),
}));

vi.mock('../config.js', () => ({
  runtimeSettings: mockRuntimeSettings,
}));

vi.mock('../projects/ProjectService.js', () => ({
  ProjectService: {
    getMilestone: mockGetMilestone,
  },
}));

import {
  slugify,
  resolveBranchMode,
  resolveStartingPoint,
  ensureMilestoneBranch,
  getCorporateMode,
} from '../session/branchModel.js';

// ── slugify ────────────────────────────────────────────────────────────────────

describe('slugify', () => {
  it('lowercases and replaces non-alphanumeric with hyphens', () => {
    expect(slugify('M6 — Enterprise Adoption Readiness')).toBe(
      'm6-enterprise-adoption-readiness',
    );
  });

  it('strips leading and trailing hyphens', () => {
    expect(slugify('---Hello World---')).toBe('hello-world');
  });

  it('collapses multiple separators', () => {
    expect(slugify('Foo   Bar!!Baz')).toBe('foo-bar-baz');
  });
});

// ── resolveBranchMode ─────────────────────────────────────────────────────────

describe('resolveBranchMode', () => {
  beforeEach(() => {
    mockRuntimeSettings.corporate_mode_enabled = false;
  });

  it('returns two_tier when project explicitly sets two_tier', () => {
    expect(resolveBranchMode('two_tier')).toBe('two_tier');
  });

  it('returns flat when project explicitly sets flat', () => {
    expect(resolveBranchMode('flat')).toBe('flat');
  });

  it('returns flat when no setting (null) and corporate mode is off', () => {
    expect(resolveBranchMode(null)).toBe('flat');
  });

  it('returns flat when no setting (undefined) and corporate mode is off', () => {
    expect(resolveBranchMode(undefined)).toBe('flat');
  });

  it('returns two_tier when no setting and corporate mode is on', () => {
    mockRuntimeSettings.corporate_mode_enabled = true;
    expect(resolveBranchMode(null)).toBe('two_tier');
  });

  it('explicit project setting wins over corporate mode', () => {
    mockRuntimeSettings.corporate_mode_enabled = true;
    expect(resolveBranchMode('flat')).toBe('flat');
  });
});

// ── resolveStartingPoint ──────────────────────────────────────────────────────

describe('resolveStartingPoint', () => {
  beforeEach(() => {
    mockRuntimeSettings.corporate_mode_enabled = false;
    mockGetMilestone.mockReset();
  });

  it('returns feature/<slug> for milestone task + two_tier mode', () => {
    mockGetMilestone.mockReturnValue({
      id: 'ms-1',
      name: 'M6 — Enterprise Readiness',
    });
    const result = resolveStartingPoint(
      { milestoneBranching: 'two_tier' },
      'ms-1',
    );
    expect(result.startingPoint).toBe('feature/m6-enterprise-readiness');
    expect(result.milestoneSlug).toBe('m6-enterprise-readiness');
  });

  it('returns dev for milestone task + flat mode', () => {
    mockGetMilestone.mockReturnValue({ id: 'ms-1', name: 'M6' });
    const result = resolveStartingPoint({ milestoneBranching: 'flat' }, 'ms-1');
    expect(result.startingPoint).toBe('dev');
    expect(result.milestoneSlug).toBeNull();
  });

  it('returns dev for non-milestone task regardless of mode', () => {
    const resultTwoTier = resolveStartingPoint(
      { milestoneBranching: 'two_tier' },
      null,
    );
    expect(resultTwoTier.startingPoint).toBe('dev');
    expect(resultTwoTier.milestoneSlug).toBeNull();

    const resultFlat = resolveStartingPoint(
      { milestoneBranching: 'flat' },
      null,
    );
    expect(resultFlat.startingPoint).toBe('dev');
  });

  it('explicit project setting wins over corporate-mode default', () => {
    mockRuntimeSettings.corporate_mode_enabled = true;
    mockGetMilestone.mockReturnValue({ id: 'ms-1', name: 'M6' });
    // Project explicitly sets flat → should stay flat even with corporate mode on
    const result = resolveStartingPoint({ milestoneBranching: 'flat' }, 'ms-1');
    expect(result.startingPoint).toBe('dev');
  });

  it('falls back to dev when milestone is not found', () => {
    mockGetMilestone.mockReturnValue(undefined);
    const result = resolveStartingPoint(
      { milestoneBranching: 'two_tier' },
      'ms-unknown',
    );
    expect(result.startingPoint).toBe('dev');
    expect(result.milestoneSlug).toBeNull();
  });
});

// ── ensureMilestoneBranch ─────────────────────────────────────────────────────

describe('ensureMilestoneBranch', () => {
  const execSyncMock = execSync as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    execSyncMock.mockReset();
  });

  it('no-ops when branch already exists locally', () => {
    // git rev-parse --verify feature/<slug> succeeds → branch exists
    execSyncMock.mockReturnValueOnce('');

    ensureMilestoneBranch('m6-readiness', '/repo');

    // Only one call: the local ref check
    expect(execSyncMock).toHaveBeenCalledTimes(1);
    expect(execSyncMock).toHaveBeenCalledWith(
      'git rev-parse --verify feature/m6-readiness',
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('creates feature/<slug> from origin/dev when missing, and pushes', () => {
    // 1st call: local ref check → throws (not found)
    // 2nd call: git fetch origin dev → ok
    // 3rd call: origin ref check → throws (not on origin)
    // 4th call: git branch from origin/dev
    // 5th call: git push
    execSyncMock
      .mockImplementationOnce(() => {
        throw new Error('not found');
      })
      .mockReturnValueOnce('') // fetch
      .mockImplementationOnce(() => {
        throw new Error('not on origin');
      })
      .mockReturnValueOnce('') // git branch
      .mockReturnValueOnce(''); // git push

    ensureMilestoneBranch('m6-readiness', '/repo');

    expect(execSyncMock).toHaveBeenCalledWith(
      'git branch feature/m6-readiness origin/dev',
      expect.objectContaining({ cwd: '/repo' }),
    );
    expect(execSyncMock).toHaveBeenCalledWith(
      'git push origin feature/m6-readiness',
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('creates local tracking branch when branch exists on origin but not locally', () => {
    // 1st call: local ref check → throws
    // 2nd call: git fetch → ok
    // 3rd call: origin ref check → ok (exists on origin)
    // 4th call: git branch (local tracking)
    execSyncMock
      .mockImplementationOnce(() => {
        throw new Error('not found');
      })
      .mockReturnValueOnce('') // fetch
      .mockReturnValueOnce('') // origin ref check succeeds
      .mockReturnValueOnce(''); // git branch

    ensureMilestoneBranch('m6-readiness', '/repo');

    expect(execSyncMock).toHaveBeenCalledWith(
      'git branch feature/m6-readiness origin/feature/m6-readiness',
      expect.objectContaining({ cwd: '/repo' }),
    );
    // No push — branch already on origin
    expect(execSyncMock).not.toHaveBeenCalledWith(
      expect.stringContaining('git push'),
      expect.anything(),
    );
  });
});

// ── SessionManager structural checks ─────────────────────────────────────────

import * as fs from 'fs';
import * as path from 'path';

describe('SessionManager — detached worktree branch model', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('does not create session/<UUID> branches in start()', () => {
    expect(source).not.toMatch(/`session\/\$\{sessionId\}`/);
    expect(source).not.toMatch(/`session\/\$\{newSessionId\}`/);
  });

  it('uses git worktree add --detach instead of -b', () => {
    expect(source).toMatch(/git worktree add --detach/);
    expect(source).not.toMatch(/git worktree add ".*" -b/);
  });

  it('imports resolveStartingPoint and ensureMilestoneBranch from branchModel', () => {
    expect(source).toMatch(/from '\.\/branchModel'/);
    expect(source).toMatch(/resolveStartingPoint/);
    expect(source).toMatch(/ensureMilestoneBranch/);
  });

  it('cleanup derives branchName from worktree HEAD at cleanup time', () => {
    // cleanupWorktree should call git rev-parse --abbrev-ref HEAD internally
    const cleanupIdx = source.indexOf('private cleanupWorktree');
    const headCheckIdx = source.indexOf(
      'git rev-parse --abbrev-ref HEAD',
      cleanupIdx,
    );
    expect(headCheckIdx).toBeGreaterThan(cleanupIdx);
  });

  it('milestone branch is never deleted on cleanup (only task branch is)', () => {
    // The branch deletion is conditioned on !prUrl && branchName
    expect(source).toMatch(/if \(!prUrl && branchName\)/);
  });
});

// ── schema migration check ────────────────────────────────────────────────────

describe('schema migration — milestone_branching column', () => {
  const schemaSource = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'schema.ts'),
    'utf-8',
  );

  it('adds projects.milestone_branching column with NULL default', () => {
    expect(schemaSource).toMatch(
      /ALTER TABLE projects ADD COLUMN milestone_branching TEXT/,
    );
  });
});
