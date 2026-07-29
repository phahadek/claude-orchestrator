/**
 * Tests for the flow_arm store (db/queries.ts): getArm falls back to
 * DEFAULT_ARM when no row exists, and upsertArm returns the previous
 * effective value for audit purposes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import { getArm, listArm, upsertArm } from '../queries.js';
import { DEFAULT_ARM } from '../../orchestration/flowArm.js';

beforeEach(() => {
  db.prepare('DELETE FROM flow_arm').run();
});

describe('DEFAULT_ARM', () => {
  it('arms groom and gate-verify, and leaves design and ops off', () => {
    expect(DEFAULT_ARM).toEqual({
      groom: true,
      'gate-verify': true,
      design: false,
      ops: false,
    });
  });
});

describe('getArm', () => {
  it('returns DEFAULT_ARM[flow] when no row exists', () => {
    expect(getArm('m1', 'groom')).toBe(true);
    expect(getArm('m1', 'design')).toBe(false);
  });

  it('returns the row value when present, overriding the default', () => {
    upsertArm('m1', 'design', true, 100);
    expect(getArm('m1', 'design')).toBe(true);

    upsertArm('m1', 'groom', false, 100);
    expect(getArm('m1', 'groom')).toBe(false);
  });
});

describe('listArm', () => {
  it('reports source as default for absent flows and row for set ones', () => {
    upsertArm('m1', 'ops', true, 100);

    const state = listArm('m1');
    expect(state.ops).toEqual({ armed: true, source: 'row' });
    expect(state.groom).toEqual({ armed: true, source: 'default' });
    expect(state.design).toEqual({ armed: false, source: 'default' });
    expect(state['gate-verify']).toEqual({ armed: true, source: 'default' });
  });
});

describe('upsertArm', () => {
  it('inserts a new row and returns the prior default as previous', () => {
    const { previous } = upsertArm('m1', 'groom', false, 100);
    expect(previous).toBe(true);
    expect(getArm('m1', 'groom')).toBe(false);
  });

  it('updates an existing row and returns its prior value as previous', () => {
    upsertArm('m1', 'groom', false, 100);
    const { previous } = upsertArm('m1', 'groom', true, 200);
    expect(previous).toBe(false);
    expect(getArm('m1', 'groom')).toBe(true);
  });
});
