import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../projects/ProjectService', () => ({
  ProjectService: {
    getById: (id: string) => {
      if (id !== 'polimarket-analyser') return undefined;
      return {
        id,
        milestones: [{ id: 'M12', name: 'M12', canonicalShortId: 'M12' }],
      };
    },
  },
}));

import { db } from '../../db/db.js';
import {
  checkGroomingPromotionGate,
  checkAccretionContributions,
} from '../groomGate';
import { recordAccretionMarker } from '../../gate/gateStore';
import { recordAccretionMarker as recordSeedAccretionMarker } from '../../seed/seedStore';
import { BackendTaskWriteCommands } from '../../tasks/TaskWriteCommands';
import type { TaskBackend } from '../../tasks/TaskBackend';

function makeBackend(): TaskBackend {
  return {
    type: 'notion',
    fetchReadyTasks: vi.fn(),
    attachPR: vi.fn(),
    updateStatus: vi.fn(),
    fetchTaskPage: vi.fn(),
    fetchNonMilestoneReadyTasks: vi.fn(),
    updateNotes: vi.fn(),
    appendImplementationNote: vi.fn(),
    listTasksByStatus: vi.fn(),
  };
}

beforeEach(() => {
  db.prepare('DELETE FROM gate_accretion').run();
  db.prepare('DELETE FROM seed_accretion').run();
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM seed_item').run();
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
        filesPathsEntries: [
          {
            raw: 'packages/backend/src/checkout.ts *(new)*',
            isNew: true,
            existsInRepo: false,
          },
        ],
      },
      'notion:has-items',
    );
    expect(result.allowed).toBe(true);
  });

  it('retired 🛠️ Tooling no longer requires a gate_accretion marker — fails open with none recorded', () => {
    const result = checkGroomingPromotionGate(
      {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'none' },
        type: '🛠️ Tooling',
      },
      'notion:tooling-retired-gate',
    );
    expect(result.allowed).toBe(true);
    expect(result.reasons.some((r) => r.includes('gate_contribution'))).toBe(
      false,
    );
  });

  it('allows a Design-task Ready flip with no marker at all (type not gate-checked)', () => {
    const result = checkGroomingPromotionGate(
      {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'n/a' },
        type: '📐 Design',
        triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: true },
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
      reason: 'This task type is exempt from gate accretion.',
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
        filesPathsEntries: [
          {
            raw: 'packages/backend/src/checkout.ts *(new)*',
            isNew: true,
            existsInRepo: false,
          },
        ],
      },
      'notion:has-seeds',
    );
    expect(result.allowed).toBe(true);
  });

  it('retired 🛠️ Tooling no longer requires a seed_accretion marker — fails open with none recorded', () => {
    const result = checkGroomingPromotionGate(
      {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'none' },
        type: '🛠️ Tooling',
      },
      'notion:tooling-retired-seed',
    );
    expect(result.allowed).toBe(true);
    expect(result.reasons.some((r) => r.includes('seed_contribution'))).toBe(
      false,
    );
  });

  it('allows a Code-task Ready flip whose seed marker decision is "n/a"', () => {
    recordAccretionMarker({
      sourceTaskId: 'notion:na-seed',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'n/a',
      reason: 'This task type is exempt from gate accretion.',
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
        filesPathsEntries: [
          {
            raw: 'packages/backend/src/checkout.ts *(new)*',
            isNew: true,
            existsInRepo: false,
          },
        ],
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
        triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: true },
      },
      'notion:design-task-2',
    );
    expect(result.allowed).toBe(true);
  });
});

describe('checkGroomingPromotionGate — via the accretion write-surface', () => {
  it('blocks a Code-task Ready flip before accretion runs, and allows it once accreteGateContribution/stageSeedContribution have written their markers', async () => {
    const commands = new BackendTaskWriteCommands(makeBackend());
    const sourceTask = {
      id: 'notion:accreted',
      title: 'Add retry to checkout',
      project: 'polimarket-analyser',
      milestone: 'M12',
    };
    const entry = {
      size_check: { decision: 'n/a' },
      type_check: { decision: 'none' },
      type: '💻 Code',
      filesPathsEntries: [
        {
          raw: 'packages/backend/src/checkout.ts *(new)*',
          isNew: true,
          existsInRepo: false,
        },
      ],
    };

    expect(checkGroomingPromotionGate(entry, sourceTask.id).allowed).toBe(
      false,
    );

    await commands.accreteGateContribution(
      sourceTask,
      [{ text: 'Click through checkout once' }],
      'Read-Only',
    );
    // gate_contribution now recorded, but seed_contribution is still missing.
    expect(checkGroomingPromotionGate(entry, sourceTask.id).allowed).toBe(
      false,
    );

    await commands.stageSeedContribution(sourceTask, [], 'none');

    const result = checkGroomingPromotionGate(entry, sourceTask.id);
    expect(result.allowed).toBe(true);
    expect(result.reasons).toEqual([]);
  });
});

describe('checkGroomingPromotionGate — FM1 bindingConstraints', () => {
  // A 📐 Design task is exempt from gate/seed accretion, isolating the
  // binding-constraint check from the other artifacts.
  const BASE = {
    size_check: { decision: 'n/a' },
    type_check: { decision: 'n/a' },
    type: '📐 Design',
  };

  it('blocks promotion when a region-derived binding constraint has no recorded disposition', () => {
    const result = checkGroomingPromotionGate(
      {
        ...BASE,
        regions: { packages: ['packages/backend/src/gate'], files: [] },
      },
      'notion:fm1-undispositioned',
    );
    expect(result.allowed).toBe(false);
    expect(
      result.reasons.some((r) => r.includes('gate-accretion-durable')),
    ).toBe(true);
  });

  it('allows promotion once every region-derived binding constraint is dispositioned', () => {
    const result = checkGroomingPromotionGate(
      {
        ...BASE,
        regions: { packages: ['packages/backend/src/gate'], files: [] },
        constraintsDispositioned: {
          'gate-accretion-durable': { disposition: 'complies' },
        },
        triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: true },
      },
      'notion:fm1-dispositioned',
    );
    expect(result.allowed).toBe(true);
  });

  it('blocks promotion when a disposition is n/a without a reason', () => {
    const result = checkGroomingPromotionGate(
      {
        ...BASE,
        regions: { packages: ['packages/backend/src/gate'], files: [] },
        constraintsDispositioned: {
          'gate-accretion-durable': { disposition: 'n/a', why: '' },
        },
      },
      'notion:fm1-na-no-reason',
    );
    expect(result.allowed).toBe(false);
  });

  it('blocks an unrouted conflict→route disposition', () => {
    const result = checkGroomingPromotionGate(
      {
        ...BASE,
        regions: { packages: ['packages/backend/src/gate'], files: [] },
        constraintsDispositioned: {
          'gate-accretion-durable': {
            disposition: 'conflict_route',
            routedTaskId: '',
          },
        },
      },
      'notion:fm1-unrouted',
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('conflict→route'))).toBe(true);
  });

  it("routes a conflict→route disposition through FM1, but approve-by-standard's triage floor still forces this interactive task out of clean", () => {
    const result = checkGroomingPromotionGate(
      {
        ...BASE,
        regions: { packages: ['packages/backend/src/gate'], files: [] },
        constraintsDispositioned: {
          'gate-accretion-durable': {
            disposition: 'conflict_route',
            routedTaskId: 'design-task-1',
          },
        },
        dependsOnTasks: [
          { id: 'design-task-1', type: '📐 Design', status: '✅ Done' },
        ],
        triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: true },
      },
      'notion:fm1-routed',
    );
    // FM1's per-constraint disposition check accepts the routing on its own...
    expect(result.reasons.some((r) => r.includes('conflict→route'))).toBe(
      false,
    );
    // ...but a routed constraint-conflict still force-downgrades this
    // interactive task's triage verdict out of 'clean' (planning/triage.ts),
    // so it does not promote on the routing alone.
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('triage verdict'))).toBe(true);
  });
});

describe('checkGroomingPromotionGate — FM2 resolve-in-artifact (Files/paths)', () => {
  const BASE = {
    size_check: { decision: 'n/a' },
    type_check: { decision: 'none' },
    type: '💻 Code',
  };

  beforeEach(() => {
    recordAccretionMarker({
      sourceTaskId: 'notion:fm2-task',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'n/a',
      reason: 'This task type is exempt from gate accretion.',
      accretedAt: new Date(0).toISOString(),
    });
    recordSeedAccretionMarker({
      sourceTaskId: 'notion:fm2-task',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'n/a',
      accretedAt: new Date(0).toISOString(),
    });
  });

  it('blocks a Code task with no Files/paths entries', () => {
    const result = checkGroomingPromotionGate(
      { ...BASE, filesPathsEntries: [] },
      'notion:fm2-task',
    );
    expect(result.allowed).toBe(false);
  });

  it('blocks a Code task whose Files/paths entry contains a hedge token', () => {
    const result = checkGroomingPromotionGate(
      {
        ...BASE,
        filesPathsEntries: [
          {
            raw: 'packages/backend/src/checkout.ts and/or its tests',
            isNew: false,
            existsInRepo: true,
          },
        ],
      },
      'notion:fm2-task',
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('hedge token'))).toBe(true);
  });

  it('blocks a Code task whose Files/paths entry does not resolve and is not marked *(new)*', () => {
    const result = checkGroomingPromotionGate(
      {
        ...BASE,
        filesPathsEntries: [
          {
            raw: 'packages/backend/src/nonexistent.ts',
            isNew: false,
            existsInRepo: false,
          },
        ],
      },
      'notion:fm2-task',
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('does not resolve'))).toBe(
      true,
    );
  });

  it('allows a Code task whose Files/paths entries are all existing or *(new)*', () => {
    const result = checkGroomingPromotionGate(
      {
        ...BASE,
        filesPathsEntries: [
          {
            raw: 'packages/backend/src/checkout.ts',
            isNew: false,
            existsInRepo: true,
          },
          {
            raw: 'packages/backend/src/checkoutRetry.ts *(new)*',
            isNew: true,
            existsInRepo: false,
          },
        ],
      },
      'notion:fm2-task',
    );
    expect(result.allowed).toBe(true);
  });

  it('does not apply the Files/paths check to non-Code types', () => {
    const result = checkGroomingPromotionGate(
      {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'n/a' },
        type: '📐 Design',
        triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: true },
      },
      'notion:fm2-non-code',
    );
    expect(result.allowed).toBe(true);
  });
});

describe('checkGroomingPromotionGate — FM3 Design/Planning Depends On liveness', () => {
  const BASE = {
    size_check: { decision: 'n/a' },
    type_check: { decision: 'n/a' },
    type: '📐 Design',
    triage: {
      proposedVerdict: 'clean' as const,
      hasOpenQuestionsHeading: true,
    },
  };

  it('blocks promotion when Depends On carries a non-Done 📐 Design task', () => {
    const result = checkGroomingPromotionGate(
      {
        ...BASE,
        dependsOnTasks: [
          { id: 'dep-1', type: '📐 Design', status: '🔲 Backlog' },
        ],
      },
      'notion:fm3-blocked',
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('dep-1'))).toBe(true);
  });

  it('blocks promotion when Depends On carries a non-Done 📋 Planning task', () => {
    const result = checkGroomingPromotionGate(
      {
        ...BASE,
        dependsOnTasks: [
          { id: 'dep-2', type: '📋 Planning', status: '🗂️ Ready' },
        ],
      },
      'notion:fm3-blocked-planning',
    );
    expect(result.allowed).toBe(false);
  });

  it('allows promotion once the Design Depends On task is ✅ Done', () => {
    const result = checkGroomingPromotionGate(
      {
        ...BASE,
        dependsOnTasks: [{ id: 'dep-1', type: '📐 Design', status: '✅ Done' }],
      },
      'notion:fm3-cleared',
    );
    expect(result.allowed).toBe(true);
  });

  it('does not block on a non-Design/Planning Depends On task regardless of status', () => {
    const result = checkGroomingPromotionGate(
      {
        ...BASE,
        dependsOnTasks: [
          { id: 'dep-3', type: '💻 Code', status: '🔲 Backlog' },
        ],
      },
      'notion:fm3-unaffected',
    );
    expect(result.allowed).toBe(true);
  });

  it('still enforces the rest of the readiness bar for a task with an unsatisfied non-design dependency', () => {
    const result = checkGroomingPromotionGate(
      {
        ...BASE,
        type: '💻 Code',
        size_check: undefined,
        dependsOnTasks: [
          { id: 'dep-3', type: '💻 Code', status: '🔲 Backlog' },
        ],
      },
      'notion:fm3-unaffected-but-not-ready',
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('size_check'))).toBe(true);
  });
});

describe('checkGroomingPromotionGate — triage eligibility (approve-by-standard type gate)', () => {
  const cleanEntry = (type: string) => ({
    size_check: { decision: 'n/a' },
    type_check: { decision: 'n/a' },
    type,
    triage: {
      proposedVerdict: 'clean' as const,
      hasOpenQuestionsHeading: true,
    },
  });

  it('rejects a 💻 Code task carrying a triage verdict, naming the type as the reason', () => {
    const result = checkGroomingPromotionGate(
      cleanEntry('💻 Code'),
      'notion:triage-ineligible-code',
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('💻 Code'))).toBe(true);
  });

  it('rejects a 🔎 Investigation task carrying a triage verdict', () => {
    const result = checkGroomingPromotionGate(
      cleanEntry('🔎 Investigation'),
      'notion:triage-ineligible-investigation',
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('🔎 Investigation'))).toBe(
      true,
    );
  });

  it('rejects a 🔧 Operational task carrying a triage verdict', () => {
    const result = checkGroomingPromotionGate(
      cleanEntry('🔧 Operational'),
      'notion:triage-ineligible-operational',
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('🔧 Operational'))).toBe(
      true,
    );
  });

  it('allows a 📐 Design task carrying a triage verdict', () => {
    const result = checkGroomingPromotionGate(
      cleanEntry('📐 Design'),
      'notion:triage-eligible-design',
    );
    expect(result.allowed).toBe(true);
  });

  it('allows a 📋 Planning task carrying a triage verdict', () => {
    const result = checkGroomingPromotionGate(
      cleanEntry('📋 Planning'),
      'notion:triage-eligible-planning',
    );
    expect(result.allowed).toBe(true);
  });

  it('resolves eligibility from the authoritative type, rejecting even when the payload asserts an eligible type', () => {
    const result = checkGroomingPromotionGate(
      cleanEntry('📐 Design'),
      'notion:triage-authoritative-mismatch',
      '💻 Code',
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('💻 Code'))).toBe(true);
  });
});

describe('checkAccretionContributions', () => {
  it('surfaces both reasons for a Code task with neither marker recorded', () => {
    const result = checkAccretionContributions(
      { type: '💻 Code' },
      'notion:accretion-none',
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('gate_contribution'))).toBe(
      true,
    );
    expect(result.reasons.some((r) => r.includes('seed_contribution'))).toBe(
      true,
    );
  });

  it('allows a Code task once both markers are recorded', () => {
    recordAccretionMarker({
      sourceTaskId: 'notion:accretion-both',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'n/a',
      reason: 'This task type is exempt from gate accretion.',
      accretedAt: new Date(0).toISOString(),
    });
    recordSeedAccretionMarker({
      sourceTaskId: 'notion:accretion-both',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'n/a',
      accretedAt: new Date(0).toISOString(),
    });
    const result = checkAccretionContributions(
      { type: '💻 Code' },
      'notion:accretion-both',
    );
    expect(result.allowed).toBe(true);
  });

  it('blocks a Code task whose gate marker records a bare "n/a" with no reason', () => {
    recordAccretionMarker({
      sourceTaskId: 'notion:accretion-bare-na',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'n/a',
      accretedAt: new Date(0).toISOString(),
    });
    recordSeedAccretionMarker({
      sourceTaskId: 'notion:accretion-bare-na',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'n/a',
      accretedAt: new Date(0).toISOString(),
    });
    const result = checkAccretionContributions(
      { type: '💻 Code' },
      'notion:accretion-bare-na',
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('substantive reason'))).toBe(
      true,
    );
  });

  it('fails open for a retired 🛠️ Tooling task with no markers', () => {
    const result = checkAccretionContributions(
      { type: '🛠️ Tooling' },
      'notion:accretion-tooling',
    );
    expect(result.allowed).toBe(true);
  });
});

describe('checkGroomingPromotionGate — gate_contribution per-candidate triage', () => {
  it('blocks a Ready flip whose gate_contribution omits a classification for a candidate', () => {
    recordAccretionMarker({
      sourceTaskId: 'notion:candidate-unclassified',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'items',
      accretedAt: new Date(0).toISOString(),
    });
    recordSeedAccretionMarker({
      sourceTaskId: 'notion:candidate-unclassified',
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
        filesPathsEntries: [
          { raw: 'a.ts *(new)*', isNew: true, existsInRepo: false },
        ],
        gateContributionCandidates: [
          {
            text: 'launched session has read-only tool set',
            classification: 'runtime-observable',
          },
          { text: 'session runs on the planning model' },
        ],
      },
      'notion:candidate-unclassified',
    );
    expect(result.allowed).toBe(false);
    expect(
      result.reasons.some((r) => r.includes('has no recorded classification')),
    ).toBe(true);
  });

  it('accepts any recorded classification without judging its content', () => {
    recordAccretionMarker({
      sourceTaskId: 'notion:candidate-classified',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'items',
      accretedAt: new Date(0).toISOString(),
    });
    recordSeedAccretionMarker({
      sourceTaskId: 'notion:candidate-classified',
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
        filesPathsEntries: [
          { raw: 'a.ts *(new)*', isNew: true, existsInRepo: false },
        ],
        gateContributionCandidates: [
          { text: 'a', classification: 'runtime-observable' },
          { text: 'b', classification: 'config-or-code-determined' },
          { text: 'c', classification: 'needs-triage' },
        ],
      },
      'notion:candidate-classified',
    );
    expect(result.allowed).toBe(true);
  });

  it('a reasoned {"decision":"none"} contribution for a task with no Manual verification section still passes', () => {
    recordAccretionMarker({
      sourceTaskId: 'notion:candidate-none-section',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'none',
      reason:
        'The change only adds a pure formatting helper with no I/O or user-visible effect.',
      accretedAt: new Date(0).toISOString(),
    });
    recordSeedAccretionMarker({
      sourceTaskId: 'notion:candidate-none-section',
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
        filesPathsEntries: [
          { raw: 'a.ts *(new)*', isNew: true, existsInRepo: false },
        ],
        // No gateContributionCandidates recorded at all — there was no
        // Manual verification section to triage. Accretion no longer depends
        // on pre-authored candidate content; the marker's own reason carries
        // the groomer's independent assessment.
      },
      'notion:candidate-none-section',
    );
    expect(result.allowed).toBe(true);
  });

  it('a bare {"decision":"none"} contribution with no reason is rejected at the promotion gate', () => {
    recordAccretionMarker({
      sourceTaskId: 'notion:candidate-none-no-reason',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'none',
      accretedAt: new Date(0).toISOString(),
    });
    recordSeedAccretionMarker({
      sourceTaskId: 'notion:candidate-none-no-reason',
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
        filesPathsEntries: [
          { raw: 'a.ts *(new)*', isNew: true, existsInRepo: false },
        ],
      },
      'notion:candidate-none-no-reason',
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes('substantive reason'))).toBe(
      true,
    );
  });

  it('a Code promotion carrying accreted items succeeds regardless of pre-groom body content', () => {
    recordAccretionMarker({
      sourceTaskId: 'notion:items-no-precontent',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'items',
      accretedAt: new Date(0).toISOString(),
    });
    recordSeedAccretionMarker({
      sourceTaskId: 'notion:items-no-precontent',
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
        filesPathsEntries: [
          { raw: 'a.ts *(new)*', isNew: true, existsInRepo: false },
        ],
        // No gateContributionCandidates and no pre-groom Manual verification
        // section — the groomer independently found runtime-observable
        // behaviour and accreted it regardless.
      },
      'notion:items-no-precontent',
    );
    expect(result.allowed).toBe(true);
  });
});
