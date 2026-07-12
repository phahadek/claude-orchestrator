import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetTaskCache = vi.fn();
const mockRecordEvent = vi.fn();
const mockInsertItem = vi.fn();
const mockRecordAccretionMarker = vi.fn();
const mockGetAccretionMarker = vi.fn();

vi.mock('../../db/queries', () => ({
  getTaskCache: (...args: unknown[]) => mockGetTaskCache(...args),
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: (...args: unknown[]) => mockRecordEvent(...args),
}));

vi.mock('../../gate/gateStore', () => ({
  insertItem: (...args: unknown[]) => mockInsertItem(...args),
  recordAccretionMarker: (...args: unknown[]) =>
    mockRecordAccretionMarker(...args),
  getAccretionMarker: (...args: unknown[]) => mockGetAccretionMarker(...args),
}));

import {
  BackendTaskWriteCommands,
  isValidTransition,
  STATUS_DISPLAY,
} from '../TaskWriteCommands';
import { ReadinessGateError } from '../readinessGate';
import { GroomingGateError } from '../../groom/groomGate';
import type { TaskBackend } from '../TaskBackend';

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
    ...overrides,
  };
}

function cacheRowWithStatus(display: string) {
  return { raw_json: JSON.stringify({ status: display }) };
}

beforeEach(() => {
  mockGetTaskCache.mockReset();
  mockRecordEvent.mockReset();
  mockInsertItem.mockReset();
  mockRecordAccretionMarker.mockReset();
  mockGetAccretionMarker.mockReset();
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

    await commands.setStatus('notion:abc', 'Ready');

    expect(backend.updateStatus).toHaveBeenCalledWith(
      'notion:abc',
      '🗂️ Ready',
      undefined,
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
    });

    expect(backend.updateStatus).toHaveBeenCalledWith(
      'notion:abc',
      '🗂️ Ready',
      {
        source: 'human',
        sessionId: 'sess-1',
      },
    );
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
      await commands.setStatus('notion:abc', 'Ready');
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

    await commands.setStatus('notion:abc', 'Ready');

    expect(backend.updateStatus).toHaveBeenCalledWith(
      'notion:abc',
      '🗂️ Ready',
      undefined,
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

  it('does not run the grooming gate when no groomingGate entry is supplied', async () => {
    mockGetTaskCache.mockReturnValue(
      cacheRowWithStatus(STATUS_DISPLAY.Backlog),
    );
    const backend = makeBackend({
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nAll good.'),
    });
    const commands = new BackendTaskWriteCommands(backend);

    await commands.setStatus('notion:abc', 'Ready');

    expect(backend.updateStatus).toHaveBeenCalledWith(
      'notion:abc',
      '🗂️ Ready',
      undefined,
    );
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

  it('records a "none" marker and mints no items', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    const result = await commands.accreteGateContribution(
      sourceTask,
      [],
      'none',
    );

    expect(mockInsertItem).not.toHaveBeenCalled();
    expect(mockRecordAccretionMarker).toHaveBeenCalledWith(
      expect.objectContaining({ sourceTaskId: 'notion:src-1', decision: 'none' }),
    );
    expect(result.itemIds).toEqual([]);
  });

  it('records an "n/a" marker and mints no items', async () => {
    const backend = makeBackend();
    const commands = new BackendTaskWriteCommands(backend);

    await commands.accreteGateContribution(sourceTask, [], 'n/a');

    expect(mockInsertItem).not.toHaveBeenCalled();
    expect(mockRecordAccretionMarker).toHaveBeenCalledWith(
      expect.objectContaining({ sourceTaskId: 'notion:src-1', decision: 'n/a' }),
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
});
