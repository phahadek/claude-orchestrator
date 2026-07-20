/**
 * Unit tests for the Tier-3 semantic readiness advisory classifier
 * (deferralClassifier.ts): scope gating (type + deterministic tiers),
 * updateBody-vs-stored body selection, fail-open error handling, and
 * independence from the deterministic `annotation` channel.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

const { mockGetTaskBackend, mockRecordEvent, mockSpawn } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
  mockRecordEvent: vi.fn(),
  mockSpawn: vi.fn(),
}));

vi.mock('../TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: mockRecordEvent,
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));

const {
  mockListStagedIntentsByGroup,
  mockGetTaskCache,
  mockSetStagedIntentAdvisory,
} = vi.hoisted(() => ({
  mockListStagedIntentsByGroup: vi.fn(),
  mockGetTaskCache: vi.fn(),
  mockSetStagedIntentAdvisory: vi.fn(),
}));

vi.mock('../../db/queries', () => ({
  listStagedIntentsByGroup: mockListStagedIntentsByGroup,
  getTaskCache: mockGetTaskCache,
  setStagedIntentAdvisory: mockSetStagedIntentAdvisory,
}));

import { classifyReadyProposal } from '../deferralClassifier';

/** A fake ChildProcess: emits stdout data then closes with the given exit code. */
function fakeClassifyProcess(opts: {
  stdout?: string;
  exitCode?: number;
  neverClose?: boolean;
}) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    kill: (signal?: string) => void;
    pid: number;
  };
  proc.stdout = new PassThrough();
  proc.pid = 12345;
  proc.kill = vi.fn();
  queueMicrotask(() => {
    if (opts.stdout) proc.stdout.emit('data', Buffer.from(opts.stdout));
    if (!opts.neverClose) proc.emit('close', opts.exitCode ?? 0);
  });
  return proc;
}

function cliJsonWrap(verdict: unknown): string {
  return JSON.stringify({ result: JSON.stringify(verdict) });
}

/**
 * Wires mockSpawn to construct the fake process lazily, at spawn-call time —
 * constructing it eagerly (mockReturnValue) schedules its close event before
 * classifyDeferral has attached listeners, since several awaits separate
 * test setup from the actual spawn() call.
 */
function stubSpawn(opts: {
  stdout?: string;
  exitCode?: number;
  neverClose?: boolean;
}) {
  mockSpawn.mockImplementation(() => fakeClassifyProcess(opts));
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'intent-1',
    kind: 'task.setStatus',
    payload: JSON.stringify({ taskId: 't-1', status: 'Ready' }),
    payload_hash: 'h',
    task_id: 't-1',
    project_id: 'proj-1',
    session_id: null,
    group_id: 'group-1',
    state: 'staged',
    supersedes: null,
    annotation: null,
    decision_proposal: null,
    advisory: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockRecordEvent.mockReset();
  mockSpawn.mockReset();
  mockListStagedIntentsByGroup.mockReset();
  mockGetTaskCache.mockReset();
  mockSetStagedIntentAdvisory.mockReset();

  mockGetTaskBackend.mockReturnValue({
    fetchTaskPage: vi.fn().mockResolvedValue('A clean, ready task body.'),
  });
});

describe('classifyReadyProposal — type scope', () => {
  it('skips a 📐 Design target', async () => {
    mockListStagedIntentsByGroup.mockReturnValue([makeRow()]);
    mockGetTaskCache.mockReturnValue({
      raw_json: JSON.stringify({ type: '📐 Design' }),
    });

    await classifyReadyProposal('group-1');

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockSetStagedIntentAdvisory).not.toHaveBeenCalled();
  });

  it('skips a 📋 Planning target', async () => {
    mockListStagedIntentsByGroup.mockReturnValue([makeRow()]);
    mockGetTaskCache.mockReturnValue({
      raw_json: JSON.stringify({ type: '📋 Planning' }),
    });

    await classifyReadyProposal('group-1');

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockSetStagedIntentAdvisory).not.toHaveBeenCalled();
  });

  it('runs for a 💻 Code target', async () => {
    mockListStagedIntentsByGroup.mockReturnValue([makeRow()]);
    mockGetTaskCache.mockReturnValue({
      raw_json: JSON.stringify({ type: '💻 Code' }),
    });
    stubSpawn({
      stdout: cliJsonWrap({ status: 'clean', confidence: 0, findings: [] }),
    });

    await classifyReadyProposal('group-1');

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSetStagedIntentAdvisory).toHaveBeenCalledTimes(1);
  });

  it('runs for a 🔧 Operational target', async () => {
    mockListStagedIntentsByGroup.mockReturnValue([makeRow()]);
    mockGetTaskCache.mockReturnValue({
      raw_json: JSON.stringify({ type: '🔧 Operational' }),
    });
    stubSpawn({
      stdout: cliJsonWrap({ status: 'clean', confidence: 0, findings: [] }),
    });

    await classifyReadyProposal('group-1');

    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('runs for a 🧪 Testing target', async () => {
    mockListStagedIntentsByGroup.mockReturnValue([makeRow()]);
    mockGetTaskCache.mockReturnValue({
      raw_json: JSON.stringify({ type: '🧪 Testing' }),
    });
    stubSpawn({
      stdout: cliJsonWrap({ status: 'clean', confidence: 0, findings: [] }),
    });

    await classifyReadyProposal('group-1');

    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});

describe('classifyReadyProposal — body selection', () => {
  it('classifies the group updateBody payload when present, else the stored body', async () => {
    const fetchTaskPage = vi.fn().mockResolvedValue('STORED BODY');
    mockGetTaskBackend.mockReturnValue({ fetchTaskPage });
    mockGetTaskCache.mockReturnValue({
      raw_json: JSON.stringify({ type: '💻 Code' }),
    });
    mockListStagedIntentsByGroup.mockReturnValue([
      makeRow(),
      makeRow({
        id: 'intent-2',
        kind: 'task.updateBody',
        payload: JSON.stringify({
          taskId: 't-1',
          sections: {
            summary: 'PROPOSED SUMMARY',
            dependencies: [],
            context: [],
            automatedCriteria: [],
            manualCriteria: [],
          },
        }),
      }),
    ]);
    let capturedPrompt = '';
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      capturedPrompt = args[args.length - 1];
      return fakeClassifyProcess({
        stdout: cliJsonWrap({ status: 'clean', confidence: 0, findings: [] }),
      });
    });

    await classifyReadyProposal('group-1');

    expect(capturedPrompt).toContain('PROPOSED SUMMARY');
    expect(capturedPrompt).not.toContain('STORED BODY');
  });
});

describe('classifyReadyProposal — fail-open error handling', () => {
  it('yields status:errored and never throws on unparseable classifier output', async () => {
    mockListStagedIntentsByGroup.mockReturnValue([makeRow()]);
    mockGetTaskCache.mockReturnValue({
      raw_json: JSON.stringify({ type: '💻 Code' }),
    });
    stubSpawn({ stdout: 'not json at all' });

    await expect(classifyReadyProposal('group-1')).resolves.not.toThrow();

    expect(mockSetStagedIntentAdvisory).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockSetStagedIntentAdvisory.mock.calls[0][1]);
    expect(written.status).toBe('errored');
  });

  it('yields status:errored on a non-zero exit code (classify error)', async () => {
    mockListStagedIntentsByGroup.mockReturnValue([makeRow()]);
    mockGetTaskCache.mockReturnValue({
      raw_json: JSON.stringify({ type: '💻 Code' }),
    });
    stubSpawn({ stdout: '', exitCode: 1 });

    await classifyReadyProposal('group-1');

    const written = JSON.parse(mockSetStagedIntentAdvisory.mock.calls[0][1]);
    expect(written.status).toBe('errored');
  });
});

describe('classifyReadyProposal — advisory/annotation independence', () => {
  it('populates advisory without ever touching annotation', async () => {
    mockListStagedIntentsByGroup.mockReturnValue([makeRow()]);
    mockGetTaskCache.mockReturnValue({
      raw_json: JSON.stringify({ type: '💻 Code' }),
    });
    stubSpawn({
      stdout: cliJsonWrap({
        status: 'flagged',
        confidence: 0.9,
        findings: [{ quote: 'q', detail: 'd' }],
      }),
    });

    await classifyReadyProposal('group-1');

    expect(mockSetStagedIntentAdvisory).toHaveBeenCalledTimes(1);
    const [id, advisoryJson] = mockSetStagedIntentAdvisory.mock.calls[0];
    expect(id).toBe('intent-1');
    const advisory = JSON.parse(advisoryJson);
    expect(advisory.status).toBe('flagged');
    expect(advisory.tier).toBe('semantic');
  });
});

describe('classifyReadyProposal — deterministic-tier gating', () => {
  it('does not run when the deterministic tiers would hard-block the proposed body', async () => {
    mockGetTaskBackend.mockReturnValue({
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue(
          'This detail will be decided by the implementer.',
        ),
    });
    mockListStagedIntentsByGroup.mockReturnValue([makeRow()]);
    mockGetTaskCache.mockReturnValue({
      raw_json: JSON.stringify({ type: '💻 Code' }),
    });

    await classifyReadyProposal('group-1');

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockSetStagedIntentAdvisory).not.toHaveBeenCalled();
  });
});
