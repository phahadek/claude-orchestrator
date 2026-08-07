/**
 * assertGroomTaskCreateNotDesignFollowOn (stagedIntents.ts) implements the
 * "Design Grooming shouldn't be creating tasks" concern: a groom session
 * cannot stage a task.create against an interactive (📐 Design / 📋
 * Planning) subject task — that's its Design Execution session's deliverable,
 * not grooming's to pre-author. This is a distinct, narrower concern from
 * the multi-group /batch/commit approve-by-standard guard (groomGate.ts's
 * findAutoApproveIneligibleTaskCreate) and must stay untouched by that fix.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

import { db } from '../../db/db.js';
import { stageIntent } from '../stagedIntents.js';
import { insertSession, upsertTaskCache } from '../../db/queries.js';

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM task_cache').run();
});

function seedGroomSession(sessionId: string, taskId: string) {
  insertSession({
    session_id: sessionId,
    task_id: taskId,
    task_url: null,
    project_context_url: null,
    status: 'idle',
    started_at: 0,
    session_type: 'groom',
    note: null,
    tags: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    compaction_count: 0,
    context_occupancy_tokens: 0,
    task_name: null,
    metadata: null,
    review_result: null,
    pause_reason: null,
    last_error_detail: null,
    events_pruned_at: null,
    granted_capabilities: '[]',
  });
}

describe('assertGroomTaskCreateNotDesignFollowOn', () => {
  it('rejects a groom-staged task.create against a 📐 Design subject task', () => {
    seedGroomSession('groom-session-design', 'notion:task-design-1');
    upsertTaskCache(
      'notion:task-design-1',
      JSON.stringify({ type: '📐 Design' }),
    );

    expect(() =>
      stageIntent(
        'task.create',
        { title: 'Follow-on Code task', dependsOn: [] },
        'proj-1',
        null,
        'groom-session-design',
      ),
    ).toThrow(/cannot stage "task.create" against a 📐 Design subject task/);
  });

  it('rejects a groom-staged task.create against a 📋 Planning subject task', () => {
    seedGroomSession('groom-session-planning', 'notion:task-planning-1');
    upsertTaskCache(
      'notion:task-planning-1',
      JSON.stringify({ type: '📋 Planning' }),
    );

    expect(() =>
      stageIntent(
        'task.create',
        { title: 'Follow-on Code task', dependsOn: [] },
        'proj-1',
        null,
        'groom-session-planning',
      ),
    ).toThrow(/cannot stage "task.create" against a 📋 Planning subject task/);
  });

  it('allows a groom-staged task.create against a non-interactive (💻 Code) subject task', () => {
    seedGroomSession('groom-session-code', 'notion:task-code-1');
    upsertTaskCache('notion:task-code-1', JSON.stringify({ type: '💻 Code' }));

    expect(() =>
      stageIntent(
        'task.create',
        { title: 'Follow-on split task', dependsOn: [] },
        'proj-1',
        null,
        'groom-session-code',
      ),
    ).not.toThrow();
  });
});
