import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { checkGroomingPromotionGate } from '../groomGate';
import { recordAccretionMarker } from '../../gate/gateStore';
import { recordAccretionMarker as recordSeedAccretionMarker } from '../../seed/seedStore';

beforeEach(() => {
  db.prepare('DELETE FROM gate_accretion').run();
  db.prepare('DELETE FROM seed_accretion').run();
});

describe('checkGroomingPromotionGate', () => {
  it('rejects a Ready flip whose type_check is absent', () => {
    const result = checkGroomingPromotionGate(
      {
        size_check: { decision: 'n/a' },
        type_check: null,
      },
      'notion:t1',
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('type_check'))).toBe(true);
  });

  it('rejects a Ready flip whose type_check is flagged but undispositioned', () => {
    const result = checkGroomingPromotionGate(
      {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'flagged', signals: ['api key'] },
      },
      'notion:t2',
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('type_check'))).toBe(true);
  });

  it('accepts a Ready flip with type_check {decision: "none"}', () => {
    const result = checkGroomingPromotionGate(
      {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'none' },
      },
      'notion:t3',
    );
    expect(result.allowed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('accepts a Ready flip with a recorded disposition for a flagged type_check', () => {
    const result = checkGroomingPromotionGate(
      {
        size_check: { decision: 'no_split' },
        type_check: {
          decision: 'flagged',
          signals: ['api key'],
          disposition: 'split-filed:38b22f91-52f3-8146',
        },
      },
      'notion:t4',
    );
    expect(result.allowed).toBe(true);
  });

  it('still rejects when size_check is missing, independent of type_check', () => {
    const result = checkGroomingPromotionGate(
      {
        size_check: null,
        type_check: { decision: 'none' },
      },
      'notion:t5',
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('size_check'))).toBe(true);
  });

  it('blocks a Code-task Ready flip with no gate_accretion marker', () => {
    const result = checkGroomingPromotionGate(
      {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'none' },
        type: '💻 Code',
      },
      'notion:no-marker',
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('gate_contribution'))).toBe(
      true,
    );
  });

  it('allows a Code-task Ready flip whose marker decision is "items"', () => {
    recordAccretionMarker({
      sourceTaskId: 'notion:has-items',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'items',
      accretedAt: new Date(0).toISOString(),
    });
    recordSeedAccretionMarker({
      sourceTaskId: 'notion:has-items',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'n/a',
      accretedAt: new Date(0).toISOString(),
    });
    const result = checkGroomingPromotionGate(
      {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'none' },
        type: '💻 Code',
      },
      'notion:has-items',
    );
    expect(result.allowed).toBe(true);
  });

  it('allows a Tooling-task Ready flip whose marker decision is "none"', () => {
    recordAccretionMarker({
      sourceTaskId: 'notion:no-items',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'none',
      accretedAt: new Date(0).toISOString(),
    });
    recordSeedAccretionMarker({
      sourceTaskId: 'notion:no-items',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'none',
      accretedAt: new Date(0).toISOString(),
    });
    const result = checkGroomingPromotionGate(
      {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'none' },
        type: '🛠️ Tooling',
      },
      'notion:no-items',
    );
    expect(result.allowed).toBe(true);
  });

  it('allows a Design-task Ready flip with no marker at all (type not gate-checked)', () => {
    const result = checkGroomingPromotionGate(
      {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'n/a' },
        type: '📐 Design',
      },
      'notion:design-task',
    );
    expect(result.allowed).toBe(true);
  });
});

describe('checkGroomingPromotionGate — seed_contribution', () => {
  it('blocks a seed-carrying Code-task Ready flip with no seed_accretion marker', () => {
    recordAccretionMarker({
      sourceTaskId: 'notion:no-seed-marker',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'n/a',
      accretedAt: new Date(0).toISOString(),
    });
    const result = checkGroomingPromotionGate(
      {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'none' },
        type: '💻 Code',
      },
      'notion:no-seed-marker',
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('seed_contribution'))).toBe(
      true,
    );
  });

  it('allows a Code-task Ready flip whose seed marker decision is "seeds"', () => {
    recordAccretionMarker({
      sourceTaskId: 'notion:has-seeds',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'n/a',
      accretedAt: new Date(0).toISOString(),
    });
    recordSeedAccretionMarker({
      sourceTaskId: 'notion:has-seeds',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'seeds',
      accretedAt: new Date(0).toISOString(),
    });
    const result = checkGroomingPromotionGate(
      {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'none' },
        type: '💻 Code',
      },
      'notion:has-seeds',
    );
    expect(result.allowed).toBe(true);
  });

  it('allows a Tooling-task Ready flip whose seed marker decision is "none"', () => {
    recordAccretionMarker({
      sourceTaskId: 'notion:no-seed-items',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'n/a',
      accretedAt: new Date(0).toISOString(),
    });
    recordSeedAccretionMarker({
      sourceTaskId: 'notion:no-seed-items',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'none',
      accretedAt: new Date(0).toISOString(),
    });
    const result = checkGroomingPromotionGate(
      {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'none' },
        type: '🛠️ Tooling',
      },
      'notion:no-seed-items',
    );
    expect(result.allowed).toBe(true);
  });

  it('allows a Code-task Ready flip whose seed marker decision is "n/a"', () => {
    recordAccretionMarker({
      sourceTaskId: 'notion:na-seed',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'n/a',
      accretedAt: new Date(0).toISOString(),
    });
    recordSeedAccretionMarker({
      sourceTaskId: 'notion:na-seed',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'n/a',
      accretedAt: new Date(0).toISOString(),
    });
    const result = checkGroomingPromotionGate(
      {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'none' },
        type: '💻 Code',
      },
      'notion:na-seed',
    );
    expect(result.allowed).toBe(true);
  });

  it('allows a Design-task Ready flip with no seed marker at all (type not seed-checked)', () => {
    const result = checkGroomingPromotionGate(
      {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'n/a' },
        type: '📐 Design',
      },
      'notion:design-task-2',
    );
    expect(result.allowed).toBe(true);
  });
});
