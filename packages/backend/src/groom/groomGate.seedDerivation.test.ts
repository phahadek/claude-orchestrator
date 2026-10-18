import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import {
  checkGroomingPromotionGate,
  type GroomingGateEntry,
} from './groomGate';
import { recordAccretionMarker as recordSeedAccretionMarker } from '../seed/seedStore';

const LINE =
  'Seed a metric_sample_threshold rule on riot_val_auth_failures_consecutive through the audited config path.';

function body(extra: string, seedSection = ''): string {
  return `## Summary\nx\n\n## Context\n${extra}\n\n${seedSection}`;
}

function record(taskId: string, decision: 'none' | 'n/a' | 'seeds') {
  recordSeedAccretionMarker({
    sourceTaskId: taskId,
    project: 'p',
    milestone: 'M1',
    decision,
    accretedAt: new Date(0).toISOString(),
  });
}

async function seedReasons(
  taskId: string,
  taskBody: string,
  candidates?: GroomingGateEntry['seedContributionCandidates'],
) {
  const entry: GroomingGateEntry = {
    size_check: { decision: 'n/a' },
    type_check: { decision: 'none' },
    seam_check: { decision: 'n/a' },
    type: '💻 Code',
    seedContributionCandidates: candidates,
  };
  const result = await checkGroomingPromotionGate(
    entry,
    taskId,
    '💻 Code',
    { skipGateContributionCheck: true },
    undefined,
    taskBody,
  );
  return result.reasons.filter((r) => r.includes('seed_contribution'));
}

beforeEach(() => {
  db.prepare('DELETE FROM seed_accretion').run();
});

describe('server-side seed candidate derivation', () => {
  it('blocks a none decision when Context declares a seed with no Operational seed heading', async () => {
    record('t1', 'none');
    const reasons = await seedReasons('t1', body(LINE));
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('riot_val_auth_failures_consecutive');
  });

  it('passes once the line is classified', async () => {
    record('t2', 'none');
    for (const classification of ['in-pr', 'needs-triage'] as const) {
      const reasons = await seedReasons('t2', body(LINE), [
        { spec: LINE, classification },
      ]);
      expect(reasons).toEqual([]);
    }
  });

  it('does not block when the decision is seeds', async () => {
    record('t3', 'seeds');
    expect(await seedReasons('t3', body(LINE))).toEqual([]);
  });

  it('blocks None. Operational seed plus an AC bullet declaring a data_invariants row', async () => {
    record('t4', 'none');
    const b = body(
      '- Add a data_invariants row `riot_val_freshness` checking staleness.',
      '## Operational seed\nNone.\n',
    );
    const reasons = await seedReasons('t4', b);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('riot_val_freshness');
  });

  it('passes a body with no seed-shaped lines', async () => {
    record('t5', 'none');
    const b = body('Refactor the parser.', '## Operational seed\nNone.\n');
    expect(await seedReasons('t5', b)).toEqual([]);
  });
});
