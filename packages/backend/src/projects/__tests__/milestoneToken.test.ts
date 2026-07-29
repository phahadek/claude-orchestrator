/**
 * Tests for extractMilestoneToken — the leading M<n> token parse used to
 * derive canonical_short_id at registration time (ProjectService) and by
 * the token-first backfill/re-backfill migrations in schema.ts.
 */

import { describe, it, expect } from 'vitest';
import { extractMilestoneToken } from '../milestoneToken.js';

describe('extractMilestoneToken', () => {
  it('extracts the token from a full Notion title', () => {
    expect(extractMilestoneToken('M11 — Orchestrator-Owned Planning')).toBe(
      'M11',
    );
  });

  it('extracts the token from a name with trailing whitespace', () => {
    expect(extractMilestoneToken('M8 ')).toBe('M8');
  });

  it('extracts a lowercase token', () => {
    expect(extractMilestoneToken('m7')).toBe('m7');
  });

  it('returns undefined for a name with no leading M<n> token', () => {
    expect(extractMilestoneToken('MVP')).toBeUndefined();
  });
});
