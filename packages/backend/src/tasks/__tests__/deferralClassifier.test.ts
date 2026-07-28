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
  getMergeCommitForTask: vi.fn(),
  deleteTaskCacheRow: vi.fn(),
}));

vi.mock('../../gate/gateStore', () => ({
  insertItem: vi.fn(),
  recordAccretionMarker: vi.fn(),
  getAccretionMarker: vi.fn(),
  rollbackContribution: vi.fn(),
  rehomeItemsBySourceTask: vi.fn(),
}));

vi.mock('../../seed/seedStore', () => ({
  insertItem: vi.fn(),
  recordAccretionMarker: vi.fn(),
  getAccretionMarker: vi.fn(),
  rollbackContribution: vi.fn(),
  rehomeItemsBySourceTask: vi.fn(),
}));

const { mockLoggerDebug, mockLoggerWarn } = vi.hoisted(() => ({
  mockLoggerDebug: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock('../../logger', () => ({
  logger: {
    debug: mockLoggerDebug,
    warn: mockLoggerWarn,
    info: vi.fn(),
    error: vi.fn(),
  },
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
  mockLoggerDebug.mockReset();
  mockLoggerWarn.mockReset();

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
    expect(written.confidence).toBe(0);
    expect(written.findings).toEqual([]);
  });

  it('logs a warn diagnostic naming the parse error on unparseable classifier output', async () => {
    mockListStagedIntentsByGroup.mockReturnValue([makeRow()]);
    mockGetTaskCache.mockReturnValue({
      raw_json: JSON.stringify({ type: '💻 Code' }),
    });
    stubSpawn({ stdout: 'not json at all' });

    await classifyReadyProposal('group-1');

    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn.mock.calls[0][0]).toContain('parse');
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

describe('classifyReadyProposal — markdown-fenced classifier output', () => {
  it('parses a json-fenced verdict as clean', async () => {
    mockListStagedIntentsByGroup.mockReturnValue([makeRow()]);
    mockGetTaskCache.mockReturnValue({
      raw_json: JSON.stringify({ type: '💻 Code' }),
    });
    const fenced =
      '```json\n{"status": "clean", "confidence": 0.95, "findings": []}\n```';
    stubSpawn({ stdout: JSON.stringify({ result: fenced }) });

    await classifyReadyProposal('group-1');

    expect(mockSetStagedIntentAdvisory).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockSetStagedIntentAdvisory.mock.calls[0][1]);
    expect(written.status).toBe('clean');
    expect(written.confidence).toBe(0.95);
    expect(written.findings).toEqual([]);
  });

  it('parses a bare-fenced (no language tag) verdict identically', async () => {
    mockListStagedIntentsByGroup.mockReturnValue([makeRow()]);
    mockGetTaskCache.mockReturnValue({
      raw_json: JSON.stringify({ type: '💻 Code' }),
    });
    const fenced = '```\n{"status": "clean", "confidence": 0.95, "findings": []}\n```';
    stubSpawn({ stdout: JSON.stringify({ result: fenced }) });

    await classifyReadyProposal('group-1');

    const written = JSON.parse(mockSetStagedIntentAdvisory.mock.calls[0][1]);
    expect(written.status).toBe('clean');
    expect(written.confidence).toBe(0.95);
    expect(written.findings).toEqual([]);
  });

  it('parses an unfenced verdict identically (no regression on the working path)', async () => {
    mockListStagedIntentsByGroup.mockReturnValue([makeRow()]);
    mockGetTaskCache.mockReturnValue({
      raw_json: JSON.stringify({ type: '💻 Code' }),
    });
    stubSpawn({
      stdout: cliJsonWrap({
        status: 'clean',
        confidence: 0.95,
        findings: [],
      }),
    });

    await classifyReadyProposal('group-1');

    const written = JSON.parse(mockSetStagedIntentAdvisory.mock.calls[0][1]);
    expect(written.status).toBe('clean');
    expect(written.confidence).toBe(0.95);
    expect(written.findings).toEqual([]);
  });

  it('reports a fenced flagged verdict below FLAG_CONFIDENCE_THRESHOLD as clean', async () => {
    mockListStagedIntentsByGroup.mockReturnValue([makeRow()]);
    mockGetTaskCache.mockReturnValue({
      raw_json: JSON.stringify({ type: '💻 Code' }),
    });
    const fenced = JSON.stringify({
      status: 'flagged',
      confidence: 0.5,
      findings: [{ quote: 'q', detail: 'd' }],
    });
    stubSpawn({ stdout: JSON.stringify({ result: '```json\n' + fenced + '\n```' }) });

    await classifyReadyProposal('group-1');

    const written = JSON.parse(mockSetStagedIntentAdvisory.mock.calls[0][1]);
    expect(written.status).toBe('clean');
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

describe('classifyReadyProposal — task id normalization', () => {
  it('reaches classifyDeferral for a bare-uuid payload id whose cache row is keyed notion:<uuid>', async () => {
    const bareId = 'abc12345-aaaa-bbbb-cccc-abcdef123456';
    mockListStagedIntentsByGroup.mockReturnValue([
      makeRow({
        payload: JSON.stringify({ taskId: bareId, status: 'Ready' }),
        task_id: bareId,
      }),
    ]);
    mockGetTaskCache.mockImplementation((key: string) =>
      key === `notion:${bareId}`
        ? { raw_json: JSON.stringify({ type: '💻 Code' }) }
        : null,
    );
    stubSpawn({
      stdout: cliJsonWrap({ status: 'clean', confidence: 0, findings: [] }),
    });

    await classifyReadyProposal('group-1');

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSetStagedIntentAdvisory).toHaveBeenCalledTimes(1);
  });

  it('reaches classifyDeferral for a hyphenless payload id whose cache row is keyed notion:<hyphenless-id>', async () => {
    const hyphenlessId = '3aa22f9152f381e4adaefd58a25e6afa';
    mockListStagedIntentsByGroup.mockReturnValue([
      makeRow({
        payload: JSON.stringify({ taskId: hyphenlessId, status: 'Ready' }),
        task_id: hyphenlessId,
      }),
    ]);
    mockGetTaskCache.mockImplementation((key: string) =>
      key === `notion:${hyphenlessId}`
        ? { raw_json: JSON.stringify({ type: '💻 Code' }) }
        : null,
    );
    stubSpawn({
      stdout: cliJsonWrap({ status: 'clean', confidence: 0, findings: [] }),
    });

    await classifyReadyProposal('group-1');

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSetStagedIntentAdvisory).toHaveBeenCalledTimes(1);
  });

  it('still returns early for a genuinely non-implementer-bearing type (📐 Design) once the id resolves', async () => {
    const bareId = 'abc12345-aaaa-bbbb-cccc-abcdef123456';
    mockListStagedIntentsByGroup.mockReturnValue([
      makeRow({
        payload: JSON.stringify({ taskId: bareId, status: 'Ready' }),
        task_id: bareId,
      }),
    ]);
    mockGetTaskCache.mockImplementation((key: string) =>
      key === `notion:${bareId}`
        ? { raw_json: JSON.stringify({ type: '📐 Design' }) }
        : null,
    );

    await classifyReadyProposal('group-1');

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockSetStagedIntentAdvisory).not.toHaveBeenCalled();
  });

  it('logs a debug diagnostic naming the unresolved id when the cache lookup misses', async () => {
    mockListStagedIntentsByGroup.mockReturnValue([makeRow({ task_id: 't-1' })]);
    mockGetTaskCache.mockReturnValue(null);

    await classifyReadyProposal('group-1');

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockLoggerDebug).toHaveBeenCalledTimes(1);
    expect(mockLoggerDebug.mock.calls[0][0]).toContain('t-1');
  });

  it('uses the canonical getCachedType from TaskWriteCommands rather than a private duplicate', async () => {
    const bareId = 'abc12345-aaaa-bbbb-cccc-abcdef123456';
    mockListStagedIntentsByGroup.mockReturnValue([
      makeRow({
        payload: JSON.stringify({ taskId: bareId, status: 'Ready' }),
        task_id: bareId,
      }),
    ]);
    mockGetTaskCache.mockReturnValue({
      raw_json: JSON.stringify({ type: '💻 Code' }),
    });
    stubSpawn({
      stdout: cliJsonWrap({ status: 'clean', confidence: 0, findings: [] }),
    });

    await classifyReadyProposal('group-1');

    // getCachedType (TaskWriteCommands.ts) normalizes before reading the
    // cache — the private duplicate this task removes read the bare id raw.
    expect(mockGetTaskCache).toHaveBeenCalledWith(`notion:${bareId}`);
  });
});

describe('classifyReadyProposal — deterministic-tier gating', () => {
  it('does not run when the deterministic tiers would hard-block the proposed body', async () => {
    mockGetTaskBackend.mockReturnValue({
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue('This detail will be decided by the implementer.'),
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
