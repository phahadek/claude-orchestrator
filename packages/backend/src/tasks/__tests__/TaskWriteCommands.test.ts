import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetTaskCache = vi.fn();

vi.mock('../../db/queries', () => ({
  getTaskCache: (...args: unknown[]) => mockGetTaskCache(...args),
}));

import {
  BackendTaskWriteCommands,
  isValidTransition,
  STATUS_DISPLAY,
} from '../TaskWriteCommands';
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
    ...overrides,
  };
}

function cacheRowWithStatus(display: string) {
  return { raw_json: JSON.stringify({ status: display }) };
}

beforeEach(() => {
  mockGetTaskCache.mockReset();
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
