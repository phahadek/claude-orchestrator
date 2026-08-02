import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import { execSync } from 'child_process';
import {
  deriveBranchSlug,
  resolveResumeBranchSlug,
  slugify,
} from '../branchModel';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  exec: vi.fn(),
  execFile: vi.fn(),
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

describe('resolveResumeBranchSlug', () => {
  beforeEach(() => {
    vi.mocked(execSync).mockReset();
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
        throw new Error('not found');
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
      throw new Error('not found');
    });

    const branch = resolveResumeBranchSlug(title, taskId, '/proj');
    expect(branch).toBe(current);
  });
});
