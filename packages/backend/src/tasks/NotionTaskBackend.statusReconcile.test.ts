import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { NotionTaskBackend } from './NotionTaskBackend';
import { ProjectService } from '../projects/ProjectService';
import {
  insertProject,
  insertMilestone,
  updateTaskStatusInBoardCaches,
  recordTaskStatusWrite,
  upsertTaskCache,
  getTaskCache,
} from '../db/queries.js';
import type { ResolvedTask } from './types';

/**
 * Regression test for a status write (e.g. Backlog -> Ready) being clobbered
 * by a subsequent board-fetch reconciliation call carrying the pre-write
 * snapshot — the mechanism behind duplicate groom/design/docs/ops dispatch
 * when TaskCacheRefresher polls a stale board within NotionClient's cache
 * TTL. See queries.ts's recordTaskStatusWrite/getRecentTaskStatusWrite.
 */
describe('NotionTaskBackend.fetchReadyTasks — reconciles against a just-applied status write', () => {
  const PROJECT = 'proj-status-reconcile';
  const MILESTONE = 'milestone-status-reconcile';
  const RAW_TASK_ID = 'dddd4444-eeee-5555-ffff-000011112222';
  const PREFIXED_TASK_ID = `notion:${RAW_TASK_ID}`;

  beforeEach(async () => {
    const { db } = await import('../db/db.js');
    db.prepare('DELETE FROM task_cache').run();
    db.prepare('DELETE FROM task_status_writes').run();
    db.prepare('DELETE FROM milestones').run();
    db.prepare('DELETE FROM projects').run();

    insertProject({
      id: PROJECT,
      name: 'Status Reconcile Project',
      project_dir: '/tmp/proj-status-reconcile',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });
    insertMilestone({
      id: MILESTONE,
      project_id: PROJECT,
      name: 'Status Reconcile Milestone',
      source_id: 'source-db-id',
      canonical_short_id: null,
      wrapped_at: null,
    });
  });

  function makeResolvedTask(status: string): ResolvedTask {
    return {
      task: {
        id: RAW_TASK_ID,
        title: 'A task promoted out of Backlog',
        status,
        type: '💻 Code',
        dependsOn: [],
        notionUrl: `https://notion.so/${RAW_TASK_ID}`,
      },
      source: 'notion',
      blocked: false,
      blockers: [],
      nonCode: false,
      wave: 0,
    };
  }

  it('keeps the newer status instead of reverting it to the pre-write board snapshot', async () => {
    // Seed a board:* cache row holding the pre-write status, as
    // NotionClient's own internal board-level cache would.
    upsertTaskCache(
      `board:source-db-id`,
      JSON.stringify([{ ...makeResolvedTask('🔲 Backlog').task }]),
    );

    // A status write lands (the promotion out of Backlog): the write-through
    // path patches every board:* row in place and records the write.
    updateTaskStatusInBoardCaches(PREFIXED_TASK_ID, '🗂️ Ready');
    recordTaskStatusWrite(PREFIXED_TASK_ID, '🗂️ Ready');

    // A TaskCacheRefresher-shaped poll then calls fetchReadyTasks. The
    // underlying client is stubbed to simulate a stale board fetch still
    // carrying the pre-write status (the exact race: NotionClient's board
    // cache was served from — or a live fetch resolved with — data queried
    // before the write landed).
    const mockClient = {
      fetchReadyTasks: vi
        .fn()
        .mockResolvedValue([makeResolvedTask('🔲 Backlog')]),
    };
    const backend = new NotionTaskBackend(mockClient as never);

    const result = await backend.fetchReadyTasks(MILESTONE);

    expect(result[0].task.status).toBe('🗂️ Ready');

    const boardRow = getTaskCache(`board:${MILESTONE}`);
    expect(boardRow).toBeDefined();
    const cached = JSON.parse(boardRow!.raw_json) as Array<{
      id: string;
      status: string;
    }>;
    expect(cached[0].status).toBe('🗂️ Ready');

    const perTaskRow = getTaskCache(PREFIXED_TASK_ID);
    expect(perTaskRow).toBeDefined();
    const perTaskCached = JSON.parse(perTaskRow!.raw_json) as {
      status: string;
    };
    expect(perTaskCached.status).toBe('🗂️ Ready');
  });
});
