import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../ops/opsLoad.js', () => ({
  loadOpsContext: vi.fn(),
}));

import { DispatchTriggerEvaluator } from '../DispatchTriggerEvaluator';
import { loadOpsContext } from '../../ops/opsLoad.js';
import { logger } from '../../logger.js';
import { insertProject, insertMilestone } from '../../db/queries.js';
import type { NotionTask } from '../../notion/types.js';
import type { OpsLoadResult, OpsTaskEntry } from '../../ops/opsLoad.js';

const PROJECT = 'proj-ops-dispatch';
const MILESTONE = 'milestone-ops-dispatch';

function makeCandidateTask(id: string): NotionTask {
  return {
    id,
    title: `Task ${id}`,
    status: '🗂️ Ready',
    type: '🔧 Operational',
    dependsOn: [],
    notionUrl: `https://notion.so/${id}`,
  };
}

function makeOpsTaskEntry(
  id: string,
  overrides: Partial<OpsTaskEntry> = {},
): OpsTaskEntry {
  return {
    id,
    title: 'Ops task',
    status: '🗂️ Ready',
    url: `https://www.notion.so/${id}`,
    type: '🔧 Operational',
    mode: 'operational',
    dependsOn: [],
    blockingDepIds: [],
    depStatus: 'ready',
    ...overrides,
  };
}

function makeOpsContext(executable: OpsTaskEntry[]): OpsLoadResult {
  return {
    contextPages: [],
    boards: {
      target: {
        milestone: MILESTONE,
        board: 'board-1',
        counts: {
          executable: executable.length,
          dep_blocked: 0,
          needs_grooming: 0,
          closed_not_done: 0,
          done_or_deferred: 0,
          leftover_tooling: 0,
          test_authoring_excluded: 0,
        },
      },
      neighbours: [],
    },
    worklist: {
      executable,
      dep_blocked: [],
      needs_grooming: [],
      closed_not_done: [],
      leftover_tooling: [],
      test_authoring: [],
      newly_unblocked: [],
    },
  };
}

describe('DispatchTriggerEvaluator.dispatchOpsCandidate — id-space normalization', () => {
  let launchSelected: ReturnType<typeof vi.fn>;
  let evaluator: DispatchTriggerEvaluator;

  beforeEach(async () => {
    const { db } = await import('../../db/db.js');
    db.prepare('DELETE FROM task_cache').run();
    db.prepare('DELETE FROM flow_arm').run();
    db.prepare('DELETE FROM milestones').run();
    db.prepare('DELETE FROM projects').run();

    insertProject({
      id: PROJECT,
      name: 'Ops Dispatch Project',
      project_dir: '/tmp/proj-ops-dispatch',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });
    insertMilestone({
      id: MILESTONE,
      project_id: PROJECT,
      name: 'Ops Dispatch Milestone',
      source_id: null,
      canonical_short_id: null,
      wrapped_at: null,
    });

    launchSelected = vi.fn().mockResolvedValue({
      launched: ['task-launched'],
      deferred: [],
      failed: [],
    });
    evaluator = new DispatchTriggerEvaluator(
      {} as never,
      { launchSelected } as never,
    );
    vi.mocked(loadOpsContext).mockReset();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  it('launches when the cached-board candidate id is notion:-prefixed and the worklist entry id is bare (live pairing)', async () => {
    const bareId = '3ad22f91-52f3-81a1-8ba6-e1aa9fd19eab';
    const notionId = `notion:${bareId}`;
    vi.mocked(loadOpsContext).mockResolvedValue(
      makeOpsContext([makeOpsTaskEntry(bareId)]),
    );

    const candidate = {
      projectId: PROJECT,
      milestone: { id: MILESTONE } as never,
      task: makeCandidateTask(notionId),
    };

    const launched = await (evaluator as any).dispatchOpsCandidate(candidate);

    expect(launched).toBe(true);
    expect(launchSelected).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('still launches when both ids are already in the same format', async () => {
    const id = 'task-same-format';
    vi.mocked(loadOpsContext).mockResolvedValue(
      makeOpsContext([makeOpsTaskEntry(id)]),
    );

    const candidate = {
      projectId: PROJECT,
      milestone: { id: MILESTONE } as never,
      task: makeCandidateTask(id),
    };

    const launched = await (evaluator as any).dispatchOpsCandidate(candidate);

    expect(launched).toBe(true);
    expect(launchSelected).toHaveBeenCalledTimes(1);
  });

  it('returns false without launching, and logs, when the task is genuinely absent from the executable worklist after normalization', async () => {
    vi.mocked(loadOpsContext).mockResolvedValue(
      makeOpsContext([makeOpsTaskEntry('some-other-task-id')]),
    );

    const candidate = {
      projectId: PROJECT,
      milestone: { id: MILESTONE } as never,
      task: makeCandidateTask('notion:missing-task-id'),
    };

    const launched = await (evaluator as any).dispatchOpsCandidate(candidate);

    expect(launched).toBe(false);
    expect(launchSelected).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('notion:missing-task-id'),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(MILESTONE),
    );
  });

  it('keeps existing logging and crash-budget behaviour when loadOpsContext throws', async () => {
    vi.mocked(loadOpsContext).mockRejectedValue(new Error('boom'));

    const candidate = {
      projectId: PROJECT,
      milestone: { id: MILESTONE } as never,
      task: makeCandidateTask('notion:some-task'),
    };

    const launched = await (evaluator as any).dispatchOpsCandidate(candidate);

    expect(launched).toBe(false);
    expect(launchSelected).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'failed to load context for task notion:some-task: boom',
      ),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'ops dispatch failed for task notion:some-task (attempt 1): boom',
      ),
    );
  });
});
