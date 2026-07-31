/**
 * Regression coverage for the ops_journal id-space mismatch: ops_journal.task_id
 * is stored bare (no `source:` prefix — see reconcileJournal in ops/opsJournal.ts),
 * but callers such as OrphanedTaskSweeper hold the notion:-prefixed dispatch id.
 * getOpsJournalEntry (and the other ops_journal accessors) must normalize via
 * toExternalId so the writer and reader never silently drift back apart.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { getOpsJournalEntry, upsertOpsJournalEntry } from '../db/queries.js';

function seedRow(taskId: string, state = 'candidate') {
  upsertOpsJournalEntry({
    task_id: taskId,
    project: 'proj-1',
    milestone: 'm1',
    state: state as never,
    disposition: null,
    worked_in: null,
    evidence: null,
    finding_or_proposal: null,
    falsification: null,
    filed_followons: null,
    needs_from_operator: null,
    resolution: null,
    updated_at: '2026-07-31T00:00:00Z',
  });
}

describe('ops_journal id-form normalization', () => {
  it('a row written with a bare uuid resolves when queried with the notion:-prefixed form', () => {
    seedRow('3a822f91-52f3-81ce-a4a1-d4f67ba63524');

    expect(
      getOpsJournalEntry('notion:3a822f91-52f3-81ce-a4a1-d4f67ba63524')?.state,
    ).toBe('candidate');
  });

  it('a row written with the notion:-prefixed form resolves when queried with the bare uuid', () => {
    seedRow('notion:3a822f91-52f3-81ce-a4a1-d4f67ba63524');

    expect(
      getOpsJournalEntry('3a822f91-52f3-81ce-a4a1-d4f67ba63524')?.state,
    ).toBe('candidate');
  });

  it('both id forms resolve to the same underlying row (writer and reader cannot drift apart)', () => {
    seedRow('3a822f91-52f3-81ce-a4a1-d4f67ba63524', 'staged-proposal');

    const viaBare = getOpsJournalEntry('3a822f91-52f3-81ce-a4a1-d4f67ba63524');
    const viaPrefixed = getOpsJournalEntry(
      'notion:3a822f91-52f3-81ce-a4a1-d4f67ba63524',
    );

    expect(viaBare).toBeDefined();
    expect(viaPrefixed).toBeDefined();
    expect(viaBare?.task_id).toBe(viaPrefixed?.task_id);
    expect(viaBare?.updated_at).toBe(viaPrefixed?.updated_at);
  });

  it('returns undefined when no row exists under either form', () => {
    expect(getOpsJournalEntry('notion:does-not-exist')).toBeUndefined();
    expect(getOpsJournalEntry('does-not-exist')).toBeUndefined();
  });
});
