import { describe, it, expect } from 'vitest';
import {
  formatApprovedVerdictMessage,
  formatReviewFeedback,
} from '../github/reviewUtils';
import type { PRReviewResult } from '../github/PRReviewService';

const makeResult = (
  overrides: Partial<PRReviewResult> = {},
): PRReviewResult => ({
  prNumber: 42,
  repo: 'owner/repo',
  verdict: 'approved',
  summary: 'Looks great, all criteria met.',
  dimensions: [],
  ...overrides,
});

// ── formatApprovedVerdictMessage ──────────────────────────────────────────────
describe('formatApprovedVerdictMessage()', () => {
  it('contains the ✅ Approved heading', () => {
    const msg = formatApprovedVerdictMessage(makeResult());
    expect(msg).toContain('✅ Approved');
  });

  it('contains the result summary', () => {
    const result = makeResult({ summary: 'Everything is perfect.' });
    const msg = formatApprovedVerdictMessage(result);
    expect(msg).toContain('Everything is perfect.');
  });

  it('contains "no action needed" guidance', () => {
    const msg = formatApprovedVerdictMessage(makeResult());
    expect(msg.toLowerCase()).toContain('no action needed');
  });

  it('mentions auto-merge is in progress', () => {
    const msg = formatApprovedVerdictMessage(makeResult());
    expect(msg.toLowerCase()).toContain('auto-merge');
  });
});

// ── formatReviewFeedback (existing, regression guard) ────────────────────────
describe('formatReviewFeedback()', () => {
  it('includes verdict and iteration for needs_changes', () => {
    const result = makeResult({
      verdict: 'needs_changes',
      summary: 'Fix the lint errors.',
      dimensions: [
        { name: 'Lint', passed: false, notes: 'ESLint errors found' },
      ],
    });
    const msg = formatReviewFeedback(result, 2);
    expect(msg).toContain('Iteration 2');
    expect(msg).toContain('Needs changes');
    expect(msg).toContain('ESLint errors found');
    expect(msg).toContain('Fix the lint errors.');
  });

  it('includes verdict for incomplete', () => {
    const result = makeResult({
      verdict: 'incomplete',
      summary: 'Missing tests.',
    });
    const msg = formatReviewFeedback(result, 1);
    expect(msg).toContain('Incomplete');
    expect(msg).toContain('Missing tests.');
  });
});
