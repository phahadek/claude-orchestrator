import { describe, it, expect, vi, beforeEach } from 'vitest';

// Exercises resolveBranchMode against the real getCorporateMode() resolution
// chain (not a corporateMode.js mock) to prove branch-mode inference tracks
// the settings-row source, not just the ORCHESTRATOR_MODE/CORPORATE_MODE env
// vars.

vi.mock('../db/queries.js', () => ({
  getSetting: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../projects/ProjectService.js', () => ({
  ProjectService: { getMilestone: vi.fn() },
}));

import { getSetting } from '../db/queries.js';
import { _resetCorporateModeCache } from '../config/corporateMode.js';
import { resolveBranchMode } from '../session/branchModel.js';

describe('resolveBranchMode — corporate mode resolved from the settings row', () => {
  beforeEach(() => {
    _resetCorporateModeCache();
    vi.clearAllMocks();
    vi.mocked(getSetting).mockReturnValue(undefined);
    delete process.env.ORCHESTRATOR_MODE;
    delete process.env.CORPORATE_MODE;
  });

  it('returns two_tier when the settings row (not an env var) says corporate', () => {
    vi.mocked(getSetting).mockReturnValue('corporate');
    expect(resolveBranchMode(null)).toBe('two_tier');
  });

  it('an explicit per-project milestone_branching still wins over the settings-row corporate mode', () => {
    vi.mocked(getSetting).mockReturnValue('corporate');
    expect(resolveBranchMode('flat')).toBe('flat');
  });
});
