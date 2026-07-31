/**
 * Integration coverage for OrphanedTaskSweeper's ops_journal orphan guard against
 * a real (in-memory) db and the real getOpsJournalEntry/upsertOpsJournalEntry —
 * unlike orphanedTaskSweeper.test.ts, which fully mocks '../db/queries' and so
 * cannot catch an id-space mismatch between the sweeper's lookup and the
 * journal's storage form. This file seeds the journal in one id form and drives
 * the sweeper with the other, matching the production shape: OrphanedTaskSweeper
 * holds the notion:-prefixed task id, while ops_journal.task_id is written bare
 * (see reconcileJournal in ops/opsJournal.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
  },
}));

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../db/queries.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/queries.js')>();
  return {
    ...actual,
    getLatestCodeSessionByNotionTaskId: vi.fn(() => undefined),
    hasActiveSessionForTask: vi.fn(() => false),
    hasNonTerminalPlanningSessionForTask: vi.fn(() => false),
    isSessionAwaitingCapabilityDisposition: vi.fn(() => false),
    getPRBySessionId: vi.fn(() => null),
    getLocalBranchBySession: vi.fn(() => undefined),
    setSessionPauseReason: vi.fn(),
    getSessionLastActivityMs: vi.fn(() => null),
    upsertPullRequest: vi.fn(() => null),
  };
});

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
  countNudgeEvents: vi.fn(() => 0),
  getLatestNudgeTimestamp: vi.fn(() => null),
}));

vi.mock('../config.js', () => ({
  getAllProjects: vi.fn(),
  GITHUB_REPO: 'owner/repo',
  runtimeSettings: {
    auto_launch_poll_interval_ms: 60_000,
  },
}));

import { recordEvent } from '../audit/AuditLog.js';
import { getAllProjects } from '../config.js';
import { db } from '../db/db.js';
import { upsertOpsJournalEntry, getOpsJournalEntry } from '../db/queries.js';
import { OrphanedTaskSweeper } from '../orchestration/OrphanedTaskSweeper.js';
import type { ServerMessage } from '../ws/types.js';

const NOTION_ID = 'notion:3a822f91-52f3-81ce-a4a1-d4f67ba63524';
const BARE_ID = '3a822f91-52f3-81ce-a4a1-d4f67ba63524';

function makeTask(id: string, type: string) {
  return {
    task: {
      id,
      title: 'Test Task',
      status: '🔄 In Progress',
      type,
      dependsOn: [],
      notionUrl: '',
    },
    source: 'notion' as const,
    blocked: false,
    blockers: [],
    nonCode: false,
    wave: 0,
  };
}

function makeBackend(tasks: ReturnType<typeof makeTask>[]) {
  return {
    type: 'notion' as const,
    fetchReadyTasks: vi.fn(),
    attachPR: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    fetchTaskPage: vi.fn(),
    fetchNonMilestoneReadyTasks: vi.fn(),
    updateNotes: vi.fn(),
    appendImplementationNote: vi.fn(),
    listTasksByStatus: vi.fn().mockResolvedValue(tasks),
  };
}

function seedJournal(taskId: string, state: string) {
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

describe('OrphanedTaskSweeper ops_journal guard — cross id-form resolution', () => {
  let broadcast: ReturnType<typeof vi.fn<[ServerMessage], void>>;

  beforeEach(() => {
    db.prepare('DELETE FROM ops_journal').run();
    broadcast = vi.fn();
    vi.mocked(getAllProjects).mockReturnValue([
      { id: 'proj-1', name: 'P1' } as ReturnType<typeof getAllProjects>[number],
    ]);
    vi.mocked(recordEvent).mockClear();
  });

  function runSweeper(tasks: ReturnType<typeof makeTask>[]) {
    const backend = makeBackend(tasks);
    const sweeper = new OrphanedTaskSweeper(broadcast, {
      listProjects: () => [
        { id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
      ],
      resolveBackend: () => backend,
    });
    return { backend, sweeper };
  }

  it('does not revert when the sweeper holds the notion:-prefixed id and ops_journal stores the bare uuid', async () => {
    seedJournal(BARE_ID, 'candidate');
    const { backend, sweeper } = runSweeper([
      makeTask(NOTION_ID, '🔎 Investigation'),
    ]);

    await sweeper.sweepOnce();

    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'task_orphan_reverted' }),
    );
  });

  it('does not revert when the sweeper holds the bare id and ops_journal was written via the prefixed form', async () => {
    seedJournal(NOTION_ID, 'candidate');
    const { backend, sweeper } = runSweeper([makeTask(BARE_ID, '🔧 Operational')]);

    await sweeper.sweepOnce();

    expect(backend.updateStatus).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'task_orphan_reverted' }),
    );
  });

  it('still reverts when the journal entry (cross id-form) is still pending', async () => {
    seedJournal(BARE_ID, 'pending');
    const { backend, sweeper } = runSweeper([
      makeTask(NOTION_ID, '🔎 Investigation'),
    ]);

    await sweeper.sweepOnce();

    expect(backend.updateStatus).toHaveBeenCalledWith(NOTION_ID, '🗂️ Ready');
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'task_orphan_reverted' }),
    );
  });

  it('still reverts when there is no journal entry at all', async () => {
    expect(getOpsJournalEntry(NOTION_ID)).toBeUndefined();
    const { backend, sweeper } = runSweeper([
      makeTask(NOTION_ID, '🔧 Operational'),
    ]);

    await sweeper.sweepOnce();

    expect(backend.updateStatus).toHaveBeenCalledWith(NOTION_ID, '🗂️ Ready');
  });

  it('leaves a 💻 Code task revert path unaffected by an ops_journal entry beyond pending', async () => {
    seedJournal(BARE_ID, 'candidate');
    const { backend, sweeper } = runSweeper([makeTask(NOTION_ID, '💻 Code')]);

    await sweeper.sweepOnce();

    expect(backend.updateStatus).toHaveBeenCalledWith(NOTION_ID, '🗂️ Ready');
  });
});
