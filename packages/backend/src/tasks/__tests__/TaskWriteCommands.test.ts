import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetTaskCache = vi.fn();
const mockGetMergeCommitForTask = vi.fn();
const mockDeleteTaskCacheRow = vi.fn();
const mockRecordEvent = vi.fn();
const mockInsertItem = vi.fn();
const mockRecordAccretionMarker = vi.fn();
const mockGetAccretionMarker = vi.fn();
const mockInsertSeedItem = vi.fn();
const mockRecordSeedAccretionMarker = vi.fn();
const mockGetSeedAccretionMarker = vi.fn();
const mockRollbackGateContribution = vi.fn();
const mockRollbackSeedContribution = vi.fn();

vi.mock('../../db/queries', () => ({
  getTaskCache: (...args: unknown[]) => mockGetTaskCache(...args),
  getMergeCommitForTask: (...args: unknown[]) =>
    mockGetMergeCommitForTask(...args),
  deleteTaskCacheRow: (...args: unknown[]) => mockDeleteTaskCacheRow(...args),
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: (...args: unknown[]) => mockRecordEvent(...args),
}));

vi.mock('../../gate/gateStore', () => ({
  insertItem: (...args: unknown[]) => mockInsertItem(...args),
  recordAccretionMarker: (...args: unknown[]) =>
    mockRecordAccretionMarker(...args),
  getAccretionMarker: (...args: unknown[]) => mockGetAccretionMarker(...args),
  rollbackContribution: (...args: unknown[]) =>
    mockRollbackGateContribution(...args),
}));

const mockResolveMilestoneDatabaseId = vi.fn();

vi.mock('../../projects/milestoneResolver', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../projects/milestoneResolver')>();
  return {
    ...actual,
    resolveMilestoneDatabaseId: (...args: unknown[]) =>
      mockResolveMilestoneDatabaseId(...args),
  };
});

const M12_UUID = '8c381caa-31a8-41df-add7-2578a14f47d8';
const mockProjectServiceGetById = vi.fn();

vi.mock('../../projects/ProjectService', () => ({
  ProjectService: {
    getById: (...args: unknown[]) => mockProjectServiceGetById(...args),
  },
}));

vi.mock('../../seed/seedStore', () => ({
  insertItem: (...args: unknown[]) => mockInsertSeedItem(...args),
  recordAccretionMarker: (...args: unknown[]) =>
    mockRecordSeedAccretionMarker(...args),
  getAccretionMarker: (...args: unknown[]) =>
    mockGetSeedAccretionMarker(...args),
  rollbackContribution: (...args: unknown[]) =>
    mockRollbackSeedContribution(...args),
}));

import {
  BackendTaskWriteCommands,
  isValidTransition,
  STATUS_DISPLAY,
  getCachedType,
  getCachedStatus,
} from '../TaskWriteCommands';
import { ReadinessGateError } from '../readinessGate';
import { GroomingGateError } from '../../groom/groomGate';
import type { TaskBackend } from '../TaskBackend';
import { NotionTaskBackend } from '../NotionTaskBackend';
import type { NotionClient } from '../../notion/NotionClient';

function makeBackend(overrides: Partial<TaskBackend> = {}): TaskBackend {
  return {
    type: 'notion',
    fetchReadyTasks: vi.fn(),
    attachPR: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    fetchTaskPage: vi.fn(),
    fetchNonMilestoneReadyTasks: vi.fn(),
    updateNotes: vi.fn(),
    appendImplementationNote: vi.fn(),
    listTasksByStatus: vi.fn(),
    createTask: vi.fn().mockResolvedValue('notion:new-id'),
    setDependsOn: vi.fn().mockResolvedValue(undefined),
    setType: vi.fn().mockResolvedValue(undefined),
    setProperties: vi.fn().mockResolvedValue(undefined),
    archive: vi.fn().mockResolvedValue(undefined),
    updateBody: vi.fn().mockResolvedValue(undefined),
    updateBodyRaw: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function cacheRowWithStatus(display: string) {
  return { raw_json: JSON.stringify({ status: display }) };
}

function cacheRowWithStatusAndType(display: string, type: string) {
  return { raw_json: JSON.stringify({ status: display, type }) };
}

beforeEach(() => {
  mockGetTaskCache.mockReset();
  mockGetMergeCommitForTask.mockReset();
  mockGetMergeCommitForTask.mockReturnValue(null);
  mockDeleteTaskCacheRow.mockReset();
  mockRecordEvent.mockReset();
  mockInsertItem.mockReset();
  mockRecordAccretionMarker.mockReset();
  mockGetAccretionMarker.mockReset();
  mockInsertSeedItem.mockReset();
  mockRecordSeedAccretionMarker.mockReset();
  mockGetSeedAccretionMarker.mockReset();
  mockRollbackGateContribution.mockReset();
  mockRollbackSeedContribution.mockReset();
  mockResolveMilestoneDatabaseId.mockReset();
  mockProjectServiceGetById.mockReset();
  mockProjectServiceGetById.mockImplementation((id: string) => {
    if (id !== 'polimarket-analyser') return undefined;
    return {
      id,
      milestones: [{ id: M12_UUID, name: 'M12', canonicalShortId: 'M12' }],
    };
  });
});

describe('TaskWriteCommands.setStatus — state machine', () => {
  it('accepts a valid transition (Backlog -> Ready)', () => {
    expect(isValidTransition('Backlog', 'Ready')).toBe(true);
  });

  it('rejects an invalid transition (Backlog -> Done)', () => {
    expect(isValidTransition('Backlog', 'Done')).toBe(false);
  });

  it('rejects any transition out of Done (terminal)', () => {
    expect(isValidTransition('Done', 'In Progress')).toBe(false);
    expect(isValidTransition('Done', 'Backlog')).toBe(false);
  });

  it('calls backend.updateStatus with the display-format status on a valid transition', async () => {
    mockGetTaskCache.mockReturnValue(
      cacheRowWithStatus(STATUS_DISPLAY.Backlog),
    );
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await commands.setStatus('notion:abc', 'Ready', {
      groomingGate: {
        size_check: { decision: 'no_split' },
        type_check: { decision: 'none' },
      },
    });

    expect(backend.updateStatus).toHaveBeenCalledWith(
      'notion:abc',
      '🗂️ Ready',
      expect.objectContaining({
        groomingGate: {
          size_check: { decision: 'no_split' },
          type_check: { decision: 'none' },
        },
      }),
    );
  });

  it('rejects an invalid transition and does not call the backend', async () => {
    mockGetTaskCache.mockReturnValue(
      cacheRowWithStatus(STATUS_DISPLAY.Backlog),
    );
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await expect(commands.setStatus('notion:abc', 'Done')).rejects.toThrow(
      /invalid status transition/i,
    );
    expect(backend.updateStatus).not.toHaveBeenCalled();
  });

  it('allows the write when the current status cannot be determined (no cache row)', async () => {
    mockGetTaskCache.mockReturnValue(undefined);
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await commands.setStatus('notion:abc', 'Done');

    expect(backend.updateStatus).toHaveBeenCalledWith(
      'notion:abc',
      '✅ Done',
      undefined,
    );
  });

  it('forwards provenance options through to the backend', async () => {
    mockGetTaskCache.mockReturnValue(
      cacheRowWithStatus(STATUS_DISPLAY.Backlog),
    );
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await commands.setStatus('notion:abc', 'Ready', {
      source: 'human',
      sessionId: 'sess-1',
      groomingGate: {
        size_check: { decision: 'no_split' },
        type_check: { decision: 'none' },
      },
    });

    expect(backend.updateStatus).toHaveBeenCalledWith(
      'notion:abc',
      '🗂️ Ready',
      {
        source: 'human',
        sessionId: 'sess-1',
        groomingGate: {
          size_check: { decision: 'no_split' },
          type_check: { decision: 'none' },
        },
      },
    );
  });
});

describe('getCachedType / getCachedStatus — task ID normalization', () => {
  it('getCachedType resolves a bare Notion UUID against the notion:-keyed cache row', () => {
    mockGetTaskCache.mockImplementation((id: string) =>
      id === 'notion:abc-uuid'
        ? cacheRowWithStatusAndType(STATUS_DISPLAY.Backlog, '📐 Design')
        : undefined,
    );

    expect(getCachedType('abc-uuid')).toBe('📐 Design');
  });

  it('getCachedType is idempotent when already given a notion:-prefixed id', () => {
    mockGetTaskCache.mockImplementation((id: string) =>
      id === 'notion:abc-uuid'
        ? cacheRowWithStatusAndType(STATUS_DISPLAY.Backlog, '📐 Design')
        : undefined,
    );

    expect(getCachedType('notion:abc-uuid')).toBe('📐 Design');
  });

  it('getCachedStatus resolves a bare Notion UUID against the notion:-keyed cache row', () => {
    mockGetTaskCache.mockImplementation((id: string) =>
      id === 'notion:abc-uuid'
        ? cacheRowWithStatus(STATUS_DISPLAY.Backlog)
        : undefined,
    );

    expect(getCachedStatus('abc-uuid')).toBe('Backlog');
  });

  it('getCachedStatus is idempotent when already given a notion:-prefixed id', () => {
    mockGetTaskCache.mockImplementation((id: string) =>
      id === 'notion:abc-uuid'
        ? cacheRowWithStatus(STATUS_DISPLAY.Backlog)
        : undefined,
    );

    expect(getCachedStatus('notion:abc-uuid')).toBe('Backlog');
  });
});

describe('TaskWriteCommands.setStatus — Ready-transition readiness gate', () => {
  it('rejects a Ready transition when the body has a violation, and returns the structured report', async () => {
    mockGetTaskCache.mockReturnValue(
      cacheRowWithStatus(STATUS_DISPLAY.Backlog),
    );
    const backend = makeBackend({
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue(
          '## Open Questions\n- Which retry policy should we use?\n',
        ),
    });
    const commands = new BackendTaskWriteCommands(backend);

    let caught: unknown;
    try {
      await commands.setStatus('notion:abc', 'Ready', {
        groomingGate: {
          size_check: { decision: 'no_split' },
          type_check: { decision: 'none' },
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ReadinessGateError);
    expect((caught as ReadinessGateError).violations).toEqual([
      expect.objectContaining({ tier: 'structural' }),
    ]);
    expect(backend.updateStatus).not.toHaveBeenCalled();
  });

  it('applies a clean Ready transition (no violations)', async () => {
    mockGetTaskCache.mockReturnValue(
      cacheRowWithStatus(STATUS_DISPLAY.Backlog),
    );
    const backend = makeBackend({
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nAll good.'),
    });
    const commands = new BackendTaskWriteCommands(backend);

    await commands.setStatus('notion:abc', 'Ready', {
      groomingGate: {
        size_check: { decision: 'no_split' },
        type_check: { decision: 'none' },
      },
    });

    expect(backend.updateStatus).toHaveBeenCalledWith(
      'notion:abc',
      '🗂️ Ready',
      expect.objectContaining({
        groomingGate: {
          size_check: { decision: 'no_split' },
          type_check: { decision: 'none' },
        },
      }),
    );
  });

  it('applies with override + reason, and records an audit event with actor, reason, and tier', async () => {
    mockGetTaskCache.mockReturnValue(
      cacheRowWithStatus(STATUS_DISPLAY.Backlog),
    );
    const backend = makeBackend({
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue(
          '## Open Questions\n- Which retry policy should we use?\n',
        ),
    });
    const commands = new BackendTaskWriteCommands(backend, 'proj-1');

    await commands.setStatus('notion:abc', 'Ready', {
      source: 'human',
      sessionId: 'sess-1',
      readinessOverride: { reason: 'human reviewed and approved' },
      groomingGate: {
        size_check: { decision: 'no_split' },
        type_check: { decision: 'none' },
      },
    });

    expect(backend.updateStatus).toHaveBeenCalledWith(
      'notion:abc',
      '🗂️ Ready',
      expect.objectContaining({
        readinessOverride: { reason: 'human reviewed and approved' },
      }),
    );
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'readiness_override',
        actor_type: 'human',
        actor_id: 'sess-1',
        project_id: 'proj-1',
        task_id: 'notion:abc',
        payload: expect.objectContaining({
          reason: 'human reviewed and approved',
          tiers: ['structural'],
        }),
      }),
    );
  });

  it('applies the standard triage-clean-Design readiness_override reason when triageCleanDesign is set and no explicit override is given', async () => {
    // Open Questions is exempt for 📐 Design (readinessGate.ts), so this uses
    // grooming residue — the one check that stays type-agnostic — to still
    // exercise the triageCleanDesign override path.
    mockGetTaskCache.mockReturnValue(
      cacheRowWithStatusAndType(STATUS_DISPLAY.Backlog, '📐 Design'),
    );
    const backend = makeBackend({
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue(
          'Files affected: confirm the exact module at grooming.',
        ),
    });
    const commands = new BackendTaskWriteCommands(backend, 'proj-1');

    await commands.setStatus('notion:abc', 'Ready', {
      sessionId: 'sess-1',
      triageCleanDesign: { milestoneLabel: 'M12' },
      groomingGate: {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'n/a' },
        triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: true },
      },
    });

    const expectedReason =
      'Design task — open questions are the /design worklist, resolved at execution; ' +
      'triaged clean in the M12 consolidated Design triage';

    expect(backend.updateStatus).toHaveBeenCalled();
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'readiness_override',
        payload: expect.objectContaining({ reason: expectedReason }),
      }),
    );
  });

  it('does not honor triageCleanDesign for a non-Design cached type — auto-dispatched types stay per-task-gated', async () => {
    mockGetTaskCache.mockReturnValue(
      cacheRowWithStatusAndType(STATUS_DISPLAY.Backlog, '🔧 Operational'),
    );
    const backend = makeBackend({
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue(
          '## Open Questions\n- Which retry policy should we use?\n',
        ),
    });
    const commands = new BackendTaskWriteCommands(backend);

    let caught: unknown;
    try {
      await commands.setStatus('notion:abc', 'Ready', {
        triageCleanDesign: { milestoneLabel: 'M12' },
        groomingGate: {
          size_check: { decision: 'n/a' },
          type_check: { decision: 'n/a' },
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ReadinessGateError);
    expect(backend.updateStatus).not.toHaveBeenCalled();
  });

  it('does not throw on a non-empty Open Questions section for a Design task Ready-transition staged with a bare taskId', async () => {
    // Regression for the bare-id cache-miss bug: task_cache rows are keyed
    // notion:<id>, so a raw-id read must be normalized before the lookup or
    // the cached type resolves null and the gate runs type-blind.
    mockGetTaskCache.mockImplementation((id: string) =>
      id === 'notion:abc-uuid'
        ? cacheRowWithStatusAndType(STATUS_DISPLAY.Backlog, '📐 Design')
        : undefined,
    );
    const backend = makeBackend({
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue(
          '## Open Questions\n- Which retry policy should we use?\n',
        ),
    });
    const commands = new BackendTaskWriteCommands(backend);

    await commands.setStatus('abc-uuid', 'Ready', {
      groomingGate: {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'n/a' },
        triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: true },
      },
    });

    expect(backend.updateStatus).toHaveBeenCalledWith(
      'abc-uuid',
      '🗂️ Ready',
      expect.anything(),
    );
  });
});

describe('TaskWriteCommands.setStatus — grooming promotion gate', () => {
  it('blocks a Ready transition when the grooming gate entry is missing/undispositioned', async () => {
    mockGetTaskCache.mockReturnValue(
      cacheRowWithStatus(STATUS_DISPLAY.Backlog),
    );
    const backend = makeBackend({
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nAll good.'),
    });
    const commands = new BackendTaskWriteCommands(backend);

    let caught: unknown;
    try {
      await commands.setStatus('notion:abc', 'Ready', {
        groomingGate: { size_check: null, type_check: null },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GroomingGateError);
    expect((caught as GroomingGateError).reasons.join(' ')).toMatch(
      /size_check/,
    );
    expect(backend.updateStatus).not.toHaveBeenCalled();
  });

  it('allows a Ready transition when the grooming gate entry is fully dispositioned', async () => {
    mockGetTaskCache.mockReturnValue(
      cacheRowWithStatus(STATUS_DISPLAY.Backlog),
    );
    const backend = makeBackend({
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nAll good.'),
    });
    const commands = new BackendTaskWriteCommands(backend);

    await commands.setStatus('notion:abc', 'Ready', {
      groomingGate: {
        size_check: { decision: 'no_split' },
        type_check: { decision: 'none' },
      },
    });

    expect(backend.updateStatus).toHaveBeenCalledWith(
      'notion:abc',
      '🗂️ Ready',
      expect.objectContaining({
        groomingGate: {
          size_check: { decision: 'no_split' },
          type_check: { decision: 'none' },
        },
      }),
    );
  });

  it('blocks a Ready transition when no groomingGate entry is supplied at all', async () => {
    mockGetTaskCache.mockReturnValue(
      cacheRowWithStatus(STATUS_DISPLAY.Backlog),
    );
    const backend = makeBackend({
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nAll good.'),
    });
    const commands = new BackendTaskWriteCommands(backend);

    let caught: unknown;
    try {
      await commands.setStatus('notion:abc', 'Ready');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GroomingGateError);
    expect(backend.updateStatus).not.toHaveBeenCalled();
  });

  it('allows a Ready transition for a non-Code task carrying n/a size/type dispositions (fail-open)', async () => {
    mockGetTaskCache.mockReturnValue(
      cacheRowWithStatus(STATUS_DISPLAY.Backlog),
    );
    const backend = makeBackend({
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nAll good.'),
    });
    const commands = new BackendTaskWriteCommands(backend);

    await commands.setStatus('notion:abc', 'Ready', {
      groomingGate: {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'n/a' },
        type: '📐 Design',
        triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: true },
      },
    });

    expect(backend.updateStatus).toHaveBeenCalledWith(
      'notion:abc',
      '🗂️ Ready',
      expect.objectContaining({
        groomingGate: {
          size_check: { decision: 'n/a' },
          type_check: { decision: 'n/a' },
          type: '📐 Design',
          triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: true },
        },
      }),
    );
  });

  it('blocks a Ready transition for a cached 💻 Code task when the groomingGate payload omits `type` and no gate_accretion marker exists (accretion fail-open closed)', async () => {
    mockGetTaskCache.mockReturnValue(
      cacheRowWithStatusAndType(STATUS_DISPLAY.Backlog, '💻 Code'),
    );
    mockGetAccretionMarker.mockReturnValue(undefined);
    mockGetSeedAccretionMarker.mockReturnValue(undefined);
    const backend = makeBackend({
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nAll good.'),
    });
    const commands = new BackendTaskWriteCommands(backend);

    let caught: unknown;
    try {
      await commands.setStatus('notion:abc', 'Ready', {
        groomingGate: {
          size_check: { decision: 'no_split' },
          type_check: { decision: 'none' },
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GroomingGateError);
    expect((caught as GroomingGateError).reasons.join(' ')).toMatch(
      /gate_contribution/,
    );
    expect(backend.updateStatus).not.toHaveBeenCalled();
  });

  it('blocks a Ready transition for a cached 💻 Code task when a gate_accretion marker exists but no seed_accretion marker exists', async () => {
    mockGetTaskCache.mockReturnValue(
      cacheRowWithStatusAndType(STATUS_DISPLAY.Backlog, '💻 Code'),
    );
    mockGetAccretionMarker.mockReturnValue({ decision: 'none' });
    mockGetSeedAccretionMarker.mockReturnValue(undefined);
    const backend = makeBackend({
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nAll good.'),
    });
    const commands = new BackendTaskWriteCommands(backend);

    let caught: unknown;
    try {
      await commands.setStatus('notion:abc', 'Ready', {
        groomingGate: {
          size_check: { decision: 'no_split' },
          type_check: { decision: 'none' },
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GroomingGateError);
    expect((caught as GroomingGateError).reasons.join(' ')).toMatch(
      /seed_contribution/,
    );
    expect(backend.updateStatus).not.toHaveBeenCalled();
  });

  it('allows a Ready transition for a cached 💻 Code task once gate_accretion and seed_accretion markers are both recorded, even though the payload omits `type`', async () => {
    mockGetTaskCache.mockReturnValue(
      cacheRowWithStatusAndType(STATUS_DISPLAY.Backlog, '💻 Code'),
    );
    mockGetAccretionMarker.mockReturnValue({ decision: 'items' });
    mockGetSeedAccretionMarker.mockReturnValue({ decision: 'none' });
    const backend = makeBackend({
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nAll good.'),
    });
    const commands = new BackendTaskWriteCommands(backend);

    await commands.setStatus('notion:abc', 'Ready', {
      groomingGate: {
        size_check: { decision: 'no_split' },
        type_check: { decision: 'none' },
        filesPathsEntries: [
          {
            raw: 'packages/backend/src/abc.ts *(new)*',
            isNew: true,
            existsInRepo: false,
          },
        ],
      },
    });

    expect(backend.updateStatus).toHaveBeenCalledWith(
      'notion:abc',
      '🗂️ Ready',
      expect.objectContaining({
        groomingGate: {
          size_check: { decision: 'no_split' },
          type_check: { decision: 'none' },
          filesPathsEntries: [
            {
              raw: 'packages/backend/src/abc.ts *(new)*',
              isNew: true,
              existsInRepo: false,
            },
          ],
        },
      }),
    );
  });

  it('allows a Ready transition for a cached 📐 Design task with no accretion markers at all (non-gated type still fails open)', async () => {
    mockGetTaskCache.mockReturnValue(
      cacheRowWithStatusAndType(STATUS_DISPLAY.Backlog, '📐 Design'),
    );
    mockGetAccretionMarker.mockReturnValue(undefined);
    mockGetSeedAccretionMarker.mockReturnValue(undefined);
    const backend = makeBackend({
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nAll good.'),
    });
    const commands = new BackendTaskWriteCommands(backend);

    await commands.setStatus('notion:abc', 'Ready', {
      groomingGate: {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'n/a' },
        triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: true },
      },
    });

    expect(backend.updateStatus).toHaveBeenCalled();
  });
});

describe('TaskWriteCommands.createTask', () => {
  it('delegates to backend.createTask and returns its task id', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    const id = await commands.createTask({
      databaseId: 'db-1',
      title: 'New task',
    });

    expect(id).toBe('notion:new-id');
    expect(backend.createTask).toHaveBeenCalledWith(
      { databaseId: 'db-1', title: 'New task' },
      undefined,
    );
  });

  it('throws when the backend does not support createTask', async () => {
    const backend = makeBackend({ createTask: undefined });
    const commands = new BackendTaskWriteCommands(backend);

    await expect(
      commands.createTask({ databaseId: 'db-1', title: 'x' }),
    ).rejects.toThrow(/not supported/i);
  });

  it('resolves the board databaseId server-side from the target milestone when the payload carries no raw databaseId', async () => {
    mockResolveMilestoneDatabaseId.mockReturnValue(
      '6614adb5-5bec-4b9a-b9a4-208ae0f00f3c',
    );
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend, 'claude-dashboard');

    const id = await commands.createTask({
      milestone: 'M12',
      title: 'Follow-on Code task',
      type: '💻 Code',
    });

    expect(id).toBe('notion:new-id');
    expect(mockResolveMilestoneDatabaseId).toHaveBeenCalledWith(
      'claude-dashboard',
      'M12',
    );
    expect(backend.createTask).toHaveBeenCalledWith(
      {
        databaseId: '6614adb5-5bec-4b9a-b9a4-208ae0f00f3c',
        title: 'Follow-on Code task',
        type: '💻 Code',
      },
      undefined,
    );
  });

  it('prefers an explicit databaseId over milestone resolution when both are present', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend, 'claude-dashboard');

    await commands.createTask({
      databaseId: 'db-explicit',
      milestone: 'M12',
      title: 'x',
    });

    expect(mockResolveMilestoneDatabaseId).not.toHaveBeenCalled();
    expect(backend.createTask).toHaveBeenCalledWith(
      { databaseId: 'db-explicit', title: 'x' },
      undefined,
    );
  });

  it('throws a clear error when neither databaseId nor milestone is supplied', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend, 'claude-dashboard');

    await expect(commands.createTask({ title: 'x' } as never)).rejects.toThrow(
      /requires either databaseId or milestone/,
    );
  });

  it('throws a clear error when a milestone is supplied but no projectId is bound', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await expect(
      commands.createTask({ milestone: 'M12', title: 'x' }),
    ).rejects.toThrow(/without a projectId/);
    expect(mockResolveMilestoneDatabaseId).not.toHaveBeenCalled();
  });

  it('propagates an unresolvable milestone as a clear error, not an opaque Notion parent error', async () => {
    mockResolveMilestoneDatabaseId.mockImplementation(() => {
      throw new Error(
        '"M99" is not a known milestone for project "claude-dashboard"',
      );
    });
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend, 'claude-dashboard');

    await expect(
      commands.createTask({ milestone: 'M99', title: 'x' }),
    ).rejects.toThrow(/not a known milestone/);
    expect(backend.createTask).not.toHaveBeenCalled();
  });
});

describe('TaskWriteCommands.setDependsOn', () => {
  it('delegates to backend.setDependsOn', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await commands.setDependsOn('notion:abc', ['notion:dep1', 'notion:dep2']);

    expect(backend.setDependsOn).toHaveBeenCalledWith(
      'notion:abc',
      ['notion:dep1', 'notion:dep2'],
      undefined,
    );
  });

  it('throws when the backend does not support setDependsOn', async () => {
    const backend = makeBackend({ setDependsOn: undefined });
    const commands = new BackendTaskWriteCommands(backend);

    await expect(
      commands.setDependsOn('notion:abc', ['notion:dep1']),
    ).rejects.toThrow(/not supported/i);
  });
});

describe('TaskWriteCommands.setType', () => {
  it('accepts a valid reclassification with a consistent body (Code, no open questions)', async () => {
    const backend = makeBackend({
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nAll good.\n'),
    });
    const commands = new BackendTaskWriteCommands(backend);

    await commands.setType('notion:abc', '💻 Code');

    expect(backend.setType).toHaveBeenCalledWith(
      'notion:abc',
      '💻 Code',
      undefined,
    );
  });

  it('rejects setting Code when the body has open/to-be-investigated items', async () => {
    const backend = makeBackend({
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue(
          '## Open Questions\n- Which retry policy should we use?\n',
        ),
    });
    const commands = new BackendTaskWriteCommands(backend);

    await expect(commands.setType('notion:abc', '💻 Code')).rejects.toThrow(
      /open\/to-be-investigated/i,
    );
    expect(backend.setType).not.toHaveBeenCalled();
  });

  it('accepts Investigation when the body carries an open investigation', async () => {
    const backend = makeBackend({
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue(
          '## Open Questions\n- What is causing the memory leak?\n',
        ),
    });
    const commands = new BackendTaskWriteCommands(backend);

    await commands.setType('notion:abc', '🔎 Investigation');

    expect(backend.setType).toHaveBeenCalledWith(
      'notion:abc',
      '🔎 Investigation',
      undefined,
    );
  });

  it('rejects Investigation when the body has no open investigation', async () => {
    const backend = makeBackend({
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nAll resolved.\n'),
    });
    const commands = new BackendTaskWriteCommands(backend);

    await expect(
      commands.setType('notion:abc', '🔎 Investigation'),
    ).rejects.toThrow(/no open investigation/i);
    expect(backend.setType).not.toHaveBeenCalled();
  });

  it('rejects an unknown/illegal type', async () => {
    const backend = makeBackend({
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nAll good.\n'),
    });
    const commands = new BackendTaskWriteCommands(backend);

    await expect(
      commands.setType('notion:abc', 'Bogus Type' as never),
    ).rejects.toThrow(/illegal reclassification/i);
    expect(backend.setType).not.toHaveBeenCalled();
  });

  it('throws when the backend does not support setType', async () => {
    const backend = makeBackend({ setType: undefined });
    const commands = new BackendTaskWriteCommands(backend);

    await expect(commands.setType('notion:abc', '📐 Design')).rejects.toThrow(
      /not supported/i,
    );
  });
});

describe('TaskWriteCommands.setProperties', () => {
  it('updates Priority and Task Name', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await commands.setProperties('notion:abc', {
      priority: '🔴 High',
      title: 'Renamed task',
    });

    expect(backend.setProperties).toHaveBeenCalledWith(
      'notion:abc',
      { priority: '🔴 High', title: 'Renamed task' },
      undefined,
    );
  });

  it('rejects an attempt to set Status/Type/Depends On through it', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await expect(
      commands.setProperties('notion:abc', {
        status: '✅ Done',
      } as never),
    ).rejects.toThrow(/setProperties does not support/i);
    expect(backend.setProperties).not.toHaveBeenCalled();
  });

  it('throws when the backend does not support setProperties', async () => {
    const backend = makeBackend({ setProperties: undefined });
    const commands = new BackendTaskWriteCommands(backend);

    await expect(
      commands.setProperties('notion:abc', { priority: '🔴 High' }),
    ).rejects.toThrow(/not supported/i);
  });
});

describe('TaskWriteCommands.archive', () => {
  it('delegates to backend.archive', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await commands.archive('notion:abc', { source: 'human' });

    expect(backend.archive).toHaveBeenCalledWith('notion:abc', {
      source: 'human',
    });
  });

  it('throws when the backend does not support archive', async () => {
    const backend = makeBackend({ archive: undefined });
    const commands = new BackendTaskWriteCommands(backend);

    await expect(commands.archive('notion:abc')).rejects.toThrow(
      /not supported/i,
    );
  });
});

describe('TaskWriteCommands.moveTask', () => {
  function makeMoveParams(): Parameters<
    BackendTaskWriteCommands['moveTask']
  >[0] {
    return {
      taskId: 'notion:abc',
      content: {
        title: 'Some task',
        bodyMarkdown: '## Summary\nSummary',
        status: 'In Progress',
      },
      sourceMilestone: { id: 'ms-source', displayOrder: 1 },
      targetMilestone: {
        id: 'ms-target',
        displayOrder: 2,
        databaseId: 'db-target',
      },
      originalDisposition: 'archive',
    };
  }

  function makeMoveBackend(overrides: Partial<TaskBackend> = {}) {
    return makeBackend({
      fetchReadyTasks: vi
        .fn()
        .mockResolvedValue([{ task: { id: 'notion:abc', dependsOn: [] } }]),
      appendImplementationNote: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    });
  }

  it('rolls back the created target page when updateBodyRaw throws, and leaves the source undisposed', async () => {
    const backend = makeMoveBackend({
      updateBodyRaw: vi.fn().mockRejectedValue(new Error('Notion 400')),
    });
    const commands = new BackendTaskWriteCommands(backend);

    await expect(commands.moveTask(makeMoveParams())).rejects.toThrow(
      /Notion 400/,
    );

    expect(backend.createTask).toHaveBeenCalledTimes(1);
    expect(backend.archive).toHaveBeenCalledWith('notion:new-id', undefined);
    expect(backend.archive).not.toHaveBeenCalledWith('notion:abc', undefined);
  });

  it('performs a successful move: one target page with body + status restored, original disposed', async () => {
    const backend = makeMoveBackend();
    const commands = new BackendTaskWriteCommands(backend);

    const result = await commands.moveTask(makeMoveParams());

    expect(result.newTaskId).toBe('notion:new-id');
    expect(backend.createTask).toHaveBeenCalledTimes(1);
    expect(backend.updateBodyRaw).toHaveBeenCalledWith(
      'notion:new-id',
      '## Summary\nSummary',
      undefined,
    );
    expect(backend.updateStatus).toHaveBeenCalledWith(
      'notion:new-id',
      STATUS_DISPLAY['In Progress'],
      undefined,
    );
    expect(backend.archive).toHaveBeenCalledWith('notion:abc', undefined);
    expect(backend.archive).not.toHaveBeenCalledWith(
      'notion:new-id',
      undefined,
    );
  });
});

describe('TaskWriteCommands.accreteGateContribution', () => {
  const sourceTask = {
    id: 'notion:src-1',
    title: 'Add the webhook',
    project: 'polimarket-analyser',
    milestone: 'M12',
  };

  it('mints a gate_item per item (source id + title recorded) and records an "items" marker', async () => {
    mockInsertItem
      .mockReturnValueOnce({ id: 'gate-item-1' })
      .mockReturnValueOnce({ id: 'gate-item-2' });
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    const result = await commands.accreteGateContribution(
      sourceTask,
      [{ text: 'Verify the webhook fires' }, { text: 'Check the retry path' }],
      'Read-Only',
    );

    expect(mockInsertItem).toHaveBeenCalledTimes(2);
    expect(mockInsertItem).toHaveBeenCalledWith(
      expect.objectContaining({
        project: 'polimarket-analyser',
        milestone: 'M12',
        text: 'Verify the webhook fires',
        classification: 'Read-Only',
        sources: [
          { sourceTaskId: 'notion:src-1', sourceTaskTitle: 'Add the webhook' },
        ],
      }),
    );
    expect(mockInsertItem.mock.calls[0][0].updatedAt).toBeDefined();

    expect(mockRecordAccretionMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTaskId: 'notion:src-1',
        project: 'polimarket-analyser',
        milestone: 'M12',
        decision: 'items',
      }),
    );
    expect(result.itemIds).toEqual(['gate-item-1', 'gate-item-2']);
  });

  it('records a "none" marker with its reason and mints no items', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    const result = await commands.accreteGateContribution(
      sourceTask,
      [],
      'none',
      'The change only adds a pure formatting helper with no I/O or user-visible effect.',
    );

    expect(mockInsertItem).not.toHaveBeenCalled();
    expect(mockRecordAccretionMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTaskId: 'notion:src-1',
        decision: 'none',
        reason:
          'The change only adds a pure formatting helper with no I/O or user-visible effect.',
      }),
    );
    expect(result.itemIds).toEqual([]);
  });

  it('records an "n/a" marker with its reason and mints no items', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await commands.accreteGateContribution(
      sourceTask,
      [],
      'n/a',
      'This task type is exempt from gate accretion.',
    );

    expect(mockInsertItem).not.toHaveBeenCalled();
    expect(mockRecordAccretionMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTaskId: 'notion:src-1',
        decision: 'n/a',
        reason: 'This task type is exempt from gate accretion.',
      }),
    );
  });

  it('rejects a bare "none" decision with no reason', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await expect(
      commands.accreteGateContribution(sourceTask, [], 'none'),
    ).rejects.toThrow(/substantive, non-empty reason/);
    expect(mockRecordAccretionMarker).not.toHaveBeenCalled();
  });

  it('rejects a bare "none" decision with a whitespace-only reason', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await expect(
      commands.accreteGateContribution(sourceTask, [], 'none', '   '),
    ).rejects.toThrow(/substantive, non-empty reason/);
  });

  it('rejects a bare "n/a" decision with no reason', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await expect(
      commands.accreteGateContribution(sourceTask, [], 'n/a'),
    ).rejects.toThrow(/substantive, non-empty reason/);
  });

  it('does not require a reason for an "items" classification', async () => {
    mockInsertItem.mockReturnValueOnce({ id: 'gate-item-1' });
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await commands.accreteGateContribution(
      sourceTask,
      [{ text: 'Verify the webhook fires' }],
      'Read-Only',
    );

    expect(mockRecordAccretionMarker).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'items', reason: undefined }),
    );
  });

  it('rejects "none"/"n/a" when items are non-empty', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await expect(
      commands.accreteGateContribution(
        sourceTask,
        [{ text: 'stray item' }],
        'none',
        'a reason',
      ),
    ).rejects.toThrow(/empty items array/);
  });

  it('rejects a classification decision with an empty items array', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await expect(
      commands.accreteGateContribution(sourceTask, [], 'Prod-Mutating'),
    ).rejects.toThrow(/at least one item/);
  });

  it('rejects a taskId that does not resolve to a real board task and mints no gate_item', async () => {
    const backend = makeBackend({
      fetchTaskPage: vi.fn().mockRejectedValue(new Error('not found')),
    });
    const commands = new BackendTaskWriteCommands(backend);

    await expect(
      commands.accreteGateContribution(
        sourceTask,
        [{ text: 'Verify the webhook fires' }],
        'Read-Only',
      ),
    ).rejects.toThrow(/not found on the board/);

    expect(mockInsertItem).not.toHaveBeenCalled();
    expect(mockRecordAccretionMarker).not.toHaveBeenCalled();
  });

  it('fills the source merge commit immediately when the source task is already merged', async () => {
    mockGetMergeCommitForTask.mockReturnValue('already-merged-sha');
    mockInsertItem.mockReturnValueOnce({ id: 'gate-item-1' });
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await commands.accreteGateContribution(
      sourceTask,
      [{ text: 'Verify the webhook fires' }],
      'Read-Only',
    );

    expect(mockGetMergeCommitForTask).toHaveBeenCalledWith('notion:src-1');
    expect(mockInsertItem).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [
          {
            sourceTaskId: 'notion:src-1',
            sourceTaskTitle: 'Add the webhook',
            mergeCommit: 'already-merged-sha',
          },
        ],
      }),
    );
  });

  it('normalizes a raw (unprefixed) source task id to the canonical prefixed form', async () => {
    mockInsertItem.mockReturnValueOnce({ id: 'gate-item-1' });
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);
    const rawSourceTask = { ...sourceTask, id: 'src-1' };

    await commands.accreteGateContribution(
      rawSourceTask,
      [{ text: 'Verify the webhook fires' }],
      'Read-Only',
    );

    expect(mockGetMergeCommitForTask).toHaveBeenCalledWith('notion:src-1');
    expect(mockInsertItem).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [expect.objectContaining({ sourceTaskId: 'notion:src-1' })],
      }),
    );
    expect(mockRecordAccretionMarker).toHaveBeenCalledWith(
      expect.objectContaining({ sourceTaskId: 'notion:src-1' }),
    );
  });

  it('normalizes a milestone UUID to the canonical display name before insertGateItem/recordAccretionMarker', async () => {
    mockInsertItem.mockReturnValueOnce({ id: 'gate-item-1' });
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);
    const uuidSourceTask = { ...sourceTask, milestone: M12_UUID };

    await commands.accreteGateContribution(
      uuidSourceTask,
      [{ text: 'Verify the webhook fires' }],
      'Read-Only',
    );

    expect(mockInsertItem).toHaveBeenCalledWith(
      expect.objectContaining({ milestone: 'M12' }),
    );
    expect(mockRecordAccretionMarker).toHaveBeenCalledWith(
      expect.objectContaining({ milestone: 'M12' }),
    );
  });
});

describe('TaskWriteCommands.stageSeedContribution', () => {
  const sourceTask = {
    id: 'notion:src-1',
    title: 'Add the webhook',
    project: 'polimarket-analyser',
    milestone: 'M12',
  };

  it('mints a seed_item per seed (source id + title recorded) and records a "seeds" marker', async () => {
    mockInsertSeedItem
      .mockReturnValueOnce({ id: 'seed-item-1' })
      .mockReturnValueOnce({ id: 'seed-item-2' });
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    const result = await commands.stageSeedContribution(
      sourceTask,
      [
        { spec: 'Add webhook_url to config' },
        { spec: 'Add retry_count to config' },
      ],
      'seeds',
    );

    expect(mockInsertSeedItem).toHaveBeenCalledTimes(2);
    expect(mockInsertSeedItem).toHaveBeenCalledWith(
      expect.objectContaining({
        project: 'polimarket-analyser',
        milestone: 'M12',
        spec: 'Add webhook_url to config',
        sources: [
          { sourceTaskId: 'notion:src-1', sourceTaskTitle: 'Add the webhook' },
        ],
      }),
    );
    expect(mockInsertSeedItem.mock.calls[0][0].updatedAt).toBeDefined();

    expect(mockRecordSeedAccretionMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTaskId: 'notion:src-1',
        project: 'polimarket-analyser',
        milestone: 'M12',
        decision: 'seeds',
      }),
    );
    expect(result.itemIds).toEqual(['seed-item-1', 'seed-item-2']);
  });

  it('records a "none" marker and mints no seeds', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    const result = await commands.stageSeedContribution(sourceTask, [], 'none');

    expect(mockInsertSeedItem).not.toHaveBeenCalled();
    expect(mockRecordSeedAccretionMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTaskId: 'notion:src-1',
        decision: 'none',
      }),
    );
    expect(result.itemIds).toEqual([]);
  });

  it('records an "n/a" marker and mints no seeds', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await commands.stageSeedContribution(sourceTask, [], 'n/a');

    expect(mockInsertSeedItem).not.toHaveBeenCalled();
    expect(mockRecordSeedAccretionMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTaskId: 'notion:src-1',
        decision: 'n/a',
      }),
    );
  });

  it('leaves min_deployed_commit unset (not part of the insertItem call)', async () => {
    mockInsertSeedItem.mockReturnValueOnce({ id: 'seed-item-1' });
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await commands.stageSeedContribution(
      sourceTask,
      [{ spec: 'Add webhook_url to config' }],
      'seeds',
    );

    expect(mockInsertSeedItem.mock.calls[0][0]).not.toHaveProperty(
      'minDeployedCommit',
    );
  });

  it('rejects "none"/"n/a" when seeds are non-empty', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await expect(
      commands.stageSeedContribution(
        sourceTask,
        [{ spec: 'stray seed' }],
        'none',
      ),
    ).rejects.toThrow(/empty seeds array/);
  });

  it('rejects a "seeds" decision with an empty seeds array', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await expect(
      commands.stageSeedContribution(sourceTask, [], 'seeds'),
    ).rejects.toThrow(/at least one seed/);
  });

  it('rejects a taskId that does not resolve to a real board task and mints no seed_item', async () => {
    const backend = makeBackend({
      fetchTaskPage: vi.fn().mockRejectedValue(new Error('not found')),
    });
    const commands = new BackendTaskWriteCommands(backend);

    await expect(
      commands.stageSeedContribution(
        sourceTask,
        [{ spec: 'Add webhook_url to config' }],
        'seeds',
      ),
    ).rejects.toThrow(/not found on the board/);

    expect(mockInsertSeedItem).not.toHaveBeenCalled();
    expect(mockRecordSeedAccretionMarker).not.toHaveBeenCalled();
  });

  it('normalizes a milestone UUID to the canonical display name before insertSeedItem/recordSeedAccretionMarker', async () => {
    mockInsertSeedItem.mockReturnValueOnce({ id: 'seed-item-1' });
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);
    const uuidSourceTask = { ...sourceTask, milestone: M12_UUID };

    await commands.stageSeedContribution(
      uuidSourceTask,
      [{ spec: 'Add webhook_url to config' }],
      'seeds',
    );

    expect(mockInsertSeedItem).toHaveBeenCalledWith(
      expect.objectContaining({ milestone: 'M12' }),
    );
    expect(mockRecordSeedAccretionMarker).toHaveBeenCalledWith(
      expect.objectContaining({ milestone: 'M12' }),
    );
  });
});

describe('TaskWriteCommands.flipToReady', () => {
  const flipParams = {
    taskId: 'notion:abc',
    title: 'Add the webhook',
    project: 'polimarket-analyser',
    milestone: 'M12',
    dependsOn: ['notion:dep-1'],
    groomingGate: {
      size_check: { decision: 'no_split' as const },
      type_check: { decision: 'none' as const },
    },
    gateContribution: {
      classification: 'Read-Only' as const,
      items: [{ text: 'Verify the webhook fires' }],
    },
    seedContribution: {
      decision: 'seeds' as const,
      seeds: [{ spec: 'Add webhook_url to config' }],
    },
  };

  beforeEach(() => {
    mockInsertItem.mockReturnValue({ id: 'gate-item-1' });
    mockInsertSeedItem.mockReturnValue({ id: 'seed-item-1' });
    mockGetTaskCache.mockReturnValue(
      cacheRowWithStatus(STATUS_DISPLAY.Backlog),
    );
  });

  it('runs gate accretion, seed accretion, setDependsOn, and setStatus(Ready) in order', async () => {
    const calls: string[] = [];
    mockRecordAccretionMarker.mockImplementation(() => calls.push('gate'));
    mockRecordSeedAccretionMarker.mockImplementation(() => calls.push('seed'));
    const backend = makeBackend({
      setDependsOn: vi.fn().mockImplementation(async () => {
        calls.push('setDependsOn');
      }),
      updateStatus: vi.fn().mockImplementation(async () => {
        calls.push('setStatus');
      }),
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nAll good.'),
    });
    const commands = new BackendTaskWriteCommands(backend);

    const result = await commands.flipToReady(flipParams);

    expect(calls).toEqual(['gate', 'seed', 'setDependsOn', 'setStatus']);
    expect(backend.setDependsOn).toHaveBeenCalledWith(
      'notion:abc',
      ['notion:dep-1'],
      undefined,
    );
    expect(backend.updateStatus).toHaveBeenCalledWith(
      'notion:abc',
      '🗂️ Ready',
      expect.objectContaining({ groomingGate: flipParams.groomingGate }),
    );
    expect(result.gate.itemIds).toEqual(['gate-item-1']);
    expect(result.seed.itemIds).toEqual(['seed-item-1']);
    expect(mockRollbackGateContribution).not.toHaveBeenCalled();
    expect(mockRollbackSeedContribution).not.toHaveBeenCalled();
  });

  it('rolls back gate accretion (no seed accretion attempted) when seed accretion fails', async () => {
    mockRecordSeedAccretionMarker.mockImplementation(() => {
      throw new Error('seed store unavailable');
    });
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await expect(commands.flipToReady(flipParams)).rejects.toThrow(
      /seed store unavailable/,
    );

    expect(mockRollbackGateContribution).toHaveBeenCalledWith(
      ['gate-item-1'],
      'notion:abc',
    );
    expect(mockRollbackSeedContribution).not.toHaveBeenCalled();
    expect(backend.setDependsOn).not.toHaveBeenCalled();
    expect(backend.updateStatus).not.toHaveBeenCalled();
  });

  it('rolls back both accretions and never flips status when setDependsOn fails', async () => {
    const backend = makeBackend({
      setDependsOn: vi.fn().mockRejectedValue(new Error('Notion API down')),
    });
    const commands = new BackendTaskWriteCommands(backend);

    await expect(commands.flipToReady(flipParams)).rejects.toThrow(
      /Notion API down/,
    );

    expect(mockRollbackSeedContribution).toHaveBeenCalledWith(
      ['seed-item-1'],
      'notion:abc',
    );
    expect(mockRollbackGateContribution).toHaveBeenCalledWith(
      ['gate-item-1'],
      'notion:abc',
    );
    expect(backend.updateStatus).not.toHaveBeenCalled();
  });

  it('rolls back both accretions when the grooming promotion gate blocks the Ready flip', async () => {
    const backend = makeBackend({
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nAll good.'),
    });
    const commands = new BackendTaskWriteCommands(backend);

    await expect(
      commands.flipToReady({
        ...flipParams,
        groomingGate: { size_check: null, type_check: null },
      }),
    ).rejects.toBeInstanceOf(GroomingGateError);

    expect(mockRollbackSeedContribution).toHaveBeenCalledWith(
      ['seed-item-1'],
      'notion:abc',
    );
    expect(mockRollbackGateContribution).toHaveBeenCalledWith(
      ['gate-item-1'],
      'notion:abc',
    );
    expect(backend.updateStatus).not.toHaveBeenCalled();
  });

  it('succeeds with a validly-reasoned "none" gate contribution and no minimum item count', async () => {
    mockGetTaskCache.mockReturnValue(
      cacheRowWithStatus(STATUS_DISPLAY.Backlog),
    );
    const backend = makeBackend({
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nAll good.'),
    });
    const commands = new BackendTaskWriteCommands(backend);

    const result = await commands.flipToReady({
      ...flipParams,
      gateContribution: {
        classification: 'none',
        items: [],
        reason:
          'The change only adds a pure formatting helper with no I/O or user-visible effect.',
      },
    });

    expect(mockInsertItem).not.toHaveBeenCalled();
    expect(mockRecordAccretionMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'none',
        reason:
          'The change only adds a pure formatting helper with no I/O or user-visible effect.',
      }),
    );
    expect(result.gate.itemIds).toEqual([]);
    expect(backend.updateStatus).toHaveBeenCalled();
  });
});

describe('TaskWriteCommands + NotionTaskBackend — raw Notion UUID taskId (regression)', () => {
  // The groom-context bundle hands sessions raw Notion UUIDs (no 'notion:'
  // prefix). Applying a staged intent through the real NotionTaskBackend must
  // not throw "Invalid task ID (no colon)" for those ids.
  const rawTaskId = '39d22f91-52f3-813e-987d-df4e94649436';

  function makeNotionBackend(clientOverrides: Partial<NotionClient> = {}) {
    const client = {
      updateStatus: vi.fn().mockResolvedValue(undefined),
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue({ rawMarkdown: '## Summary\nAll good.' }),
      setDependsOn: vi.fn().mockResolvedValue(undefined),
      ...clientOverrides,
    } as unknown as NotionClient;
    return { client, backend: new NotionTaskBackend(client) };
  }

  it('applies setStatus without throwing when taskId is a raw Notion UUID', async () => {
    mockGetTaskCache.mockReturnValue(undefined);
    const { client, backend } = makeNotionBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await expect(
      commands.setStatus(rawTaskId, 'Ready', {
        groomingGate: {
          size_check: { decision: 'no_split' },
          type_check: { decision: 'none' },
        },
      }),
    ).resolves.toBeUndefined();

    expect(client.fetchTaskPage).toHaveBeenCalledWith(`notion:${rawTaskId}`);
    expect(client.updateStatus).toHaveBeenCalledWith(
      `notion:${rawTaskId}`,
      '🗂️ Ready',
    );
  });

  it('applies setDependsOn without throwing when taskId is a raw Notion UUID', async () => {
    mockGetTaskCache.mockReturnValue(undefined);
    const { client, backend } = makeNotionBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await expect(
      commands.setDependsOn(rawTaskId, ['notion:other-task']),
    ).resolves.toBeUndefined();

    expect(client.setDependsOn).toHaveBeenCalledWith(`notion:${rawTaskId}`, [
      'notion:other-task',
    ]);
  });
});
