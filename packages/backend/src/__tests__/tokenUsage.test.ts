import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ── formatTokenCount ──────────────────────────────────────────────────────────

import { formatTokenCount, calculateCost } from '../utils/usage';

describe('calculateCost', () => {
  const cases: [string, number, number][] = [
    ['claude-opus-5', 5, 25],
    ['claude-opus-4-8', 5, 25],
    ['claude-opus-4-7', 5, 25],
    ['claude-sonnet-5', 3, 15],
    ['claude-sonnet-4-6', 3, 15],
    ['claude-haiku-4-5', 1, 5],
  ];

  it.each(cases)(
    'resolves published input/output rate for %s',
    (model, inputPerMillion, outputPerMillion) => {
      const cost = calculateCost(1_000_000, 1_000_000, model);
      expect(cost).toBeCloseTo(inputPerMillion + outputPerMillion);
    },
  );

  it('falls back to the documented (Sonnet) rate for an unknown model', () => {
    expect(() =>
      calculateCost(1_000_000, 1_000_000, 'some-unknown-model'),
    ).not.toThrow();
    const cost = calculateCost(1_000_000, 1_000_000, 'some-unknown-model');
    expect(cost).toBeCloseTo(3 + 15);
  });
});

describe('formatTokenCount', () => {
  it('formats numbers below 1000 as plain integers', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('formats thousands with k suffix (1 decimal)', () => {
    expect(formatTokenCount(1000)).toBe('1.0k');
    expect(formatTokenCount(1234)).toBe('1.2k');
    expect(formatTokenCount(999_999)).toBe('1000.0k');
  });

  it('formats millions with M suffix (1 decimal)', () => {
    expect(formatTokenCount(1_000_000)).toBe('1.0M');
    expect(formatTokenCount(1_234_567)).toBe('1.2M');
  });
});

// ── runMigrations() — token columns ──────────────────────────────────────────

describe('runMigrations() — token columns', () => {
  it('adds total_input_tokens column with try/catch for idempotency', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'schema.ts'),
      'utf-8',
    );
    expect(source).toMatch(
      /ALTER TABLE sessions ADD COLUMN.*total_input_tokens/,
    );
  });

  it('adds total_output_tokens column with try/catch for idempotency', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'schema.ts'),
      'utf-8',
    );
    expect(source).toMatch(
      /ALTER TABLE sessions ADD COLUMN.*total_output_tokens/,
    );
  });

  it('wraps token column additions in try/catch', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'schema.ts'),
      'utf-8',
    );
    const inputMatch = source.match(/try\s*\{[^}]*total_input_tokens[^}]*\}/s);
    const outputMatch = source.match(
      /try\s*\{[^}]*total_output_tokens[^}]*\}/s,
    );
    expect(inputMatch).not.toBeNull();
    expect(outputMatch).not.toBeNull();
  });
});

// ── incrementTokens — SQLite integration ─────────────────────────────────────

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { insertSession, getSession } from '../db/queries.js';
import { incrementTokens } from '../db/queries.js';

const baseSession = {
  session_id: 'token-test-session',
  task_id: null,
  task_url: null,
  project_context_url: null,
  project_id: null,
  status: 'running' as const,
  started_at: Date.now(),
};

describe('incrementTokens', () => {
  it('updates token columns in SQLite', () => {
    insertSession(baseSession);
    incrementTokens('token-test-session', 100, 50);
    const row = getSession('token-test-session');
    expect(row?.total_input_tokens).toBe(100);
    expect(row?.total_output_tokens).toBe(50);
  });

  it('accumulates tokens across multiple calls', () => {
    incrementTokens('token-test-session', 200, 100);
    const row = getSession('token-test-session');
    expect(row?.total_input_tokens).toBe(300);
    expect(row?.total_output_tokens).toBe(150);
  });
});
