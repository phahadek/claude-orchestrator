/**
 * Drift guard: config-template/procedures.md is the universal rulebook every
 * projects-root session reads at SessionStart, so it must name every live
 * gate_item classification. This mirrors the parity shape used to keep the
 * gate.accrete tool surface and GATE_ITEM_TIER_SELECTION_GUIDANCE in sync —
 * adding or retiring a tier without updating the rulebook should fail here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GateItemClassification } from '../../db/types';

const GATE_ITEM_CLASSIFICATIONS: readonly GateItemClassification[] = [
  'Read-Only',
  'Prod-Mutating',
  'Human-Observation',
  'needs-triage',
];

const PROCEDURES_MD_PATH = join(
  __dirname,
  '../../../../../config-template/procedures.md',
);

describe('config-template/procedures.md gate-item classification parity', () => {
  const procedures = readFileSync(PROCEDURES_MD_PATH, 'utf8');

  it('names every member of the GateItemClassification union', () => {
    for (const classification of GATE_ITEM_CLASSIFICATIONS) {
      expect(procedures).toContain(classification);
    }
  });

  it('mentions the retired Opportunistic tier only in an explicit "retired" note', () => {
    const opportunisticLines = procedures
      .split('\n')
      .filter((line) => line.includes('Opportunistic'));

    expect(opportunisticLines.length).toBeGreaterThan(0);
    for (const line of opportunisticLines) {
      expect(line.toLowerCase()).toContain('retired');
    }
  });

  it('does not instruct a Prod-Mutating -> Opportunistic reclassification', () => {
    expect(procedures).not.toMatch(/Prod-Mutating.{0,40}Opportunistic/s);
  });

  it('documents not-yet-triggerable -> pending as non-blocking and evidence-mandatory', () => {
    expect(procedures).toContain('not-yet-triggerable');
    expect(procedures).toContain('pending');
    expect(procedures.toLowerCase()).toContain('non-blocking');
    expect(procedures).toMatch(
      /not-yet-triggerable.*evidence|evidence.*not-yet-triggerable/s,
    );
  });
});
