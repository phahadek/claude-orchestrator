/**
 * Tests for the selective-injection read module
 * (packages/backend/src/architecture/selectiveInjection.ts).
 *
 * AC: region-intersection returns region-matched units; invariants always
 * included; topic fallback for page-scoped sessions; superseded/deferred
 * excluded; a non-migrated project resolves to the Notion fallback and a
 * migrated one to the store.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { createUnit, supersedeUnit } from '../ArchUnitStore.js';
import type { ArchUnit } from '../ArchUnitStore.js';
import {
  selectUnitsFromStore,
  selectArchitectureContext,
} from '../selectiveInjection.js';

function unit(overrides: Partial<ArchUnit> & { id: string }): ArchUnit {
  return {
    title: overrides.id,
    kind: 'subsystem',
    topic: 'general',
    regions: [],
    status: 'active',
    body: 'body',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('selectUnitsFromStore', () => {
  it('returns units whose regions intersect the resolved regions', () => {
    const sessions = unit({
      id: 'sessions',
      regions: ['packages/backend/src/sessions'],
    });
    const unrelated = unit({
      id: 'unrelated',
      regions: ['packages/frontend/src/foo'],
    });
    const nested = unit({
      id: 'nested',
      regions: ['packages/backend/src/sessions/lifecycle.ts'],
    });

    const result = selectUnitsFromStore(
      { regions: { packages: ['packages/backend/src/sessions'] } },
      { queryActiveUnits: () => [sessions, unrelated, nested] },
    );

    expect(result.map((u) => u.id).sort()).toEqual(['nested', 'sessions']);
  });

  it('always includes active invariants regardless of region match', () => {
    const invariant = unit({
      id: 'inv-1',
      kind: 'invariant',
      regions: ['packages/frontend/src/foo'],
    });
    const matched = unit({
      id: 'matched',
      regions: ['packages/backend/src/sessions'],
    });

    const result = selectUnitsFromStore(
      { regions: { packages: ['packages/backend/src/sessions'] } },
      { queryActiveUnits: () => [invariant, matched] },
    );

    expect(result.map((u) => u.id).sort()).toEqual(['inv-1', 'matched']);
  });

  it('falls back to topic match when the session has no file scope', () => {
    const sameTopic = unit({ id: 'a', topic: 'design-signoff' });
    const otherTopic = unit({ id: 'b', topic: 'sessions' });

    const result = selectUnitsFromStore(
      { topic: 'design-signoff' },
      { queryActiveUnits: () => [sameTopic, otherTopic] },
    );

    expect(result.map((u) => u.id)).toEqual(['a']);
  });

  it('does not apply topic fallback when regions are present', () => {
    const sameTopic = unit({
      id: 'a',
      topic: 'design-signoff',
      regions: ['packages/frontend'],
    });

    const result = selectUnitsFromStore(
      {
        topic: 'design-signoff',
        regions: { packages: ['packages/backend'] },
      },
      { queryActiveUnits: () => [sameTopic] },
    );

    expect(result).toEqual([]);
  });
});

describe('selectUnitsFromStore against the real arch_unit store', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM arch_unit_event').run();
    db.prepare('DELETE FROM arch_unit').run();
    db.prepare('DELETE FROM audit_log').run();
  });

  it('excludes superseded and deferred units via the default active-only query', () => {
    createUnit({
      title: 'Always-on invariant',
      kind: 'invariant',
      topic: 'general',
      regions: [],
      body: 'body',
      at: '2026-01-01T00:00:00Z',
    });
    const toSupersede = createUnit({
      title: 'Old subsystem note',
      kind: 'subsystem',
      topic: 'sessions',
      regions: ['packages/backend/src/sessions'],
      body: 'body',
      at: '2026-01-01T00:00:00Z',
    });
    supersedeUnit(
      toSupersede.id,
      {
        title: 'New subsystem note',
        kind: 'subsystem',
        topic: 'sessions',
        regions: ['packages/backend/src/sessions'],
        body: 'body',
        at: '2026-01-02T00:00:00Z',
      },
      '2026-01-02T00:00:00Z',
    );
    const deferred = createUnit({
      title: 'Deferred idea',
      kind: 'subsystem',
      topic: 'sessions',
      regions: ['packages/backend/src/sessions'],
      status: 'deferred',
      body: 'body',
      at: '2026-01-01T00:00:00Z',
    });

    const result = selectUnitsFromStore({
      regions: { packages: ['packages/backend/src/sessions'] },
    });

    const titles = result.map((u) => u.title);
    expect(titles).toContain('Always-on invariant');
    expect(titles).toContain('New subsystem note');
    expect(titles).not.toContain('Old subsystem note');
    expect(titles).not.toContain('Deferred idea');
    expect(result.some((u) => u.id === deferred.id)).toBe(false);
  });
});

describe('selectArchitectureContext (dual-read)', () => {
  it('resolves a migrated project to the arch_unit store', async () => {
    const storeUnit = unit({ id: 'a', kind: 'invariant' });
    const result = await selectArchitectureContext(
      { projectId: 'proj-1' },
      {
        isArchStoreAdopted: () => true,
        queryActiveUnits: () => [storeUnit],
        fetchNotionArchitecturePages: async () => {
          throw new Error('should not be called for a migrated project');
        },
      },
    );

    expect(result.source).toBe('store');
    expect(result.source === 'store' && result.units.map((u) => u.id)).toEqual([
      'a',
    ]);
  });

  it('resolves a non-migrated project to the Notion fallback', async () => {
    const pages = [
      { id: 'p1', title: 'Technical Architecture', markdown: '# x' },
    ];
    const result = await selectArchitectureContext(
      { projectId: 'proj-2' },
      {
        isArchStoreAdopted: () => false,
        queryActiveUnits: () => {
          throw new Error('should not be called for a non-migrated project');
        },
        fetchNotionArchitecturePages: async () => pages,
      },
    );

    expect(result.source).toBe('notion');
    expect(result.source === 'notion' && result.pages).toEqual(pages);
  });
});
