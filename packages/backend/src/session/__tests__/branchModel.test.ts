import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { logger } from '../../logger';
import { getCorporateMode } from '../../config/corporateMode';
import { ProjectService } from '../../projects/ProjectService';
import {
  deriveBranchSlug,
  probeBranchLocally,
  resolveResumeBranchSlug,
  resolveAvailableBranchSlug,
  resolveBranchMode,
  resolveStartingPoint,
  slugify,
} from '../branchModel';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  exec: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('../../config/corporateMode', () => ({
  getCorporateMode: vi.fn(),
}));

vi.mock('../../projects/ProjectService', () => ({
  ProjectService: {
    getMilestone: vi.fn(),
  },
}));

describe('deriveBranchSlug', () => {
  it('returns unchanged slug for short titles (no truncation, no hash)', () => {
    const title = 'Fix login bug';
    const branch = deriveBranchSlug(title, 'task-abc');
    expect(branch).toBe(`feature/${slugify(title)}`);
    expect(branch.length).toBeLessThanOrEqual('feature/'.length + 80);
  });

  it('50-char title is not truncated and has no hash suffix', () => {
    // slug of exactly 50 chars (well under the 80-char cap)
    const title = 'abcde '.repeat(10).trim(); // "abcde abcde..." → slug "abcde-abcde-..." (59 chars)
    const branch = deriveBranchSlug(title, 'task-abc');
    const slugPart = branch.slice('feature/'.length);
    expect(slugPart.length).toBeLessThanOrEqual(80);
    expect(slugPart).toBe(slugify(title));
  });

  it('200-char single-word title yields 88-char branch name', () => {
    // No spaces → no word-boundary trimming → exact 88 chars
    const title = 'alphabravo'.repeat(20); // 200 alphanumeric chars, no spaces
    const branch = deriveBranchSlug(title, 'task-abc');
    // feature/(8) + truncated(71) + dash(1) + hash(8) = 88
    expect(branch.length).toBe(88);
  });

  it('derived branch for a >150-char title stays under 100 chars total', () => {
    const title = 'some task title word '.repeat(8).trim(); // ~168 chars
    const branch = deriveBranchSlug(title, 'task-abc');
    expect(branch.length).toBeLessThan(100);
  });

  it('truncates at word boundary for long titles with spaces', () => {
    // "word word word..." — slug becomes "word-word-word-..."
    const title = 'word '.repeat(40).trim();
    const branch = deriveBranchSlug(title, 'task-abc');
    const slugPart = branch.slice('feature/'.length);
    // Remove the trailing -<8hexchars>
    const withoutHash = slugPart.replace(/-[a-f0-9]{8}$/, '');
    const fullSlug = slugify(title);
    // The char right after the truncated portion in the full slug must be '-' (word boundary)
    expect(fullSlug[withoutHash.length]).toBe('-');
  });

  it('is deterministic — same input always produces same output', () => {
    const title =
      'Some Very Long Task Title That Exceeds The Branch Slug Length Limit By Quite A Bit More Words Here';
    const branch1 = deriveBranchSlug(title, 'task-abc-123');
    const branch2 = deriveBranchSlug(title, 'task-abc-123');
    expect(branch1).toBe(branch2);
  });

  it('two different titles with the same 80-char slug prefix produce different branch slugs (legacy title-only hash)', () => {
    // Both titles produce slugs > 80 chars with identical first ~80 chars.
    // No taskId given here — this exercises the legacy title-only hash path,
    // which must still disambiguate on the full (untruncated) slug.
    const base = 'a'.repeat(82);
    const title1 = base + 'x';
    const title2 = base + 'y';
    const branch1 = deriveBranchSlug(title1);
    const branch2 = deriveBranchSlug(title2);
    expect(branch1).not.toBe(branch2);
  });

  it('uses the provided prefix', () => {
    const title = 'my task';
    expect(deriveBranchSlug(title, 'task-abc', 'fix')).toBe('fix/my-task');
  });

  it('defaults prefix to feature', () => {
    const title = 'my task';
    expect(deriveBranchSlug(title, 'task-abc')).toMatch(/^feature\//);
  });

  it('two tasks with identical titles and different ids produce different branch names', () => {
    const title = 'word '.repeat(40).trim(); // long enough to force a hash suffix
    const branch1 = deriveBranchSlug(
      title,
      'notion:3b022f91-52f3-8163-9f24-ebecd56c4b97',
    );
    const branch2 = deriveBranchSlug(
      title,
      'notion:9c133a02-63a4-9274-af35-fcfde67d5c98',
    );
    expect(branch1).not.toBe(branch2);
    // The readable prefix is unaffected — only the hash suffix differs.
    const withoutHash1 = branch1.replace(/-[a-f0-9]{8}$/, '');
    const withoutHash2 = branch2.replace(/-[a-f0-9]{8}$/, '');
    expect(withoutHash1).toBe(withoutHash2);
  });

  it('the same task (title + id) produces the same branch name across repeated derivations', () => {
    const title = 'word '.repeat(40).trim();
    const taskId = 'notion:3b022f91-52f3-8163-9f24-ebecd56c4b97';
    expect(deriveBranchSlug(title, taskId)).toBe(
      deriveBranchSlug(title, taskId),
    );
  });

  it('hashes the full task id, not a truncated form', () => {
    const title = 'word '.repeat(40).trim();
    // Two ids sharing a long common prefix, differing only near the end —
    // a truncated-id hash would collide here; a full-id hash must not.
    const sharedPrefix = 'notion:3b022f9152f381639f24ebecd56c4b97-';
    const branch1 = deriveBranchSlug(title, `${sharedPrefix}aaaa`);
    const branch2 = deriveBranchSlug(title, `${sharedPrefix}bbbb`);
    expect(branch1).not.toBe(branch2);
  });

  it('omitting the task id falls back to the legacy title-only hash (pre-existing scheme)', () => {
    const title = 'word '.repeat(40).trim();
    const legacyBranch = deriveBranchSlug(title);
    // Reproduces the exact pre-task-id derivation: sha1 of the slug alone.
    const fullSlug = slugify(title);
    const truncateAt = 80 - 8 - 1;
    let truncated = fullSlug.slice(0, truncateAt);
    const lastDash = truncated.lastIndexOf('-');
    if (lastDash > 0) truncated = truncated.slice(0, lastDash);
    const hash = crypto
      .createHash('sha1')
      .update(fullSlug)
      .digest('hex')
      .slice(0, 8);
    expect(legacyBranch).toBe(`feature/${truncated}-${hash}`);
  });
});

describe('probeBranchLocally', () => {
  beforeEach(() => {
    vi.mocked(execSync).mockReset();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  it('returns exists when the child exits 0', () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    expect(probeBranchLocally('feature/foo', '/proj')).toBe('exists');
  });

  it('returns absent when the child exits 1 with no stderr', () => {
    const err = Object.assign(new Error('not found'), {
      status: 1,
      signal: null,
      stderr: Buffer.from(''),
    });
    vi.mocked(execSync).mockImplementation(() => {
      throw err;
    });
    expect(probeBranchLocally('feature/foo', '/proj')).toBe('absent');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns unknown for a spawn error (no status, errno/code set)', () => {
    const err = Object.assign(new Error('spawn failed'), {
      errno: -11,
      code: 'EAGAIN',
      status: null,
      signal: null,
    });
    vi.mocked(execSync).mockImplementation(() => {
      throw err;
    });
    expect(probeBranchLocally('feature/foo', '/proj')).toBe('unknown');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('EAGAIN'));
  });

  it('returns unknown for a non-1 non-zero exit code', () => {
    const err = Object.assign(new Error('unexpected exit'), {
      status: 128,
      signal: null,
      stderr: Buffer.from('fatal: not a git repository'),
    });
    vi.mocked(execSync).mockImplementation(() => {
      throw err;
    });
    expect(probeBranchLocally('feature/foo', '/proj')).toBe('unknown');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('128'));
  });

  it('returns unknown for a signal-terminated child', () => {
    const err = Object.assign(new Error('killed'), {
      status: null,
      signal: 'SIGTERM',
      stderr: Buffer.from(''),
    });
    vi.mocked(execSync).mockImplementation(() => {
      throw err;
    });
    expect(probeBranchLocally('feature/foo', '/proj')).toBe('unknown');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('SIGTERM'),
    );
  });

  it('returns unknown when exit 1 carries stderr output (not the documented "ref not found" shape)', () => {
    const err = Object.assign(new Error('git error'), {
      status: 1,
      signal: null,
      stderr: Buffer.from('fatal: some other git error'),
    });
    vi.mocked(execSync).mockImplementation(() => {
      throw err;
    });
    expect(probeBranchLocally('feature/foo', '/proj')).toBe('unknown');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('passes --quiet to git rev-parse --verify, matching the exit-1/empty-stderr fixture shape', () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    probeBranchLocally('feature/foo', '/proj');
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(
      expect.stringContaining(
        'git rev-parse --verify --quiet refs/heads/feature/foo',
      ),
      expect.anything(),
    );
  });
});

describe('probeBranchLocally (real git)', () => {
  const realExecSync =
    vi.importActual<typeof import('child_process')>('child_process');
  let repoDir: string;
  let nonRepoDir: string;

  beforeEach(async () => {
    vi.mocked(execSync).mockImplementation((await realExecSync).execSync);
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branchmodel-repo-'));
    execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.email test@example.com', {
      cwd: repoDir,
      stdio: 'pipe',
    });
    execSync('git config user.name Test', { cwd: repoDir, stdio: 'pipe' });
    execSync('git commit --allow-empty -m init', {
      cwd: repoDir,
      stdio: 'pipe',
    });
    execSync('git branch existing-branch', { cwd: repoDir, stdio: 'pipe' });

    nonRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branchmodel-plain-'));
  });

  afterAll(() => {
    vi.mocked(execSync).mockReset();
  });

  it('returns exists for a branch that was created', () => {
    expect(probeBranchLocally('existing-branch', repoDir)).toBe('exists');
  });

  it('returns absent for a branch that was never created', () => {
    expect(probeBranchLocally('never-created-branch', repoDir)).toBe('absent');
  });

  it('returns unknown when projectDir is not a git repository', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(probeBranchLocally('any-branch', nonRepoDir)).toBe('unknown');
  });
});

describe('resolveAvailableBranchSlug (real git)', () => {
  const realExecSync =
    vi.importActual<typeof import('child_process')>('child_process');
  let repoDir: string;

  beforeEach(async () => {
    vi.mocked(execSync).mockImplementation((await realExecSync).execSync);
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branchmodel-avail-'));
    execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.email test@example.com', {
      cwd: repoDir,
      stdio: 'pipe',
    });
    execSync('git config user.name Test', { cwd: repoDir, stdio: 'pipe' });
    execSync('git commit --allow-empty -m init', {
      cwd: repoDir,
      stdio: 'pipe',
    });
  });

  afterAll(() => {
    vi.mocked(execSync).mockReset();
  });

  it('returns the base name unchanged when no branch of that name exists', () => {
    expect(resolveAvailableBranchSlug('feature/my-task', repoDir)).toBe(
      'feature/my-task',
    );
  });

  it('returns <base>-2 when the base name already exists', () => {
    execSync('git branch feature/my-task', { cwd: repoDir, stdio: 'pipe' });
    expect(resolveAvailableBranchSlug('feature/my-task', repoDir)).toBe(
      'feature/my-task-2',
    );
  });
});

function absentError() {
  return Object.assign(new Error('not found'), {
    status: 1,
    signal: null,
    stderr: Buffer.from(''),
  });
}

describe('resolveAvailableBranchSlug', () => {
  beforeEach(() => {
    vi.mocked(execSync).mockReset();
  });

  it('returns the base name unchanged when it has no collision', () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw absentError();
    });
    expect(resolveAvailableBranchSlug('feature/my-task', '/proj')).toBe(
      'feature/my-task',
    );
  });

  it('returns <base>-2 when the base name already exists locally', () => {
    vi.mocked(execSync).mockImplementation((cmd) => {
      if (String(cmd).includes('feature/my-task-2')) {
        throw absentError();
      }
      return Buffer.from(''); // base "exists"
    });
    expect(resolveAvailableBranchSlug('feature/my-task', '/proj')).toBe(
      'feature/my-task-2',
    );
  });

  it('returns <base>-3 when both the base name and <base>-2 already exist', () => {
    vi.mocked(execSync).mockImplementation((cmd) => {
      if (String(cmd).includes('feature/my-task-3')) {
        throw absentError();
      }
      return Buffer.from(''); // base and -2 both "exist"
    });
    expect(resolveAvailableBranchSlug('feature/my-task', '/proj')).toBe(
      'feature/my-task-3',
    );
  });

  it('aborts immediately on an unknown probe of the base name — never returns the base and probes only once', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const err = Object.assign(new Error('spawn failed'), {
      errno: -11,
      code: 'EAGAIN',
      status: null,
      signal: null,
    });
    vi.mocked(execSync).mockImplementation(() => {
      throw err;
    });
    expect(() =>
      resolveAvailableBranchSlug('feature/my-task', '/proj'),
    ).toThrow(/inconclusive/);
    expect(execSync).toHaveBeenCalledTimes(1);
  });

  it('aborts immediately on an unknown probe mid-loop rather than continuing to the cap', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const err = Object.assign(new Error('spawn failed'), {
      errno: -11,
      code: 'EAGAIN',
      status: null,
      signal: null,
    });
    vi.mocked(execSync).mockImplementation((cmd) => {
      if (String(cmd).includes('feature/my-task-2')) {
        throw err; // unknown mid-loop — must abort here, not keep probing
      }
      return Buffer.from(''); // base "exists"
    });
    expect(() =>
      resolveAvailableBranchSlug('feature/my-task', '/proj'),
    ).toThrow(/inconclusive/);
    // one call for the base ("exists"), one for -2 (the unknown that aborts)
    expect(execSync).toHaveBeenCalledTimes(2);
  });

  it('the thrown message on unknown names the probe failure, not uniquification exhaustion', () => {
    const err = Object.assign(new Error('spawn failed'), {
      errno: -11,
      code: 'EAGAIN',
      status: null,
      signal: null,
    });
    vi.mocked(execSync).mockImplementation(() => {
      throw err;
    });
    expect(() =>
      resolveAvailableBranchSlug('feature/my-task', '/proj'),
    ).toThrow(/inconclusive/);
    try {
      resolveAvailableBranchSlug('feature/my-task', '/proj');
    } catch (e) {
      expect((e as Error).message).not.toMatch(/exhausted/i);
      expect((e as Error).message).not.toMatch(/uniquification attempts/i);
    }
  });

  it('reaches the cap and throws the exhaustion error for a genuine long collision chain with no inconclusive probes', () => {
    vi.mocked(execSync).mockImplementation(() => Buffer.from('')); // every candidate "exists"
    expect(() =>
      resolveAvailableBranchSlug('feature/my-task', '/proj'),
    ).toThrow(/exhausted 1000 uniquification attempts/);
  });
});

describe('resolveResumeBranchSlug', () => {
  beforeEach(() => {
    vi.mocked(execSync).mockReset();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  it('returns the current-scheme branch unchanged for short titles (nothing to migrate)', () => {
    const title = 'Fix login bug';
    const branch = resolveResumeBranchSlug(title, 'task-abc', '/proj');
    expect(branch).toBe(`feature/${slugify(title)}`);
    expect(execSync).not.toHaveBeenCalled();
  });

  it('returns the current-scheme branch unchanged when no task id is available', () => {
    const title = 'word '.repeat(40).trim();
    const branch = resolveResumeBranchSlug(title, null, '/proj');
    expect(branch).toBe(deriveBranchSlug(title, null));
    expect(execSync).not.toHaveBeenCalled();
  });

  it('prefers the legacy branch when the id-based branch is absent but the legacy branch exists', () => {
    const title = 'word '.repeat(40).trim();
    const taskId = 'task-abc';
    const current = deriveBranchSlug(title, taskId);
    const legacy = deriveBranchSlug(title, null);

    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes(`refs/heads/${current}`)) {
        throw absentError();
      }
      if (cmd.includes(`refs/heads/${legacy}`)) {
        return Buffer.from('');
      }
      throw new Error('unexpected command');
    });

    const branch = resolveResumeBranchSlug(title, taskId, '/proj');
    expect(branch).toBe(legacy);
  });

  it('uses the id-based branch when it already exists locally', () => {
    const title = 'word '.repeat(40).trim();
    const taskId = 'task-abc';
    const current = deriveBranchSlug(title, taskId);

    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes(`refs/heads/${current}`)) {
        return Buffer.from('');
      }
      throw new Error('unexpected command');
    });

    const branch = resolveResumeBranchSlug(title, taskId, '/proj');
    expect(branch).toBe(current);
  });

  it('falls back to the id-based branch when neither branch exists locally (genuinely new)', () => {
    const title = 'word '.repeat(40).trim();
    const taskId = 'task-abc';
    const current = deriveBranchSlug(title, taskId);

    vi.mocked(execSync).mockImplementation(() => {
      throw absentError();
    });

    const branch = resolveResumeBranchSlug(title, taskId, '/proj');
    expect(branch).toBe(current);
  });

  it('does not treat an unknown probe on the current branch as absent — stays on the id-based branch even though the legacy branch exists', () => {
    const title = 'word '.repeat(40).trim();
    const taskId = 'task-abc';
    const current = deriveBranchSlug(title, taskId);
    const legacy = deriveBranchSlug(title, null);

    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes(`refs/heads/${current}`)) {
        throw Object.assign(new Error('spawn failed'), {
          errno: -11,
          code: 'EAGAIN',
          status: null,
          signal: null,
        });
      }
      if (cmd.includes(`refs/heads/${legacy}`)) {
        return Buffer.from('');
      }
      throw new Error('unexpected command');
    });

    const branch = resolveResumeBranchSlug(title, taskId, '/proj');
    expect(branch).toBe(current);
  });
});

describe('resolveBranchMode', () => {
  beforeEach(() => {
    vi.mocked(getCorporateMode).mockReturnValue({ enabled: false });
  });

  it('an explicit milestone override wins over an opposite project setting', () => {
    expect(resolveBranchMode('flat', 'two_tier')).toBe('two_tier');
    expect(resolveBranchMode('two_tier', 'flat')).toBe('flat');
  });

  it('a null milestone override falls through to the project setting unchanged', () => {
    expect(resolveBranchMode('two_tier', null)).toBe('two_tier');
    expect(resolveBranchMode('flat', null)).toBe('flat');
  });

  it('falls through to corporate mode when both project and milestone settings are unset', () => {
    vi.mocked(getCorporateMode).mockReturnValue({ enabled: true });
    expect(resolveBranchMode(null, null)).toBe('two_tier');
    vi.mocked(getCorporateMode).mockReturnValue({ enabled: false });
    expect(resolveBranchMode(null, null)).toBe('flat');
  });
});

describe('resolveStartingPoint', () => {
  beforeEach(() => {
    vi.mocked(getCorporateMode).mockReturnValue({ enabled: false });
    vi.mocked(ProjectService.getMilestone).mockReset();
  });

  it('milestone override two_tier resolves to the milestone branch regardless of the project flat setting', () => {
    vi.mocked(ProjectService.getMilestone).mockReturnValue({
      id: 'm1',
      projectId: 'p1',
      name: 'Milestone One',
      sourceId: null,
      canonicalShortId: 'M1',
      displayOrder: 0,
      wrappedAt: null,
      milestoneBranching: 'two_tier',
      createdAt: 0,
      updatedAt: 0,
    });

    const result = resolveStartingPoint(
      { milestoneBranching: 'flat', baseBranch: 'dev' },
      'm1',
    );
    expect(result).toEqual({
      startingPoint: `feature/${slugify('Milestone One')}`,
      milestoneSlug: slugify('Milestone One'),
    });
  });

  it('milestone override flat resolves to the base branch regardless of the project two_tier setting', () => {
    vi.mocked(ProjectService.getMilestone).mockReturnValue({
      id: 'm1',
      projectId: 'p1',
      name: 'Milestone One',
      sourceId: null,
      canonicalShortId: 'M1',
      displayOrder: 0,
      wrappedAt: null,
      milestoneBranching: 'flat',
      createdAt: 0,
      updatedAt: 0,
    });

    const result = resolveStartingPoint(
      { milestoneBranching: 'two_tier', baseBranch: 'dev' },
      'm1',
    );
    expect(result).toEqual({ startingPoint: 'dev', milestoneSlug: null });
  });

  it('a null milestone override falls through to the project setting unchanged', () => {
    vi.mocked(ProjectService.getMilestone).mockReturnValue({
      id: 'm1',
      projectId: 'p1',
      name: 'Milestone One',
      sourceId: null,
      canonicalShortId: 'M1',
      displayOrder: 0,
      wrappedAt: null,
      milestoneBranching: null,
      createdAt: 0,
      updatedAt: 0,
    });

    const result = resolveStartingPoint(
      { milestoneBranching: 'two_tier', baseBranch: 'dev' },
      'm1',
    );
    expect(result).toEqual({
      startingPoint: `feature/${slugify('Milestone One')}`,
      milestoneSlug: slugify('Milestone One'),
    });
  });
});
