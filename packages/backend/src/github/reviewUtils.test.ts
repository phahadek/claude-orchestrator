import { describe, it, expect } from 'vitest';
import { shouldAutoReview, formatCIFailureFeedback } from './reviewUtils';

describe('shouldAutoReview()', () => {
  const withCap = (
    reviewIteration: number,
    headSha: string | null,
    lastReviewedSha: string | null,
  ) => ({ reviewIteration, headSha, lastReviewedSha });

  it('returns false when reviewIteration >= maxIterations', () => {
    expect(shouldAutoReview(withCap(3, 'abc', null), 3)).toBe(false);
    expect(shouldAutoReview(withCap(4, 'abc', null), 3)).toBe(false);
    expect(shouldAutoReview(withCap(5, 'abc', null), 3)).toBe(false);
  });

  it('returns false when headSha is null', () => {
    expect(shouldAutoReview(withCap(0, null, null), 3)).toBe(false);
    expect(shouldAutoReview(withCap(1, null, 'old'), 3)).toBe(false);
  });

  it('returns false when headSha === lastReviewedSha (no new commits)', () => {
    expect(shouldAutoReview(withCap(0, 'abc123', 'abc123'), 3)).toBe(false);
    expect(shouldAutoReview(withCap(2, 'def456', 'def456'), 3)).toBe(false);
  });

  it('returns true when iteration below cap and new commits exist', () => {
    expect(shouldAutoReview(withCap(0, 'newsha', null), 3)).toBe(true);
    expect(shouldAutoReview(withCap(0, 'newsha', 'oldsha'), 3)).toBe(true);
    expect(shouldAutoReview(withCap(2, 'newsha', 'oldsha'), 3)).toBe(true);
  });

  it('returns true with iteration exactly one below the cap', () => {
    expect(shouldAutoReview(withCap(2, 'newsha', 'oldsha'), 3)).toBe(true);
  });

  it('handles maxIterations = 1 correctly', () => {
    expect(shouldAutoReview(withCap(0, 'newsha', 'oldsha'), 1)).toBe(true);
    expect(shouldAutoReview(withCap(1, 'newsha', 'oldsha'), 1)).toBe(false);
  });

  it('regression: NULL lastReviewedSha allows re-review when head is set (gate-failure path)', () => {
    // After a gate failure, last_reviewed_sha is NULL because no review completed.
    // A subsequent push sets head_sha to a new value. shouldAutoReview must return
    // true so the re-review fires — it must not treat null === null as "no new code".
    expect(shouldAutoReview(withCap(0, 'pushed-sha', null), 3)).toBe(true);
    expect(shouldAutoReview(withCap(1, 'pushed-sha', null), 3)).toBe(true);
  });
});

describe('formatCIFailureFeedback() — source: github (regression)', () => {
  it('renders failing check names as a list', () => {
    const result = formatCIFailureFeedback({
      source: 'github',
      prNumber: 42,
      failingCheckNames: ['lint', 'unit-tests'],
      runUrl: null,
      logExcerpt: null,
    });
    expect(result).toContain('- lint');
    expect(result).toContain('- unit-tests');
  });

  it('works without explicit source field (backward compat)', () => {
    const result = formatCIFailureFeedback({
      prNumber: 42,
      failingCheckNames: ['lint', 'unit-tests'],
      runUrl: null,
      logExcerpt: null,
    });
    expect(result).toContain('- lint');
    expect(result).toContain('- unit-tests');
  });

  it('renders (unknown) when no check names are provided', () => {
    const result = formatCIFailureFeedback({
      prNumber: 42,
      failingCheckNames: [],
      runUrl: null,
      logExcerpt: null,
    });
    expect(result).toContain('- (unknown)');
  });

  it('includes the GitHub Actions run URL when provided', () => {
    const runUrl = 'https://github.com/owner/repo/pull/42/checks';
    const result = formatCIFailureFeedback({
      prNumber: 42,
      failingCheckNames: ['typecheck'],
      runUrl,
      logExcerpt: null,
    });
    expect(result).toContain(runUrl);
  });

  it('omits run section when runUrl is null', () => {
    const result = formatCIFailureFeedback({
      prNumber: 42,
      failingCheckNames: ['typecheck'],
      runUrl: null,
      logExcerpt: null,
    });
    expect(result).not.toContain('**Run:**');
  });

  it('truncates log excerpt at the cap and appends a marker', () => {
    const longLog = 'x'.repeat(900);
    const result = formatCIFailureFeedback({
      prNumber: 42,
      failingCheckNames: ['lint'],
      runUrl: null,
      logExcerpt: longLog,
    });
    expect(result).toContain('… [');
    expect(result).toContain('more line');
    const excerptStart = result.indexOf('xxx');
    const excerptEnd = result.indexOf('\n…');
    expect(excerptEnd - excerptStart).toBeLessThanOrEqual(800);
  });

  it('does not truncate log excerpt that fits within the cap', () => {
    const shortLog = 'error: something went wrong\nline 2';
    const result = formatCIFailureFeedback({
      prNumber: 42,
      failingCheckNames: ['lint'],
      runUrl: null,
      logExcerpt: shortLog,
    });
    expect(result).toContain(shortLog);
    expect(result).not.toContain('… [');
  });

  it('includes "investigate and push a fix" instruction block', () => {
    const result = formatCIFailureFeedback({
      prNumber: 42,
      failingCheckNames: ['lint'],
      runUrl: null,
      logExcerpt: null,
    });
    expect(result).toMatch(/investigate the failures and push a fix/i);
  });

  it('includes the do-not-rebase instruction matching formatReviewFeedback voice', () => {
    const result = formatCIFailureFeedback({
      prNumber: 42,
      failingCheckNames: ['lint'],
      runUrl: null,
      logExcerpt: null,
    });
    expect(result).toContain('Do NOT rebase onto dev');
    expect(result).toContain('push directly to your feature branch');
  });

  it('includes the PR number in the header', () => {
    const result = formatCIFailureFeedback({
      prNumber: 99,
      failingCheckNames: ['lint'],
      runUrl: null,
      logExcerpt: null,
    });
    expect(result).toContain('PR #99');
  });
});

describe('formatCIFailureFeedback() — source: verify', () => {
  it('renders the failed command', () => {
    const result = formatCIFailureFeedback({
      source: 'verify',
      failedCommand: 'npm run lint',
      truncatedOutput: undefined,
    });
    expect(result).toContain('npm run lint');
  });

  it('renders truncated output when provided', () => {
    const result = formatCIFailureFeedback({
      source: 'verify',
      failedCommand: 'npm run lint',
      truncatedOutput: 'error: lint failed on line 42',
    });
    expect(result).toContain('error: lint failed on line 42');
  });

  it('omits output section when truncatedOutput is undefined', () => {
    const result = formatCIFailureFeedback({
      source: 'verify',
      failedCommand: 'npm run lint',
      truncatedOutput: undefined,
    });
    expect(result).not.toContain('Command output:');
  });

  it('includes "investigate and push a fix" instruction block', () => {
    const result = formatCIFailureFeedback({
      source: 'verify',
      failedCommand: 'npm run build',
      truncatedOutput: 'build error',
    });
    expect(result).toMatch(/investigate the failures and push a fix/i);
  });

  it('includes the do-not-rebase instruction block', () => {
    const result = formatCIFailureFeedback({
      source: 'verify',
      failedCommand: 'npm test',
      truncatedOutput: undefined,
    });
    expect(result).toContain('Do NOT rebase onto dev');
    expect(result).toContain('push directly to your feature branch');
  });

  it('does not contain a PR number reference', () => {
    const result = formatCIFailureFeedback({
      source: 'verify',
      failedCommand: 'npm test',
      truncatedOutput: undefined,
    });
    expect(result).not.toMatch(/PR #\d+/);
  });

  it('falls back to (unknown) when failedCommand is undefined', () => {
    const result = formatCIFailureFeedback({
      source: 'verify',
      failedCommand: undefined,
      truncatedOutput: undefined,
    });
    expect(result).toContain('(unknown)');
  });
});
