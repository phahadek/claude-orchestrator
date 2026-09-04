import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

const { mockCorporateMode, mockGetMilestone } = vi.hoisted(() => ({
  mockCorporateMode: { enabled: false },
  mockGetMilestone: vi.fn(),
}));

vi.mock('../config/corporateMode.js', () => ({
  getCorporateMode: () => mockCorporateMode,
}));

vi.mock('../projects/ProjectService.js', () => ({
  ProjectService: {
    getMilestone: mockGetMilestone,
  },
}));

import {
  slugify,
  deriveBranchSlug,
  resolveBranchMode,
  resolveStartingPoint,
  ensureMilestoneBranch,
  MilestoneBranchDivergedError,
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
    mockCorporateMode.enabled = false;
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
    mockCorporateMode.enabled = true;
    expect(resolveBranchMode(null)).toBe('two_tier');
  });

  it('explicit project setting wins over corporate mode', () => {
    mockCorporateMode.enabled = true;
    expect(resolveBranchMode('flat')).toBe('flat');
  });
});

// ── resolveStartingPoint ──────────────────────────────────────────────────────

describe('resolveStartingPoint', () => {
  beforeEach(() => {
    mockCorporateMode.enabled = false;
    mockGetMilestone.mockReset();
  });

  it('returns milestone/<slug> for milestone task + two_tier mode', () => {
    mockGetMilestone.mockReturnValue({
      id: 'ms-1',
      name: 'M6 — Enterprise Readiness',
    });
    const result = resolveStartingPoint(
      { milestoneBranching: 'two_tier' },
      'ms-1',
    );
    expect(result.startingPoint).toBe('milestone/m6-enterprise-readiness');
    expect(result.milestoneSlug).toBe('m6-enterprise-readiness');
  });

  it('never collides with a task branch derived from the same slug', () => {
    mockGetMilestone.mockReturnValue({
      id: 'ms-1',
      name: 'Enterprise Readiness',
    });
    const milestoneResult = resolveStartingPoint(
      { milestoneBranching: 'two_tier' },
      'ms-1',
    );
    const taskBranch = deriveBranchSlug('Enterprise Readiness');
    expect(milestoneResult.startingPoint).not.toBe(taskBranch);
    expect(milestoneResult.startingPoint).toBe(
      'milestone/enterprise-readiness',
    );
    expect(taskBranch).toBe('feature/enterprise-readiness');
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
    mockCorporateMode.enabled = true;
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

  it('uses project.baseBranch instead of dev when configured', () => {
    const result = resolveStartingPoint(
      { milestoneBranching: 'flat', baseBranch: 'main' },
      null,
    );
    expect(result.startingPoint).toBe('main');
    expect(result.milestoneSlug).toBeNull();
  });

  it('defaults to dev when baseBranch is not provided', () => {
    const result = resolveStartingPoint({ milestoneBranching: 'flat' }, null);
    expect(result.startingPoint).toBe('dev');
  });
});

// ── ensureMilestoneBranch ─────────────────────────────────────────────────────

describe('ensureMilestoneBranch', () => {
  const execSyncMock = execSync as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    execSyncMock.mockReset();
  });

  it('fast-forward-refreshes the local ref from origin when branch already exists locally', () => {
    // git rev-parse --verify milestone/<slug> succeeds → branch exists locally
    execSyncMock
      .mockReturnValueOnce('') // local ref check
      .mockReturnValueOnce(''); // fast-forward-only fetch

    ensureMilestoneBranch('m6-readiness', '/repo');

    expect(execSyncMock).toHaveBeenCalledTimes(2);
    expect(execSyncMock).toHaveBeenCalledWith(
      'git rev-parse --verify milestone/m6-readiness',
      expect.objectContaining({ cwd: '/repo' }),
    );
    expect(execSyncMock).toHaveBeenCalledWith(
      'git fetch origin milestone/m6-readiness:milestone/m6-readiness',
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('throws when the fast-forward-only fetch is rejected as non-fast-forward (diverged local ref) instead of force-overwriting', () => {
    execSyncMock
      .mockReturnValueOnce('') // local ref check → exists
      .mockImplementationOnce(() => {
        // Real git wording for this exact rejection.
        throw new Error(
          ' ! [rejected]        milestone/m6-readiness -> milestone/m6-readiness  (non-fast-forward)\n' +
            "error: some local refs could not be updated; try running 'git remote prune origin' to remove any old, conflicting branches",
        );
      });

    let caught: unknown;
    try {
      ensureMilestoneBranch('m6-readiness', '/repo');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MilestoneBranchDivergedError);
    expect((caught as Error).message).toMatch(/fast-forward/);

    // No fallback branch-recreation/push calls after the failed fetch.
    expect(execSyncMock).toHaveBeenCalledTimes(2);
  });

  it('tolerates a transient fetch failure (network/DNS/auth) on an existing ref instead of treating it as divergence', () => {
    execSyncMock
      .mockReturnValueOnce('') // local ref check → exists
      .mockImplementationOnce(() => {
        throw new Error(
          "fatal: unable to access 'https://origin/repo.git': Could not resolve host: origin",
        );
      });

    // Does not throw — a transient fetch failure is non-fatal, same as the
    // fresh-branch-creation fetch path.
    expect(() =>
      ensureMilestoneBranch('m6-readiness', '/repo'),
    ).not.toThrow();

    // No fallback branch-recreation/push calls — the function simply
    // returns, proceeding with the existing (possibly slightly stale)
    // local ref rather than blocking session start/resume.
    expect(execSyncMock).toHaveBeenCalledTimes(2);
  });

  it('creates milestone/<slug> from origin/dev when missing, and pushes', () => {
    // 1st call: local ref check (milestone/<slug>) → throws (not found)
    // 2nd call: git fetch origin dev → ok
    // 3rd call: origin ref check (milestone/<slug>) → throws (not on origin)
    // 4th call: local ref check for legacy feature/<slug> → throws (not found)
    // 5th call: origin ref check for legacy feature/<slug> → throws (not found)
    // 6th call: git branch from origin/dev
    // 7th call: git push
    execSyncMock
      .mockImplementationOnce(() => {
        throw new Error('not found');
      })
      .mockReturnValueOnce('') // fetch
      .mockImplementationOnce(() => {
        throw new Error('not on origin');
      })
      .mockImplementationOnce(() => {
        throw new Error('legacy not found locally');
      })
      .mockImplementationOnce(() => {
        throw new Error('legacy not found on origin');
      })
      .mockReturnValueOnce('') // git branch
      .mockReturnValueOnce(''); // git push

    ensureMilestoneBranch('m6-readiness', '/repo');

    expect(execSyncMock).toHaveBeenCalledWith(
      'git branch milestone/m6-readiness origin/dev',
      expect.objectContaining({ cwd: '/repo' }),
    );
    expect(execSyncMock).toHaveBeenCalledWith(
      'git push origin milestone/m6-readiness',
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
      'git branch milestone/m6-readiness origin/milestone/m6-readiness',
      expect.objectContaining({ cwd: '/repo' }),
    );
    // No push — branch already on origin
    expect(execSyncMock).not.toHaveBeenCalledWith(
      expect.stringContaining('git push'),
      expect.anything(),
    );
  });

  it('creates milestone/<slug> from origin/main when baseBranch is main', () => {
    execSyncMock
      .mockImplementationOnce(() => {
        throw new Error('not found');
      })
      .mockReturnValueOnce('') // fetch origin main
      .mockImplementationOnce(() => {
        throw new Error('not on origin');
      })
      .mockImplementationOnce(() => {
        throw new Error('legacy not found locally');
      })
      .mockImplementationOnce(() => {
        throw new Error('legacy not found on origin');
      })
      .mockReturnValueOnce('') // git branch from origin/main
      .mockReturnValueOnce(''); // git push

    ensureMilestoneBranch('m6-readiness', '/repo', 'main');

    expect(execSyncMock).toHaveBeenCalledWith(
      'git fetch origin main',
      expect.objectContaining({ cwd: '/repo' }),
    );
    expect(execSyncMock).toHaveBeenCalledWith(
      'git branch milestone/m6-readiness origin/main',
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('migrates a pre-existing local feature/<slug> branch to milestone/<slug>', () => {
    // 1st call: local ref check (milestone/<slug>) → throws (not found)
    // 2nd call: git fetch → ok
    // 3rd call: origin ref check (milestone/<slug>) → throws (not on origin)
    // 4th call: local ref check for legacy feature/<slug> → succeeds (found)
    // 5th call: git branch -m (rename)
    // 6th call: git push origin milestone/<slug>
    // 7th call: git push origin --delete feature/<slug>
    execSyncMock
      .mockImplementationOnce(() => {
        throw new Error('not found');
      })
      .mockReturnValueOnce('') // fetch
      .mockImplementationOnce(() => {
        throw new Error('not on origin');
      })
      .mockReturnValueOnce('') // legacy local ref check succeeds
      .mockReturnValueOnce('') // git branch -m
      .mockReturnValueOnce('') // git push origin milestone/<slug>
      .mockReturnValueOnce(''); // git push origin --delete feature/<slug>

    ensureMilestoneBranch('m6-readiness', '/repo');

    expect(execSyncMock).toHaveBeenCalledWith(
      'git branch -m feature/m6-readiness milestone/m6-readiness',
      expect.objectContaining({ cwd: '/repo' }),
    );
    expect(execSyncMock).toHaveBeenCalledWith(
      'git push origin milestone/m6-readiness',
      expect.objectContaining({ cwd: '/repo' }),
    );
    expect(execSyncMock).toHaveBeenCalledWith(
      'git push origin --delete feature/m6-readiness',
      expect.objectContaining({ cwd: '/repo' }),
    );
    // Never creates a fresh branch from base when a legacy branch was migrated.
    expect(execSyncMock).not.toHaveBeenCalledWith(
      expect.stringContaining('origin/dev'),
      expect.anything(),
    );
  });

  it('migrates a pre-existing origin-only feature/<slug> branch to milestone/<slug>', () => {
    // 1st call: local ref check (milestone/<slug>) → throws (not found)
    // 2nd call: git fetch → ok
    // 3rd call: origin ref check (milestone/<slug>) → throws (not on origin)
    // 4th call: local ref check for legacy feature/<slug> → throws (not found)
    // 5th call: origin ref check for legacy feature/<slug> → succeeds (found)
    // 6th call: git branch (local tracking of legacy)
    // 7th call: git branch -m (rename)
    // 8th call: git push origin milestone/<slug>
    // 9th call: git push origin --delete feature/<slug>
    execSyncMock
      .mockImplementationOnce(() => {
        throw new Error('not found');
      })
      .mockReturnValueOnce('') // fetch
      .mockImplementationOnce(() => {
        throw new Error('not on origin');
      })
      .mockImplementationOnce(() => {
        throw new Error('legacy not found locally');
      })
      .mockReturnValueOnce('') // legacy origin ref check succeeds
      .mockReturnValueOnce('') // git branch (local tracking of legacy)
      .mockReturnValueOnce('') // git branch -m
      .mockReturnValueOnce('') // git push origin milestone/<slug>
      .mockReturnValueOnce(''); // git push origin --delete feature/<slug>

    ensureMilestoneBranch('m6-readiness', '/repo');

    expect(execSyncMock).toHaveBeenCalledWith(
      'git branch feature/m6-readiness origin/feature/m6-readiness',
      expect.objectContaining({ cwd: '/repo' }),
    );
    expect(execSyncMock).toHaveBeenCalledWith(
      'git branch -m feature/m6-readiness milestone/m6-readiness',
      expect.objectContaining({ cwd: '/repo' }),
    );
    expect(execSyncMock).toHaveBeenCalledWith(
      'git push origin --delete feature/m6-readiness',
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('does not migrate when no pre-existing feature/<slug> branch exists anywhere', () => {
    execSyncMock
      .mockImplementationOnce(() => {
        throw new Error('not found');
      })
      .mockReturnValueOnce('') // fetch
      .mockImplementationOnce(() => {
        throw new Error('not on origin');
      })
      .mockImplementationOnce(() => {
        throw new Error('legacy not found locally');
      })
      .mockImplementationOnce(() => {
        throw new Error('legacy not found on origin');
      })
      .mockReturnValueOnce('') // git branch from origin/dev
      .mockReturnValueOnce(''); // git push

    ensureMilestoneBranch('m6-readiness', '/repo');

    expect(execSyncMock).not.toHaveBeenCalledWith(
      expect.stringContaining('git branch -m'),
      expect.anything(),
    );
    expect(execSyncMock).toHaveBeenCalledWith(
      'git branch milestone/m6-readiness origin/dev',
      expect.objectContaining({ cwd: '/repo' }),
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
    // `session/${sessionId}` still appears in pruneSessionBranch — a
    // backward-compat cleanup helper that deletes legacy pre-feature-branch
    // sessions, not something start()/completeStart() creates. Scope the
    // check to the start()/completeStart() region (up to the next unrelated
    // private method) so the legacy prune helper doesn't trip a false
    // positive.
    const startIdx = source.indexOf('async start(');
    const completeStartEndIdx = source.indexOf(
      'private async cleanupPartialWorktree',
    );
    expect(startIdx).toBeGreaterThan(-1);
    expect(completeStartEndIdx).toBeGreaterThan(startIdx);
    const startRegion = source.slice(startIdx, completeStartEndIdx);
    expect(startRegion).not.toMatch(/`session\/\$\{sessionId\}`/);
    expect(startRegion).not.toMatch(/`session\/\$\{newSessionId\}`/);
  });

  it('creates worktree on named feature branch when taskName is available', () => {
    expect(source).toMatch(/git worktree add -b/);
    // Branch-name derivation now lives in branchModel.ts's deriveBranchSlug
    // (imported below), rather than being inlined as `feature/${slugify(...)}`.
    expect(source).toMatch(/deriveBranchSlug/);
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
    // The branch deletion is conditioned on deleteBranch (no PR, or the PR
    // was merged) && branchName — never on the milestone branch itself.
    expect(source).toMatch(
      /const deleteBranch = !prUrl \|\| this\._mergedSessionIds\.has\(sessionId\);/,
    );
    expect(source).toMatch(/if \(deleteBranch && branchName\)/);
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
