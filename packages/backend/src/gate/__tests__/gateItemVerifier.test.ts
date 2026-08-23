import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../db/queries', () => ({
  getSession: vi.fn(),
  markSessionDone: vi.fn(),
  setSessionTerminalCompletionReason: vi.fn(),
  insertCompletingSignal: vi.fn(),
  hasActiveCapabilityRequestForSession: vi.fn().mockReturnValue(false),
  TERMINAL_SESSION_STATUSES: new Set(['done', 'error', 'killed']),
}));

vi.mock('../../config', () => ({
  getProjectById: vi
    .fn()
    .mockReturnValue({ contextUrl: 'https://notion.so/project' }),
}));

vi.mock('../gateService', () => ({
  appendGateItemEvent: vi.fn(),
}));

import { SessionGateItemVerifier } from '../gateItemVerifier';
import {
  getSession,
  markSessionDone,
  setSessionTerminalCompletionReason,
  insertCompletingSignal,
  hasActiveCapabilityRequestForSession,
} from '../../db/queries';
import { appendGateItemEvent } from '../gateService';
import type { GateItem } from '../gateStore';

describe('SessionGateItemVerifier — leaves a reporting session live, archives only on dispatch failure', () => {
  const item: GateItem = {
    id: 'item-1',
    project: 'proj',
    milestone: 'm1',
    text: 'some behavior',
    classification: 'Read-Only',
    state: 'open',
    updatedAt: new Date(0).toISOString(),
    sources: [],
    events: [],
  };

  function makeSessionManager() {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      start: vi.fn().mockResolvedValue('sess-1'),
      archiveAndEndSession: vi.fn(),
      enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    });
  }

  beforeEach(() => {
    vi.mocked(getSession).mockReset();
    vi.mocked(markSessionDone).mockReset();
    vi.mocked(setSessionTerminalCompletionReason).mockReset();
    vi.mocked(insertCompletingSignal).mockReset();
    vi.mocked(appendGateItemEvent).mockReset();
    vi.mocked(hasActiveCapabilityRequestForSession)
      .mockReset()
      .mockReturnValue(false);
  });

  it('resolves awaitingDisposition:true and leaves the session live once the gate_verify_disposition event fires — no archive, no gate_item_event write here', async () => {
    const sessionManager = makeSessionManager();
    vi.mocked(getSession).mockReturnValue({
      status: 'running',
    } as never);

    const verifier = new SessionGateItemVerifier(sessionManager as never);
    const resultPromise = verifier.verify(item);

    // Let the session dispatch (`start()`) resolve and the disposition
    // listener attach before emitting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    sessionManager.emit('gate_verify_disposition', {
      sessionId: 'sess-1',
      disposition: {
        disposition: 'pass',
        evidence: { basis: 'operational', note: 'audit_log shows the run' },
      },
    });

    const result = await resultPromise;
    expect(result.disposition).toBe('pass');
    expect(result.awaitingDisposition).toBe(true);
    expect(markSessionDone).not.toHaveBeenCalled();
    expect(sessionManager.archiveAndEndSession).not.toHaveBeenCalled();
    expect(appendGateItemEvent).not.toHaveBeenCalled();
  });

  it('resolves a reported pass unmodified even when its evidence carries a negation next to a live-record mention — the verbatim evidence session 0f26fbd1 reported for gate item 702f69bd, which the retired contract used to downgrade', async () => {
    const sessionManager = makeSessionManager();
    vi.mocked(getSession).mockReturnValue({ status: 'running' } as never);

    const verbatimEvidence = {
      basis: 'operational',
      note:
        'queried audit_log with a windowed since/until range and by task_id; ' +
        'there are no audit_log rows of any kind for this task in between, ' +
        'confirming the auto-dispatch and pickup happened with no manual ' +
        'database intervention.',
    };

    const verifier = new SessionGateItemVerifier(sessionManager as never);
    const resultPromise = verifier.verify(item);
    await new Promise((resolve) => setTimeout(resolve, 0));

    sessionManager.emit('gate_verify_disposition', {
      sessionId: 'sess-1',
      disposition: { disposition: 'pass', evidence: verbatimEvidence },
    });

    const result = await resultPromise;
    expect(result.disposition).toBe('pass');
    expect(result.evidence).toEqual(verbatimEvidence);
    // No contract, no downgrade, no appeal — the operator sees exactly what
    // the session reported.
    expect(sessionManager.enqueueFeedback).not.toHaveBeenCalled();
    expect(appendGateItemEvent).not.toHaveBeenCalled();
  });

  it('sets dispatchFailed:true and preserves reason/error evidence when sessionManager.start() rejects', async () => {
    const sessionManager = makeSessionManager();
    vi.mocked(sessionManager.start).mockRejectedValue(
      new Error('Max concurrent planning sessions (20) reached'),
    );

    const verifier = new SessionGateItemVerifier(sessionManager as never);
    const result = await verifier.verify(item);

    expect(result).toMatchObject({
      disposition: 'needs-setup',
      dispatchFailed: true,
      evidence: {
        reason: 'failed to dispatch verification session',
        error: 'Max concurrent planning sessions (20) reached',
      },
    });
  });

  it('names the session "Gate verify: <item text>", unaffected by the groom/design/ops planning-session naming scheme', async () => {
    const sessionManager = makeSessionManager();
    vi.mocked(getSession).mockReturnValue({ status: 'running' } as never);

    const verifier = new SessionGateItemVerifier(sessionManager as never);
    const resultPromise = verifier.verify(item);
    await new Promise((resolve) => setTimeout(resolve, 0));

    sessionManager.emit('gate_verify_disposition', {
      sessionId: 'sess-1',
      disposition: {
        disposition: 'pass',
        evidence: { basis: 'operational', note: 'audit_log shows the run' },
      },
    });
    await resultPromise;

    const [, , dispatchOpts] = vi.mocked(sessionManager.start).mock.calls[0];
    expect(dispatchOpts).toMatchObject({
      taskName: 'Gate verify: some behavior',
      taskId: 'gate-item:item-1',
    });
  });

  it('injects ask-permission guidance (request or abstain) rather than pre-fetched operational data', async () => {
    const sessionManager = makeSessionManager();
    vi.mocked(getSession).mockReturnValue({ status: 'running' } as never);

    const verifier = new SessionGateItemVerifier(sessionManager as never);
    const resultPromise = verifier.verify(item);
    await new Promise((resolve) => setTimeout(resolve, 0));
    sessionManager.emit('gate_verify_disposition', {
      sessionId: 'sess-1',
      disposition: { disposition: 'needs-setup' },
    });
    await resultPromise;

    expect(sessionManager.start).toHaveBeenCalledTimes(1);
    const [, , dispatchOpts] = vi.mocked(sessionManager.start).mock.calls[0];
    const injectedProcedureContent = (
      dispatchOpts as { injectedProcedureContent: string }
    ).injectedProcedureContent;

    // States the responsibility: ask for what it needs, or abstain — never
    // fabricate a result to route around a denial.
    expect(injectedProcedureContent).toMatch(/session\.requestCapability/);
    expect(injectedProcedureContent).toMatch(/never fabricate/i);
    expect(injectedProcedureContent).toMatch(/responsible for asking/i);

    // The gate mechanism itself never pre-injects the operational record
    // (audit_log/session_events/PR/git evidence) — the session is told what
    // to go read, not handed the read's result.
    expect(injectedProcedureContent).not.toMatch(/```json\n\{"audit_log"/);
    expect(injectedProcedureContent).not.toContain('SELECT * FROM');
  });

  it('directs record-first investigation and de-emphasizes open-ended source reading', async () => {
    const sessionManager = makeSessionManager();
    vi.mocked(getSession).mockReturnValue({ status: 'running' } as never);

    const verifier = new SessionGateItemVerifier(sessionManager as never);
    const resultPromise = verifier.verify(item);
    await new Promise((resolve) => setTimeout(resolve, 0));
    sessionManager.emit('gate_verify_disposition', {
      sessionId: 'sess-1',
      disposition: { disposition: 'needs-setup' },
    });
    await resultPromise;

    const [, , dispatchOpts] = vi.mocked(sessionManager.start).mock.calls[0];
    const injectedProcedureContent = (
      dispatchOpts as { injectedProcedureContent: string }
    ).injectedProcedureContent;

    // Tells the session to open on the operational record, not on grepping
    // the source tree to understand the mechanism.
    expect(injectedProcedureContent).toMatch(
      /start with the operational record, not the source tree/i,
    );
    expect(injectedProcedureContent).toMatch(/known failure mode/i);

    // Source is scoped down to a brief orient, never the investigation body.
    expect(injectedProcedureContent).toMatch(/at most, a brief orient/i);

    // The record-first instruction appears before the "source as orient"
    // caveat — the operational record is the investigation, source is a
    // late, minor aside.
    const recordFirstIndex = injectedProcedureContent
      .toLowerCase()
      .indexOf('start with the operational record');
    const sourceOrientIndex = injectedProcedureContent
      .toLowerCase()
      .indexOf('at most, a brief orient');
    expect(recordFirstIndex).toBeGreaterThan(-1);
    expect(sourceOrientIndex).toBeGreaterThan(-1);
    expect(recordFirstIndex).toBeLessThan(sourceOrientIndex);
  });

  it('names the required expected/found/query evidence fields, fail-only source', async () => {
    const sessionManager = makeSessionManager();
    vi.mocked(getSession).mockReturnValue({ status: 'running' } as never);

    const verifier = new SessionGateItemVerifier(sessionManager as never);
    const resultPromise = verifier.verify(item);
    await new Promise((resolve) => setTimeout(resolve, 0));
    sessionManager.emit('gate_verify_disposition', {
      sessionId: 'sess-1',
      disposition: { disposition: 'needs-setup' },
    });
    await resultPromise;

    const [, , dispatchOpts] = vi.mocked(sessionManager.start).mock.calls[0];
    const injectedProcedureContent = (
      dispatchOpts as { injectedProcedureContent: string }
    ).injectedProcedureContent;

    // The prompting names the terse contract fields, not a free-prose
    // explanation/basis pair.
    expect(injectedProcedureContent).toMatch(/`expected`/);
    expect(injectedProcedureContent).toMatch(/`found`/);
    expect(injectedProcedureContent).toMatch(/`query`/);
    expect(injectedProcedureContent).not.toMatch(/evidence\.explanation/);
    expect(injectedProcedureContent).not.toMatch(/prose paragraph stating/);

    // The JSON report template mandates the three keys.
    expect(injectedProcedureContent).toMatch(
      /"expected":\s*"\.\.\.",\s*"found":\s*"\.\.\.",\s*"query":\s*"\.\.\."/,
    );

    // source is shown as fail-only, not part of the base template.
    expect(injectedProcedureContent).toMatch(/admissible only on fail/);
  });

  it('defines the operational record with distinct IS / IS-NOT sections', async () => {
    const sessionManager = makeSessionManager();
    vi.mocked(getSession).mockReturnValue({ status: 'running' } as never);

    const verifier = new SessionGateItemVerifier(sessionManager as never);
    const resultPromise = verifier.verify(item);
    await new Promise((resolve) => setTimeout(resolve, 0));
    sessionManager.emit('gate_verify_disposition', {
      sessionId: 'sess-1',
      disposition: { disposition: 'needs-setup' },
    });
    await resultPromise;

    const [, , dispatchOpts] = vi.mocked(sessionManager.start).mock.calls[0];
    const injectedProcedureContent = (
      dispatchOpts as { injectedProcedureContent: string }
    ).injectedProcedureContent;
    const lower = injectedProcedureContent.toLowerCase();

    const isIndex = lower.indexOf('the operational record is**');
    const isNotIndex = lower.indexOf('the operational record is not**');
    expect(isIndex).toBeGreaterThan(-1);
    expect(isNotIndex).toBeGreaterThan(-1);
    expect(isIndex).toBeLessThan(isNotIndex);

    const isSection = injectedProcedureContent.slice(isIndex, isNotIndex);
    const isNotSection = injectedProcedureContent.slice(
      isNotIndex,
      injectedProcedureContent.indexOf('Your job, in one line'),
    );

    // The genuine operational record only appears in the IS section.
    expect(isSection).toMatch(/audit_log/i);
    expect(isSection).toMatch(/session_events/i);
    expect(isSection).toMatch(/live db\/api state/i);

    // Preconditions/source only appear in the IS-NOT section, never in IS.
    const notOnlyTerms = [
      'pull request',
      'git history',
      '`gh` output',
      'merged pr',
      'deploy record',
      'ci check',
      'source code',
      'unit test',
    ];
    for (const term of notOnlyTerms) {
      expect(isNotSection.toLowerCase()).toContain(term);
      expect(isSection.toLowerCase()).not.toContain(term);
    }
  });

  it('states the merge+deploy guarantee so the session does not re-verify it', async () => {
    const sessionManager = makeSessionManager();
    vi.mocked(getSession).mockReturnValue({ status: 'running' } as never);

    const verifier = new SessionGateItemVerifier(sessionManager as never);
    const resultPromise = verifier.verify(item);
    await new Promise((resolve) => setTimeout(resolve, 0));
    sessionManager.emit('gate_verify_disposition', {
      sessionId: 'sess-1',
      disposition: { disposition: 'needs-setup' },
    });
    await resultPromise;

    const [, , dispatchOpts] = vi.mocked(sessionManager.start).mock.calls[0];
    const injectedProcedureContent = (
      dispatchOpts as { injectedProcedureContent: string }
    ).injectedProcedureContent;

    expect(injectedProcedureContent).toMatch(/already merged and deployed/i);
    expect(injectedProcedureContent).toMatch(/spend zero turns re-confirming/i);
    expect(injectedProcedureContent).toMatch(/guaranteed precondition/i);
  });

  it('does not re-archive a session already ended error/killed by AgentSession', async () => {
    const sessionManager = makeSessionManager();
    vi.mocked(getSession).mockReturnValue({ status: 'killed' } as never);

    const verifier = new SessionGateItemVerifier(sessionManager as never, {
      pollIntervalMs: 5,
    });
    const result = await verifier.verify(item);

    expect(result.disposition).toBe('needs-setup');
    expect(markSessionDone).not.toHaveBeenCalled();
    expect(sessionManager.archiveAndEndSession).not.toHaveBeenCalled();
  });

  it('dual-writes the terminal completion reason and a completing-signal ledger row when the budget tears a still-running session down', async () => {
    const sessionManager = makeSessionManager();
    vi.mocked(getSession).mockReturnValue({
      status: 'running',
      task_id: 'task-1',
      session_type: 'ops',
    } as never);

    const verifier = new SessionGateItemVerifier(sessionManager as never, {
      pollIntervalMs: 60_000,
      budgetMs: 5,
    });
    const result = await verifier.verify(item);

    expect(result.disposition).toBe('needs-setup');
    expect(markSessionDone).toHaveBeenCalledWith(
      'sess-1',
      expect.any(Number),
      null,
      'gate_item_verifier_consumed',
    );
    expect(setSessionTerminalCompletionReason).toHaveBeenCalledWith(
      'sess-1',
      'gate_item_verifier_consumed',
    );
    expect(insertCompletingSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'sess-1',
        task_id: 'task-1',
        session_type: 'ops',
        signal_class: 'staged_intent',
        signal_value: 'gate_item_verifier_consumed',
      }),
    );
    expect(sessionManager.archiveAndEndSession).toHaveBeenCalledWith('sess-1');
  });

  it('leaves an already-error session alone: no archive, no status overwrite', async () => {
    const sessionManager = makeSessionManager();
    vi.mocked(getSession).mockReturnValue({ status: 'error' } as never);

    const verifier = new SessionGateItemVerifier(sessionManager as never, {
      pollIntervalMs: 5,
    });
    const result = await verifier.verify(item);

    expect(result.disposition).toBe('needs-setup');
    expect(markSessionDone).not.toHaveBeenCalled();
    expect(sessionManager.archiveAndEndSession).not.toHaveBeenCalled();
  });

  it('exempts the wall-clock budget while a capability request is outstanding, and still resolves once granted', async () => {
    const sessionManager = makeSessionManager();
    vi.mocked(getSession).mockReturnValue({ status: 'running' } as never);
    // Outstanding past the (tiny, test-scale) budget window — the budget
    // must not tear the session down while this holds true.
    vi.mocked(hasActiveCapabilityRequestForSession).mockReturnValue(true);

    const verifier = new SessionGateItemVerifier(sessionManager as never, {
      budgetMs: 15,
      pollIntervalMs: 5,
    });
    const resultPromise = verifier.verify(item);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Well past the 15ms budget — without the exemption this would already
    // have torn the session down as a budget-exceeded needs-setup.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(markSessionDone).not.toHaveBeenCalled();
    expect(sessionManager.archiveAndEndSession).not.toHaveBeenCalled();

    // The request clears (operator grants it) — the session resumes and
    // eventually reports its disposition.
    vi.mocked(hasActiveCapabilityRequestForSession).mockReturnValue(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    sessionManager.emit('gate_verify_disposition', {
      sessionId: 'sess-1',
      disposition: {
        disposition: 'pass',
        evidence: { basis: 'operational', note: 'audit_log shows the run' },
      },
    });

    const result = await resultPromise;
    expect(result.disposition).toBe('pass');
    expect(result.awaitingDisposition).toBe(true);
    expect(sessionManager.archiveAndEndSession).not.toHaveBeenCalled();
  });

  it('captures a gate_verify_disposition emitted synchronously as start() resolves, before the poll fallback can fire', async () => {
    // A fast session can emit its disposition the instant sessionManager.start()
    // resolves — before any code after the `await` has had a chance to attach a
    // listener. Simulate that by emitting from inside the mocked start()
    // implementation itself, synchronously with resolution.
    const emitter = new EventEmitter();
    const sessionManager = Object.assign(emitter, {
      start: vi.fn().mockImplementation(async () => {
        emitter.emit('gate_verify_disposition', {
          sessionId: 'sess-fast',
          disposition: {
            disposition: 'fail',
            evidence: { basis: 'operational', note: 'PR was reverted' },
          },
        });
        return 'sess-fast';
      }),
      archiveAndEndSession: vi.fn(),
    });
    vi.mocked(getSession).mockReturnValue({ status: 'running' } as never);

    // A long poll interval / budget so the fallback would never legitimately
    // fire during this test — if the event were lost, the test would hang
    // instead of silently passing with the wrong disposition.
    const verifier = new SessionGateItemVerifier(sessionManager as never, {
      pollIntervalMs: 60_000,
      budgetMs: 60_000,
    });

    const result = await verifier.verify(item);

    expect(result.disposition).toBe('fail');
    expect(result.awaitingDisposition).toBe(true);
    expect(markSessionDone).not.toHaveBeenCalled();
    expect(sessionManager.archiveAndEndSession).not.toHaveBeenCalled();
  });

  it('records the session emitted disposition, not the needs-setup timeout fallback, when the event beat the poll', async () => {
    const emitter = new EventEmitter();
    const sessionManager = Object.assign(emitter, {
      start: vi.fn().mockImplementation(async () => {
        emitter.emit('gate_verify_disposition', {
          sessionId: 'sess-fast-2',
          disposition: {
            disposition: 'pass',
            evidence: { basis: 'operational', note: 'audit_log confirms it' },
          },
        });
        return 'sess-fast-2';
      }),
      archiveAndEndSession: vi.fn(),
    });
    vi.mocked(getSession).mockReturnValue({ status: 'done' } as never);

    const verifier = new SessionGateItemVerifier(sessionManager as never, {
      pollIntervalMs: 5,
      budgetMs: 60_000,
    });

    const result = await verifier.verify(item);

    // Must reflect the emitted `pass`, not the poll fallback's
    // needs-setup ("no gate_verify report on conclusion").
    expect(result.disposition).toBe('pass');
    expect(result.evidence).toMatchObject({ basis: 'operational' });
  });

  it('states no claim that the orchestrator DB/filesystem sits outside the session sandbox', async () => {
    const sessionManager = makeSessionManager();
    vi.mocked(getSession).mockReturnValue({ status: 'running' } as never);

    const verifier = new SessionGateItemVerifier(sessionManager as never);
    const resultPromise = verifier.verify(item);
    await new Promise((resolve) => setTimeout(resolve, 0));
    sessionManager.emit('gate_verify_disposition', {
      sessionId: 'sess-1',
      disposition: { disposition: 'needs-setup' },
    });
    await resultPromise;

    const [, , dispatchOpts] = vi.mocked(sessionManager.start).mock.calls[0];
    const injectedProcedureContent = (
      dispatchOpts as { injectedProcedureContent: string }
    ).injectedProcedureContent;

    expect(injectedProcedureContent).not.toMatch(/outside this sandbox/i);
    expect(injectedProcedureContent).not.toMatch(
      /sandbox and (cannot|neither)/i,
    );
    // The boundary is stated as tool-shaped instead — no allow-listed
    // client for the live SQLite file, no device auth for the API.
    expect(injectedProcedureContent).toMatch(/no allow-listed client/i);
    expect(injectedProcedureContent).toMatch(/no device\s*auth/i);
  });

  it('directs research before abstaining and names the session-prompts directory as a base-tool-reachable surface', async () => {
    const sessionManager = makeSessionManager();
    vi.mocked(getSession).mockReturnValue({ status: 'running' } as never);

    const verifier = new SessionGateItemVerifier(sessionManager as never);
    const resultPromise = verifier.verify(item);
    await new Promise((resolve) => setTimeout(resolve, 0));
    sessionManager.emit('gate_verify_disposition', {
      sessionId: 'sess-1',
      disposition: { disposition: 'needs-setup' },
    });
    await resultPromise;

    const [, , dispatchOpts] = vi.mocked(sessionManager.start).mock.calls[0];
    const injectedProcedureContent = (
      dispatchOpts as { injectedProcedureContent: string }
    ).injectedProcedureContent;

    expect(injectedProcedureContent).toMatch(/before abstaining/i);
    expect(injectedProcedureContent).toContain('.claude/session-prompts/');
    expect(injectedProcedureContent).toMatch(/must say what you\s+searched/i);
  });

  it('permits exactly one bounded instrumental write and states its boundaries', async () => {
    const sessionManager = makeSessionManager();
    vi.mocked(getSession).mockReturnValue({ status: 'running' } as never);

    const verifier = new SessionGateItemVerifier(sessionManager as never);
    const resultPromise = verifier.verify(item);
    await new Promise((resolve) => setTimeout(resolve, 0));
    sessionManager.emit('gate_verify_disposition', {
      sessionId: 'sess-1',
      disposition: { disposition: 'needs-setup' },
    });
    await resultPromise;

    const [, , dispatchOpts] = vi.mocked(sessionManager.start).mock.calls[0];
    const injectedProcedureContent = (
      dispatchOpts as { injectedProcedureContent: string }
    ).injectedProcedureContent;

    // The narrow write exception is documented, bounded to one atomic action.
    expect(injectedProcedureContent).toMatch(/one narrow write exception/i);
    expect(injectedProcedureContent).toMatch(
      /exactly\s+one atomic,?\s+instrumental write/i,
    );
    expect(injectedProcedureContent).toMatch(
      /never a multi-step or open-ended action|never the start of a longer procedure/i,
    );

    // What remains explicitly out of scope for the exception.
    expect(injectedProcedureContent).toMatch(/reconcile-and-capture/i);
    expect(injectedProcedureContent).toMatch(/ops_journal/);
    expect(injectedProcedureContent).toMatch(
      /any other\s+multi-step operational change/i,
    );
    expect(injectedProcedureContent).toMatch(/any gate-write call/i);

    // The write is instrumental only, never the verdict itself.
    expect(injectedProcedureContent).toMatch(
      /instrumental only and never itself the verdict/i,
    );
    expect(injectedProcedureContent).toMatch(
      /backend remains the sole writer of gate state/i,
    );

    // Abstain stays the default until the single closing action is identified.
    expect(injectedProcedureContent).toMatch(/abstain remains the default/i);
    expect(injectedProcedureContent).toMatch(
      /single closing action.*already\s+identified|already identified.*single closing action/i,
    );
    expect(injectedProcedureContent).toMatch(/genuine ambiguity.*needs-setup/i);

    // A worked session.requestCapability payload example for this write class.
    expect(injectedProcedureContent).toMatch(
      /"capability":"<one Bash command prefix or one named\s+MCP write verb>"/,
    );
    expect(injectedProcedureContent).toMatch(
      /seed\/trigger exactly this one row\/event/i,
    );
  });

  it('describes staging + operator pushback, never a one-shot appeal, in the injected procedure', async () => {
    const sessionManager = makeSessionManager();
    vi.mocked(getSession).mockReturnValue({ status: 'running' } as never);

    const verifier = new SessionGateItemVerifier(sessionManager as never);
    const resultPromise = verifier.verify(item);
    await new Promise((resolve) => setTimeout(resolve, 0));
    sessionManager.emit('gate_verify_disposition', {
      sessionId: 'sess-1',
      disposition: { disposition: 'needs-setup' },
    });
    await resultPromise;

    const [, , dispatchOpts] = vi.mocked(sessionManager.start).mock.calls[0];
    const injectedProcedureContent = (
      dispatchOpts as { injectedProcedureContent: string }
    ).injectedProcedureContent;

    expect(injectedProcedureContent).toMatch(
      /stages your report as a normal decision for a human operator/i,
    );
    expect(injectedProcedureContent).toMatch(
      /no limit on how many times this can happen/i,
    );
    expect(injectedProcedureContent).not.toMatch(/one[- ]shot appeal/i);
    expect(injectedProcedureContent).not.toMatch(/one chance to revise/i);
  });
});
