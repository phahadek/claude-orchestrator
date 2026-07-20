/**
 * Tests for the completeness_disposition durable store — the /design
 * completeness-critic record's orchestrator-backed home, symmetric with
 * gate_accretion. AC: a disposition record persists and reads back with its
 * source id, dispositioned questions, reasons, and run timestamp.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  insertCompletenessDisposition,
  listCompletenessDispositions,
} from '../queries.js';

beforeEach(() => {
  db.prepare('DELETE FROM completeness_disposition').run();
});

describe('completeness_disposition store', () => {
  it('persists a disposition record and reads it back', () => {
    const inserted = insertCompletenessDisposition({
      source_task_id: 'notion:abc123',
      project: 'demo',
      milestone: 'M12',
      questions: JSON.stringify([
        {
          question: 'Should X be configurable?',
          disposition: 'dismissed',
          reason: 'Out of scope for this milestone.',
        },
      ]),
      run_at: '2026-07-20T00:00:00.000Z',
    });

    expect(inserted.id).toBeGreaterThan(0);

    const rows = listCompletenessDispositions('notion:abc123');
    expect(rows).toHaveLength(1);
    expect(rows[0].source_task_id).toBe('notion:abc123');
    expect(rows[0].run_at).toBe('2026-07-20T00:00:00.000Z');
    const questions = JSON.parse(rows[0].questions);
    expect(questions).toEqual([
      {
        question: 'Should X be configurable?',
        disposition: 'dismissed',
        reason: 'Out of scope for this milestone.',
      },
    ]);
  });

  it('normalizes source_task_id the same way as gate_accretion', () => {
    insertCompletenessDisposition({
      source_task_id: 'abc123',
      project: null,
      milestone: null,
      questions: '[]',
      run_at: '2026-07-20T00:00:00.000Z',
    });

    const rows = listCompletenessDispositions('abc123');
    expect(rows).toHaveLength(1);
    expect(rows[0].source_task_id).toBe('notion:abc123');
  });

  it('orders multiple runs newest first', () => {
    insertCompletenessDisposition({
      source_task_id: 'notion:abc123',
      project: null,
      milestone: null,
      questions: '[]',
      run_at: '2026-07-19T00:00:00.000Z',
    });
    insertCompletenessDisposition({
      source_task_id: 'notion:abc123',
      project: null,
      milestone: null,
      questions: '[]',
      run_at: '2026-07-20T00:00:00.000Z',
    });

    const rows = listCompletenessDispositions('notion:abc123');
    expect(rows.map((r) => r.run_at)).toEqual([
      '2026-07-20T00:00:00.000Z',
      '2026-07-19T00:00:00.000Z',
    ]);
  });
});
