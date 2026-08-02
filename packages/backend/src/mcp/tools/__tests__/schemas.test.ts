/**
 * Tests for groomingGateEntrySchema's hasOperationalSeedSection /
 * seedContributionCandidates / gateContributionCandidates fields — until
 * these parse, the whole seed_contribution / gate_contribution candidate
 * triage mechanism is unreachable via the MCP tool surface regardless of
 * which sibling task lands its content-match/classification-data-model piece.
 */

import { describe, it, expect } from 'vitest';
import { groomingGateEntrySchema } from '../schemas';

describe('groomingGateEntrySchema', () => {
  it('accepts hasOperationalSeedSection as a boolean', () => {
    const result = groomingGateEntrySchema.safeParse({
      hasOperationalSeedSection: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts seedContributionCandidates with the locked enum values', () => {
    const result = groomingGateEntrySchema.safeParse({
      seedContributionCandidates: [
        {
          spec: 'analyzer_configs row for foo',
          classification: 'operational-seed',
        },
        { spec: 'cohort flag for bar', classification: 'in-pr' },
        { spec: 'unclear one', classification: 'needs-triage' },
        { spec: 'no classification yet' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a seedContributionCandidates classification outside the locked enum', () => {
    const result = groomingGateEntrySchema.safeParse({
      seedContributionCandidates: [
        { spec: 'foo', classification: 'runtime-observable' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('accepts gateContributionCandidates with the locked enum values', () => {
    const result = groomingGateEntrySchema.safeParse({
      gateContributionCandidates: [
        {
          text: 'launched session has read-only tool set',
          classification: 'runtime-observable',
        },
        {
          text: 'session runs on the planning model',
          classification: 'config-or-code-determined',
        },
        { text: 'unclear one', classification: 'needs-triage' },
        { text: 'no classification yet' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a gateContributionCandidates classification outside the locked enum', () => {
    const result = groomingGateEntrySchema.safeParse({
      gateContributionCandidates: [
        { text: 'foo', classification: 'operational-seed' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('still accepts an entry with none of the new fields', () => {
    const result = groomingGateEntrySchema.safeParse({ type: '💻 Code' });
    expect(result.success).toBe(true);
  });
});
