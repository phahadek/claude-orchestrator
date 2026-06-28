import { describe, it, expect } from 'vitest';
import { shouldAutoReview, formatCIFailureFeedback, CI_LOG_EXCERPT_CAP } from './reviewUtils';

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
    // Multi-line log exceeding CI_LOG_EXCERPT_CAP (4000) — realistic CI output shape
    const longLog = Array.from({ length: 100 }, (_, i) => `line ${i}: ${'x'.repeat(50)}`).join('\n');
    // ~5800 chars total, well above 4000 cap
    const result = formatCIFailureFeedback({
      prNumber: 42,
      failingCheckNames: ['lint'],
      runUrl: null,
      logExcerpt: longLog,
    });
    expect(result).toContain('… [');
    expect(result).toContain('lines omitted');
  });

  it('keeps the failing tail of a long log where the error lives at the end', () => {
    const passingLines = 'test_foo PASSED\n'.repeat(300); // ~4800 chars of passing output
    const errorTail =
      'FAILED: test_bar - AssertionError\n' +
      'AssertionError: assert 1 == 2\n' +
      '  File "test_bar.py", line 10\n' +
      '1 failed, 300 passed in 2.50s\n';
    const longLog = passingLines + errorTail;

    const result = formatCIFailureFeedback({
      prNumber: 42,
      failingCheckNames: ['tests'],
      runUrl: null,
      logExcerpt: longLog,
    });

    expect(result).toContain('FAILED: test_bar');
    expect(result).toContain('1 failed, 300 passed');
  });

  it('elision marker reports omitted line count and omits content from the middle not the tail', () => {
    // 5 identifiable head lines, then a unique middle marker close to the head,
    // then a large filler to push the total well past CI_LOG_EXCERPT_CAP (4000),
    // then an identifiable tail error at the very end.
    const headLines = Array.from({ length: 5 }, (_, i) => `context line ${i + 1}`).join('\n');
    const uniqueMiddleMarker = 'UNIQUE_MIDDLE_OMIT_XYZ';
    const filler = 'filler\n'.repeat(700); // ~4900 chars — pushes total far past cap
    const errorTail = 'UNIQUE_TAIL_ERROR_ABC\nAssertionError: failed\n';
    const log = headLines + '\n' + uniqueMiddleMarker + '\n' + filler + errorTail;

    const result = formatCIFailureFeedback({
      prNumber: 42,
      failingCheckNames: ['tests'],
      runUrl: null,
      logExcerpt: log,
    });

    // Elision marker is present with a line count
    expect(result).toMatch(/… \[\d+ lines? omitted\] …/);
    // Head context is preserved
    expect(result).toContain('context line 1');
    // Tail error is preserved
    expect(result).toContain('UNIQUE_TAIL_ERROR_ABC');
    // Middle marker (right after head) falls in the omitted section — must not appear
    expect(result).not.toContain(uniqueMiddleMarker);
  });

  it('CI_LOG_EXCERPT_CAP is 4000', () => {
    expect(CI_LOG_EXCERPT_CAP).toBe(4000);
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
