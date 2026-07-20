/**
 * Tests for matchesPathDiff (packages/backend/src/deploy/pathDiffPredicate.ts).
 *
 * AC: the path-diff predicate matches globs against a diff for both step
 * changed_paths and companion trigger_paths — same shared helper either way.
 */

import { describe, it, expect } from 'vitest';
import { matchesPathDiff } from '../pathDiffPredicate';

describe('matchesPathDiff', () => {
  it('matches a step changed_paths glob against a diff', () => {
    const changedPaths = ['packages/backend/**'];
    const diff = ['packages/backend/src/deploy/loadPlaybook.ts'];
    expect(matchesPathDiff(changedPaths, diff)).toBe(true);
  });

  it('matches a companion trigger_paths glob against a diff', () => {
    const triggerPaths = ['packages/sidecar/**'];
    const diff = ['packages/frontend/src/App.tsx', 'packages/sidecar/main.py'];
    expect(matchesPathDiff(triggerPaths, diff)).toBe(true);
  });

  it('returns false when no diff path matches any glob', () => {
    const triggerPaths = ['packages/sidecar/**'];
    const diff = ['packages/frontend/src/App.tsx'];
    expect(matchesPathDiff(triggerPaths, diff)).toBe(false);
  });

  it('returns false for an empty glob list', () => {
    expect(matchesPathDiff([], ['packages/backend/src/foo.ts'])).toBe(false);
  });

  it('returns false for an empty diff', () => {
    expect(matchesPathDiff(['packages/backend/**'], [])).toBe(false);
  });

  it('matches an exact file glob', () => {
    expect(
      matchesPathDiff(['README.md'], ['README.md', 'packages/foo.ts']),
    ).toBe(true);
  });
});
