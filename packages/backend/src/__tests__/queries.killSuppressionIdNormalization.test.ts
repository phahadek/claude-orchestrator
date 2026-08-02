/**
 * Regression coverage for the id-space mismatch in isPlanningKillSuppressed /
 * isGroomNoOpSuppressed: both call hasTaskEditSinceTimestamp, which used to
 * do a literal task_id match against audit_log — but edit events are written
 * with a `source:`-prefixed task_id (TaskBackend.updateBody/updateBodyRaw/
 * patchBodySection) while the evaluator supplies the bare board-cache id.
 * Suppression must clear regardless of which id form the edit was recorded
 * under.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import {
  insertSession,
  insertStagedIntent,
  isPlanningKillSuppressed,
  isGroomNoOpSuppressed,
} from '../db/queries.js';
import { recordEvent } from '../audit/AuditLog';

const UUID = '3b022f91-52f3-8131-82a9-cef70783d479';
const NOTION_ID = `notion:${UUID}`;
const PROJECT = 'proj-kill-suppression-id-norm';

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM staged_intent').run();
});

function killSession(taskId: string, reason: string, endedAt: number) {
  const sessionId = `sess-${Math.random()}`;
  insertSession({
    session_id: sessionId,
    task_id: taskId,
    task_url: 'https://notion.so/task',
    project_context_url: 'https://notion.so/ctx',
    project_id: PROJECT,
    status: 'killed',
    started_at: endedAt - 60_000,
    ended_at: endedAt,
    session_type: 'groom',
  } as never);
  recordEvent({
    event_type: 'session_errored',
    actor_type: 'system',
    actor_id: sessionId,
    project_id: null,
    task_id: null,
    payload: { sessionId, status: 'killed', reason },
  });
}

describe('isPlanningKillSuppressed id-form normalization', () => {
  it('clears suppression when the edit was recorded with a notion:-prefixed id but the evaluator passes the bare id', () => {
    const endedAt = Date.now() - 60_000;
    killSession(UUID, 'user_kill', endedAt);
    expect(isPlanningKillSuppressed(UUID, 'groom')).toBe(true);

    recordEvent({
      event_type: 'task_body_updated',
      actor_type: 'system',
      actor_id: null,
      project_id: PROJECT,
      task_id: NOTION_ID,
      payload: {},
    });

    expect(isPlanningKillSuppressed(UUID, 'groom')).toBe(false);
  });

  it('clears suppression when the edit was recorded with the bare id but the evaluator passes the notion:-prefixed id', () => {
    const endedAt = Date.now() - 60_000;
    killSession(NOTION_ID, 'user_kill', endedAt);
    expect(isPlanningKillSuppressed(NOTION_ID, 'groom')).toBe(true);

    recordEvent({
      event_type: 'task_deps_updated',
      actor_type: 'system',
      actor_id: null,
      project_id: PROJECT,
      task_id: UUID,
      payload: {},
    });

    expect(isPlanningKillSuppressed(NOTION_ID, 'groom')).toBe(false);
  });

  it('still suppresses when there is genuinely no edit after ended_at', () => {
    const endedAt = Date.now() - 60_000;
    killSession(UUID, 'user_kill', endedAt);

    expect(isPlanningKillSuppressed(UUID, 'groom')).toBe(true);
  });

  it('never suppresses when the session ended for a reason other than user_kill', () => {
    const endedAt = Date.now() - 60_000;
    killSession(UUID, 'done', endedAt);

    expect(isPlanningKillSuppressed(UUID, 'groom')).toBe(false);
  });
});

describe('isGroomNoOpSuppressed id-form normalization', () => {
  function seedCommittedNoOp(taskId: string, updatedAt: number) {
    insertStagedIntent({
      id: `noop-${Math.random()}`,
      kind: 'planning.noOp',
      payload: '{}',
      payload_hash: 'hash',
      task_id: taskId,
      project_id: PROJECT,
      session_id: null,
      group_id: null,
      milestone: null,
      state: 'committed',
      supersedes: null,
      annotation: null,
      decision_proposal: null,
      investigation: null,
      groom_proposal: null,
      advisory: null,
      disposition_reason: null,
      answer: null,
      created_at: updatedAt - 1000,
      updated_at: updatedAt,
    } as never);
  }

  it('clears when the edit was recorded with a notion:-prefixed id but queried with the bare id', () => {
    const committedAt = Date.now() - 60_000;
    seedCommittedNoOp(UUID, committedAt);
    expect(isGroomNoOpSuppressed(UUID)).toBe(true);

    recordEvent({
      event_type: 'task_body_updated',
      actor_type: 'system',
      actor_id: null,
      project_id: PROJECT,
      task_id: NOTION_ID,
      payload: {},
    });

    expect(isGroomNoOpSuppressed(UUID)).toBe(false);
  });

  it('clears when the edit was recorded with the bare id but queried with the notion:-prefixed id', () => {
    const committedAt = Date.now() - 60_000;
    seedCommittedNoOp(NOTION_ID, committedAt);
    expect(isGroomNoOpSuppressed(NOTION_ID)).toBe(true);

    recordEvent({
      event_type: 'task_deps_updated',
      actor_type: 'system',
      actor_id: null,
      project_id: PROJECT,
      task_id: UUID,
      payload: {},
    });

    expect(isGroomNoOpSuppressed(NOTION_ID)).toBe(false);
  });
});
