/**
 * Tests for StrandedOpsTaskMonitor.
 *
 * Verifies:
 * - Investigation task at In Progress, non-terminal journal, no live session,
 *   no pending intent, entry older than threshold → exactly one audit event
 *   naming the task and its journal state.
 * - Same task with a staged intent outstanding → no event, regardless of age.
 * - Same task with a live non-terminal session → no event.
 * - Journal resolved → no event.
 * - Entry younger than threshold → no event.
 * - Never writes task status, ops_journal, or dispatches a session.
 * - Repeated runs over the same stranded task do not duplicate the event.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/queries.js', () => ({
  getOpsJournalEntry: vi.fn(),
  hasActiveSessionForTask: vi.fn(),
  hasNonTerminalPlanningSessionForTask: vi.fn(),
  hasPendingDecisionForTask: vi.fn(),
}));

vi.mock('../../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
  hasStrandedOpsSurfacedEvent: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  getAllProjects: vi.fn(),
}));

import {
  getOpsJournalEntry,
  hasActiveSessionForTask,
  hasNonTerminalPlanningSessionForTask,
  hasPendingDecisionForTask,
} from '../../db/queries.js';
import {
  recordEvent,
  hasStrandedOpsSurfacedEvent,
} from '../../audit/AuditLog.js';
import { getAllProjects } from '../../config.js';
import { StrandedOpsTaskMonitor } from '../StrandedOpsTaskMonitor.js';

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const OLD_UPDATED_AT = new Date(
  Date.now() - STALE_THRESHOLD_MS - 60_000,
).toISOString();
const RECENT_UPDATED_AT = new Date(Date.now() - 60_000).toISOString();

function makeTask(id: string, type = '🔎 Investigation') {
  return {
    task: {
      id,
      title: 'Stranded task',
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

describe('StrandedOpsTaskMonitor', () => {
  beforeEach(() => {
    vi.mocked(getAllProjects).mockReturnValue([
      { id: 'proj-1', name: 'P1' } as ReturnType<typeof getAllProjects>[number],
    ]);
    vi.mocked(hasActiveSessionForTask).mockReturnValue(false);
    vi.mocked(hasNonTerminalPlanningSessionForTask).mockReturnValue(false);
    vi.mocked(hasPendingDecisionForTask).mockReturnValue(false);
    vi.mocked(hasStrandedOpsSurfacedEvent).mockReturnValue(false);
    vi.mocked(recordEvent).mockClear();
    vi.mocked(getOpsJournalEntry).mockReset().mockReturnValue({
      task_id: 'task-1',
      project: 'proj-1',
      milestone: 'm1',
      state: 'staged-proposal',
      disposition: null,
      worked_in: null,
      evidence: null,
      finding_or_proposal: null,
      falsification: null,
      filed_followons: null,
      needs_from_operator: null,
      resolution: null,
      updated_at: OLD_UPDATED_AT,
    });
  });

  function makeMonitor(tasks: ReturnType<typeof makeTask>[]) {
    const backend = makeBackend(tasks);
    const monitor = new StrandedOpsTaskMonitor({
      listProjects: getAllProjects,
      resolveBackend: () => backend as never,
      staleThresholdMs: STALE_THRESHOLD_MS,
    });
    return { monitor, backend };
  }

  it('surfaces exactly one event for a genuinely stranded task', async () => {
    const { monitor, backend } = makeMonitor([makeTask('task-1')]);

    await monitor.scanOnce();

    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'task_ops_stranded_surfaced',
        task_id: 'task-1',
        payload: expect.objectContaining({
          taskId: 'task-1',
          journalState: 'staged-proposal',
        }),
      }),
    );
    expect(backend.updateStatus).not.toHaveBeenCalled();
  });

  it('does not surface when a pending operator decision is outstanding, regardless of age', async () => {
    vi.mocked(hasPendingDecisionForTask).mockReturnValue(true);
    const { monitor } = makeMonitor([makeTask('task-1')]);

    await monitor.scanOnce();

    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('does not surface when a live non-terminal session exists', async () => {
    vi.mocked(hasNonTerminalPlanningSessionForTask).mockReturnValue(true);
    const { monitor } = makeMonitor([makeTask('task-1')]);

    await monitor.scanOnce();

    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('does not surface when the journal is resolved', async () => {
    vi.mocked(getOpsJournalEntry).mockReturnValue({
      task_id: 'task-1',
      project: 'proj-1',
      milestone: 'm1',
      state: 'resolved',
      disposition: null,
      worked_in: null,
      evidence: null,
      finding_or_proposal: null,
      falsification: null,
      filed_followons: null,
      needs_from_operator: null,
      resolution: null,
      updated_at: OLD_UPDATED_AT,
    });
    const { monitor } = makeMonitor([makeTask('task-1')]);

    await monitor.scanOnce();

    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('does not surface when the entry is younger than the threshold', async () => {
    vi.mocked(getOpsJournalEntry).mockReturnValue({
      task_id: 'task-1',
      project: 'proj-1',
      milestone: 'm1',
      state: 'staged-proposal',
      disposition: null,
      worked_in: null,
      evidence: null,
      finding_or_proposal: null,
      falsification: null,
      filed_followons: null,
      needs_from_operator: null,
      resolution: null,
      updated_at: RECENT_UPDATED_AT,
    });
    const { monitor } = makeMonitor([makeTask('task-1')]);

    await monitor.scanOnce();

    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('does not emit a duplicate event on repeated runs over the same stranded task', async () => {
    const { monitor } = makeMonitor([makeTask('task-1')]);

    await monitor.scanOnce();
    expect(recordEvent).toHaveBeenCalledTimes(1);

    // Simulate the dedup check now seeing the event recorded above.
    vi.mocked(hasStrandedOpsSurfacedEvent).mockReturnValue(true);

    await monitor.scanOnce();
    expect(recordEvent).toHaveBeenCalledTimes(1);
  });

  it('ignores task types outside Investigation/Operational', async () => {
    const { monitor } = makeMonitor([makeTask('task-1', '💻 Code')]);

    await monitor.scanOnce();

    expect(recordEvent).not.toHaveBeenCalled();
  });
});
