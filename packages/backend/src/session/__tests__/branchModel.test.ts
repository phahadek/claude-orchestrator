import { describe, it, expect } from 'vitest';
import { deriveBranchSlug, slugify } from '../branchModel';

describe('deriveBranchSlug', () => {
  it('returns unchanged slug for short titles (no truncation, no hash)', () => {
    const title = 'Fix login bug';
    const branch = deriveBranchSlug(title);
    expect(branch).toBe(`feature/${slugify(title)}`);
    expect(branch.length).toBeLessThanOrEqual('feature/'.length + 80);
  });

  it('50-char title is not truncated and has no hash suffix', () => {
    // slug of exactly 50 chars (well under the 80-char cap)
    const title = 'abcde '.repeat(10).trim(); // "abcde abcde..." → slug "abcde-abcde-..." (59 chars)
    const branch = deriveBranchSlug(title);
    const slugPart = branch.slice('feature/'.length);
    expect(slugPart.length).toBeLessThanOrEqual(80);
    expect(slugPart).toBe(slugify(title));
  });

  it('200-char single-word title yields 88-char branch name', () => {
    // No spaces → no word-boundary trimming → exact 88 chars
    const title = 'alphabravo'.repeat(20); // 200 alphanumeric chars, no spaces
    const branch = deriveBranchSlug(title);
    // feature/(8) + truncated(71) + dash(1) + hash(8) = 88
    expect(branch.length).toBe(88);
  });

  it('derived branch for a >150-char title stays under 100 chars total', () => {
    const title = 'some task title word '.repeat(8).trim(); // ~168 chars
    const branch = deriveBranchSlug(title);
    expect(branch.length).toBeLessThan(100);
  });

  it('truncates at word boundary for long titles with spaces', () => {
    // "word word word..." — slug becomes "word-word-word-..."
    const title = 'word '.repeat(40).trim();
    const branch = deriveBranchSlug(title);
    const slugPart = branch.slice('feature/'.length);
    // Remove the trailing -<8hexchars>
    const withoutHash = slugPart.replace(/-[a-f0-9]{8}$/, '');
    const fullSlug = slugify(title);
    // The char right after the truncated portion in the full slug must be '-' (word boundary)
    expect(fullSlug[withoutHash.length]).toBe('-');
  });

  it('is deterministic — same input always produces same output', () => {
    const title = 'Some Very Long Task Title That Exceeds The Branch Slug Length Limit By Quite A Bit More Words Here';
    const branch1 = deriveBranchSlug(title);
    const branch2 = deriveBranchSlug(title);
    expect(branch1).toBe(branch2);
  });

  it('two different titles with the same 80-char slug prefix produce different branch slugs', () => {
    // Both titles produce slugs > 80 chars with identical first ~80 chars
    const base = 'a'.repeat(82);
    const title1 = base + 'x';
    const title2 = base + 'y';
    const branch1 = deriveBranchSlug(title1);
    const branch2 = deriveBranchSlug(title2);
    expect(branch1).not.toBe(branch2);
  });

  it('uses the provided prefix', () => {
    const title = 'my task';
    expect(deriveBranchSlug(title, 'fix')).toBe('fix/my-task');
  });

  it('defaults prefix to feature', () => {
    const title = 'my task';
    expect(deriveBranchSlug(title)).toMatch(/^feature\//);
  });
});
