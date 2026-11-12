/**
 * Regression coverage for the id-space mismatch in hasTaskEditSinceTimestamp:
 * production edit events (task_body_updated / task_deps_updated) are written
 * with a `source:`-prefixed task_id by TaskBackend.updateBody/updateBodyRaw/
 * patchBodySection, but callers such as isPlanningKillSuppressed and
 * isNoOpSuppressed (db/queries.ts) query with the bare board-cache id.
 * A literal `task_id = ?` match silently misses every edit recorded in the
 * other id form. hasTaskEditSinceTimestamp must compare via normalizeBoardId
 * so either form finds the other.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import {
  recordEvent,
  hasTaskEditSinceTimestamp,
  queryAuditLogByProject,
} from '../AuditLog';

const UUID = '3b022f91-52f3-8131-82a9-cef70783d479';

beforeEach(() => {
  db.prepare('DELETE FROM audit_log').run();
});

describe('hasTaskEditSinceTimestamp id-form normalization', () => {
  it('finds an edit recorded with a notion:-prefixed task_id when queried with the bare hyphenated id', () => {
    recordEvent({
      event_type: 'task_body_updated',
      actor_type: 'system',
      actor_id: null,
      project_id: null,
      task_id: `notion:${UUID}`,
      payload: {},
    });

    expect(hasTaskEditSinceTimestamp(UUID, 0)).toBe(true);
  });

  it('finds an edit recorded with a bare hyphenated task_id when queried with the notion:-prefixed id', () => {
    recordEvent({
      event_type: 'task_deps_updated',
      actor_type: 'system',
      actor_id: null,
      project_id: null,
      task_id: UUID,
      payload: {},
    });

    expect(hasTaskEditSinceTimestamp(`notion:${UUID}`, 0)).toBe(true);
  });

  it('returns false when no edit exists after sinceTs regardless of id form', () => {
    recordEvent({
      event_type: 'task_body_updated',
      actor_type: 'system',
      actor_id: null,
      project_id: null,
      task_id: `notion:${UUID}`,
      payload: {},
    });

    const future = Date.now() + 1_000_000;
    expect(hasTaskEditSinceTimestamp(UUID, future)).toBe(false);
    expect(hasTaskEditSinceTimestamp(`notion:${UUID}`, future)).toBe(false);
  });

  it('does not match an edit for a different task under either id form', () => {
    recordEvent({
      event_type: 'task_body_updated',
      actor_type: 'system',
      actor_id: null,
      project_id: null,
      task_id: `notion:${UUID}`,
      payload: {},
    });

    const other = 'notion:aaaaaaaa-1111-2222-3333-444444444444';
    expect(hasTaskEditSinceTimestamp(other, 0)).toBe(false);
  });
});

describe('audit readers handle a system-actor staged_intent_group_committed event', () => {
  it('queryAuditLogByProject returns actorType system with provenance and evidence intact', () => {
    const evidence = {
      standard: 'code-auto-approve',
      standardVersion: '1',
      tripwireVersion: '1',
      conditions: [{ id: 'is-code', passed: true }],
      tripwireMatches: [],
    };
    recordEvent({
      event_type: 'staged_intent_group_committed',
      actor_type: 'system',
      actor_id: null,
      project_id: 'proj-sys',
      payload: { group_id: 'g', provenance: 'auto', evidence },
    });
    const result = queryAuditLogByProject('proj-sys', {
      eventType: 'staged_intent_group_committed',
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].actorType).toBe('system');
    expect(result.entries[0].payload).toMatchObject({
      provenance: 'auto',
      evidence,
    });
  });
});
