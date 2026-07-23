import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../db/queries', () => ({
  upsertSessionEvent: vi.fn().mockReturnValue(1),
  updateSessionStatus: vi.fn(),
  markSessionDone: vi.fn(),
  markSessionIdle: vi.fn(),
  getEventsBySession: vi.fn().mockReturnValue([]),
  insertPermissionDenial: vi.fn(),
  upsertPullRequest: vi.fn(),
  incrementTokens: vi.fn(),
  incrementCompactionCount: vi.fn(),
  setContextOccupancy: vi.fn(),
  setSessionModel: vi.fn(),
  setSessionMetadata: vi.fn(),
  getPRBySessionId: vi.fn().mockReturnValue(null),
  setHeadSha: vi.fn(),
  setPauseReason: vi.fn(),
  setSessionPauseReason: vi.fn(),
  insertPauseInterval: vi.fn(),
  getSessionTags: vi.fn().mockReturnValue([]),
  setSessionTags: vi.fn(),
  resetTaskCrashCount: vi.fn(),
  getSession: vi.fn().mockReturnValue(null),
  ackPendingComments: vi.fn(),
  listUndeliveredInboxItems: vi.fn().mockReturnValue([]),
  markInboxItemsDelivered: vi.fn(),
}));

vi.mock('../../config', () => ({
  ALLOWED_TOOLS: [],
  GITHUB_REPO: 'owner/repo',
  BASH_MAX_OUTPUT_LENGTH: 30000,
  BASH_DEFAULT_TIMEOUT_MS: 300000,
  runtimeSettings: { corporate_mode_enabled: false },
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    attachPR: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
  }),
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
  countPushFailureEvents: vi.fn().mockReturnValue(0),
}));

vi.mock('../filePollutionCheck', () => ({
  runFilePollutionCheck: vi.fn().mockResolvedValue({ revertCommitSha: null }),
}));

vi.mock('../../github/PRBodyValidator', () => ({
  validatePRBody: vi.fn().mockReturnValue({ valid: true, missingSections: [] }),
  buildValidationComment: vi.fn().mockReturnValue(''),
}));

vi.mock('../../github/CommitAttributionWatcher', () => ({
  checkCommitAttribution: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../sessionRecovery', () => ({
  recoverSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd === 'git rev-parse HEAD') return 'abc1234567890\n';
    if (cmd === 'git branch --show-current') return 'feature/my-task\n';
    throw new Error(`unexpected execSync: ${cmd}`);
  }),
}));

vi.mock('../CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockReturnValue(new Promise(() => {})),
    sendMessage: vi.fn(),
    endSession: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    hasSpawnError: false,
  })),
}));

vi.mock('../../db/pauseReason', () => ({
  pauseReasonFromCanonical: vi.fn(),
  serializePauseReason: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { parseGateVerifyDisposition } from '../AgentSession';
import { AgentSession } from '../AgentSession';
import { getPRBySessionId } from '../../db/queries';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession() {
  const taskBackend = {
    attachPR: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
  };
  return new AgentSession(
    'test-session-id',
    'https://notion.so/task',
    'https://notion.so/project',
    taskBackend as never,
    '/tmp/worktree',
    'task-123',
    undefined,
    undefined,
    'ops',
    undefined,
    undefined,
  );
}

function sendEvent(session: AgentSession, event: Record<string, unknown>) {
  (
    session as unknown as {
      handleRawEvent: (e: Record<string, unknown>) => void;
    }
  ).handleRawEvent(event);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPRBySessionId).mockReturnValue(null);
});

// ── parseGateVerifyDisposition ───────────────────────────────────────────────

describe('parseGateVerifyDisposition()', () => {
  it('returns null when no "gate_verify" key present', () => {
    expect(parseGateVerifyDisposition('Some regular text')).toBeNull();
    expect(parseGateVerifyDisposition('')).toBeNull();
  });

  it('parses a pass disposition with evidence', () => {
    const text = `Investigated the deploy script.\n\n{"gate_verify":{"gate_item_id":"item-1","disposition":"pass","evidence":{"note":"env var confirmed via audit_log"}}}\n`;
    const result = parseGateVerifyDisposition(text);
    expect(result).toEqual({
      gateItemId: 'item-1',
      disposition: 'pass',
      evidence: { note: 'env var confirmed via audit_log' },
    });
  });

  it('parses a fail disposition', () => {
    const text = `{"gate_verify":{"gate_item_id":"item-2","disposition":"fail","evidence":{"note":"env var missing"}}}`;
    const result = parseGateVerifyDisposition(text);
    expect(result).toEqual({
      gateItemId: 'item-2',
      disposition: 'fail',
      evidence: { note: 'env var missing' },
    });
  });

  it('parses a needs-setup disposition', () => {
    const text = `{"gate_verify":{"gate_item_id":"item-3","disposition":"needs-setup"}}`;
    const result = parseGateVerifyDisposition(text);
    expect(result).toEqual({
      gateItemId: 'item-3',
      disposition: 'needs-setup',
      evidence: undefined,
    });
  });

  it('returns null for malformed JSON', () => {
    expect(parseGateVerifyDisposition('{"gate_verify": [broken')).toBeNull();
  });

  it('returns null when disposition is not pass/fail/needs-setup', () => {
    const text = `{"gate_verify":{"gate_item_id":"item-4","disposition":"maybe"}}`;
    expect(parseGateVerifyDisposition(text)).toBeNull();
  });

  it('returns null when gate_item_id is missing or empty', () => {
    expect(
      parseGateVerifyDisposition('{"gate_verify":{"disposition":"pass"}}'),
    ).toBeNull();
    expect(
      parseGateVerifyDisposition(
        '{"gate_verify":{"gate_item_id":"","disposition":"pass"}}',
      ),
    ).toBeNull();
  });

  it('parses a reclassify proposal to Human-Observation alongside a disposition', () => {
    const text = `{"gate_verify":{"gate_item_id":"item-6","disposition":"needs-setup","reclassify":{"to":"Human-Observation","reason":"describes a rendered UI block"}}}`;
    const result = parseGateVerifyDisposition(text);
    expect(result).toEqual({
      gateItemId: 'item-6',
      disposition: 'needs-setup',
      evidence: undefined,
      reclassify: {
        to: 'Human-Observation',
        reason: 'describes a rendered UI block',
      },
    });
  });

  it('parses a reclassify proposal to needs-triage', () => {
    const text = `{"gate_verify":{"gate_item_id":"item-7","disposition":"needs-setup","reclassify":{"to":"needs-triage","reason":"unclear what tier fits"}}}`;
    const result = parseGateVerifyDisposition(text);
    expect(result?.reclassify).toEqual({
      to: 'needs-triage',
      reason: 'unclear what tier fits',
    });
  });

  it('drops a reclassify proposal targeting an auto-run tier rather than accepting it', () => {
    const text = `{"gate_verify":{"gate_item_id":"item-8","disposition":"needs-setup","reclassify":{"to":"Read-Only","reason":"looks headless"}}}`;
    const result = parseGateVerifyDisposition(text);
    expect(result?.disposition).toBe('needs-setup');
    expect(result?.reclassify).toBeUndefined();
  });

  it('drops a reclassify proposal missing a reason', () => {
    const text = `{"gate_verify":{"gate_item_id":"item-9","disposition":"needs-setup","reclassify":{"to":"Human-Observation"}}}`;
    const result = parseGateVerifyDisposition(text);
    expect(result?.reclassify).toBeUndefined();
  });

  it('omits reclassify when absent from the report', () => {
    const text = `{"gate_verify":{"gate_item_id":"item-10","disposition":"pass","evidence":{"note":"ok"}}}`;
    const result = parseGateVerifyDisposition(text);
    expect(result?.reclassify).toBeUndefined();
  });
});

// ── AgentSession: gate_verify_disposition emission ───────────────────────────

describe('AgentSession — gate_verify_disposition emission', () => {
  it('emits gate_verify_disposition after result event when block detected, with no PR needed', async () => {
    const session = makeSession();
    const emitted: unknown[] = [];
    session.on('gate_verify_disposition', (p) => emitted.push(p));

    sendEvent(session, {
      type: 'assistant',
      message: {
        id: 'msg_gate_1',
        content: [
          {
            type: 'text',
            text: 'Confirmed via audit_log.\n\n{"gate_verify":{"gate_item_id":"item-1","disposition":"pass","evidence":{"note":"confirmed"}}}',
          },
        ],
      },
    });

    sendEvent(session, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(getPRBySessionId).toHaveBeenCalled();
    expect(emitted).toHaveLength(1);
    const payload = emitted[0] as {
      sessionId: string;
      disposition: {
        gateItemId: string;
        disposition: string;
        evidence?: unknown;
      };
    };
    expect(payload.sessionId).toBe('test-session-id');
    expect(payload.disposition).toEqual({
      gateItemId: 'item-1',
      disposition: 'pass',
      evidence: { note: 'confirmed' },
    });
  });

  it('does not emit gate_verify_disposition when no block present', async () => {
    const session = makeSession();
    const emitted: unknown[] = [];
    session.on('gate_verify_disposition', (p) => emitted.push(p));

    sendEvent(session, {
      type: 'assistant',
      message: {
        id: 'msg_no_gate_verify',
        content: [{ type: 'text', text: 'Nothing conclusive yet.' }],
      },
    });

    sendEvent(session, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(emitted).toHaveLength(0);
  });

  it('does not emit gate_verify_disposition when result is an error', async () => {
    const session = makeSession();
    const emitted: unknown[] = [];
    session.on('gate_verify_disposition', (p) => emitted.push(p));

    sendEvent(session, {
      type: 'assistant',
      message: {
        id: 'msg_gate_err',
        content: [
          {
            type: 'text',
            text: '{"gate_verify":{"gate_item_id":"item-5","disposition":"fail"}}',
          },
        ],
      },
    });

    sendEvent(session, {
      type: 'result',
      subtype: 'error',
      is_error: true,
      stop_reason: 'error',
      usage: {},
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(emitted).toHaveLength(0);
  });
});
