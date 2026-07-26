import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../db/queries', () => ({
  getSession: vi.fn(),
  markSessionDone: vi.fn(),
}));

vi.mock('../../config', () => ({
  getProjectById: vi
    .fn()
    .mockReturnValue({ contextUrl: 'https://notion.so/project' }),
}));

import {
  admitsLiveRecordUnreachable,
  citesMissingIdentifierWithoutSearch,
  enforceAbstentionEvidenceContract,
  enforcePassEvidenceContract,
  hasConcreteRuntimeRecordEvidence,
  hasOperationalEvidence,
  isPreconditionOnlyEvidence,
  SessionGateItemVerifier,
} from '../gateItemVerifier';
import { getSession, markSessionDone } from '../../db/queries';
import type { GateItem } from '../gateStore';

describe('hasOperationalEvidence', () => {
  it('is true for evidence.basis "operational"', () => {
    expect(hasOperationalEvidence({ basis: 'operational' })).toBe(true);
  });

  it('is true for an array basis that includes "operational"', () => {
    expect(hasOperationalEvidence({ basis: ['source', 'operational'] })).toBe(
      true,
    );
  });

  it('is false for evidence.basis "source"', () => {
    expect(hasOperationalEvidence({ basis: 'source' })).toBe(false);
  });

  it('is false for missing/malformed evidence', () => {
    expect(hasOperationalEvidence(undefined)).toBe(false);
    expect(hasOperationalEvidence(null)).toBe(false);
    expect(hasOperationalEvidence('some string')).toBe(false);
    expect(hasOperationalEvidence({})).toBe(false);
  });
});

describe('isPreconditionOnlyEvidence', () => {
  it('is true when evidence only confirms the PR was merged via an ancestry check', () => {
    expect(
      isPreconditionOnlyEvidence({
        basis: 'operational',
        note: 'Confirmed PR #974 merged via git merge-base --is-ancestor',
      }),
    ).toBe(true);
  });

  it('is true when evidence only confirms the commit was deployed', () => {
    expect(
      isPreconditionOnlyEvidence({
        basis: 'operational',
        note: 'commit deployed to production',
      }),
    ).toBe(true);
  });

  it('is false when evidence describes the behavior itself, even alongside a merge mention', () => {
    expect(
      isPreconditionOnlyEvidence({
        basis: 'operational',
        note: 'audit_log shows the gate-verify session transitioned running -> done after PR #974 merged, confirming the described behavior actually ran',
      }),
    ).toBe(false);
  });

  it('is false for evidence with no precondition-only phrasing', () => {
    expect(
      isPreconditionOnlyEvidence({
        basis: 'operational',
        note: 'audit_log shows the deploy',
      }),
    ).toBe(false);
  });

  it('is false for missing/malformed evidence', () => {
    expect(isPreconditionOnlyEvidence(undefined)).toBe(false);
    expect(isPreconditionOnlyEvidence(null)).toBe(false);
    expect(isPreconditionOnlyEvidence('some string')).toBe(false);
  });
});

describe('hasConcreteRuntimeRecordEvidence', () => {
  it('is true for a note naming audit_log', () => {
    expect(
      hasConcreteRuntimeRecordEvidence({ note: 'audit_log shows the run' }),
    ).toBe(true);
  });

  it('is true for a note naming session_events', () => {
    expect(
      hasConcreteRuntimeRecordEvidence({
        note: 'session_events confirms the disposition was recorded',
      }),
    ).toBe(true);
  });

  it('is true for a note describing a live API or DB read', () => {
    expect(
      hasConcreteRuntimeRecordEvidence({
        note: 'queried the database and read the live record',
      }),
    ).toBe(true);
  });

  it('is false for a CI check + test file + source-path trace with no captured runtime record', () => {
    expect(
      hasConcreteRuntimeRecordEvidence({
        note: 'the CI build check passed, the test file covers this case, and a source-path trace through gateItemVerifier.ts confirms the code path',
      }),
    ).toBe(false);
  });

  it('is false for missing/malformed evidence', () => {
    expect(hasConcreteRuntimeRecordEvidence(undefined)).toBe(false);
    expect(hasConcreteRuntimeRecordEvidence(null)).toBe(false);
    expect(hasConcreteRuntimeRecordEvidence('some string')).toBe(false);
  });
});

describe('admitsLiveRecordUnreachable', () => {
  it('is true when a limitation admits the live record was not read', () => {
    expect(
      admitsLiveRecordUnreachable({
        note: 'audit_log entries look consistent',
        limitation: 'no live record was read to confirm this directly',
      }),
    ).toBe(true);
  });

  it('is true when evidence says the record was unreachable', () => {
    expect(
      admitsLiveRecordUnreachable({
        note: 'the session_events store was unreachable during this check',
      }),
    ).toBe(true);
  });

  it('is false when evidence has no such admission', () => {
    expect(
      admitsLiveRecordUnreachable({
        basis: 'operational',
        note: 'audit_log shows the deploy',
      }),
    ).toBe(false);
  });

  it('is false for missing/malformed evidence', () => {
    expect(admitsLiveRecordUnreachable(undefined)).toBe(false);
    expect(admitsLiveRecordUnreachable(null)).toBe(false);
    expect(admitsLiveRecordUnreachable('some string')).toBe(false);
  });
});

describe('enforcePassEvidenceContract', () => {
  it('downgrades a pass grounded only in "PR merged" to needs-setup', () => {
    const result = enforcePassEvidenceContract({
      disposition: 'pass',
      evidence: {
        basis: 'operational',
        note: 'Ran git merge-base --is-ancestor and confirmed PR #974 merged',
      },
    });
    expect(result.disposition).toBe('needs-setup');
    expect(result.evidence).toMatchObject({
      reason: expect.stringContaining('guaranteed precondition'),
    });
  });

  it('downgrades a pass grounded only in "commit deployed" to needs-setup', () => {
    const result = enforcePassEvidenceContract({
      disposition: 'pass',
      evidence: { basis: 'operational', note: 'deployed to production' },
    });
    expect(result.disposition).toBe('needs-setup');
  });

  it('downgrades a source-only pass to needs-setup', () => {
    const result = enforcePassEvidenceContract({
      disposition: 'pass',
      evidence: { basis: 'source', note: 'read the component, looks right' },
    });
    expect(result.disposition).toBe('needs-setup');
    expect(result.evidence).toMatchObject({
      reason: expect.stringContaining('operational'),
    });
  });

  it('downgrades a pass with no evidence at all', () => {
    const result = enforcePassEvidenceContract({ disposition: 'pass' });
    expect(result.disposition).toBe('needs-setup');
  });

  it('keeps a pass grounded in operational evidence', () => {
    const result = enforcePassEvidenceContract({
      disposition: 'pass',
      evidence: { basis: 'operational', note: 'audit_log shows the deploy' },
    });
    expect(result.disposition).toBe('pass');
  });

  it('downgrades a pass grounded in a CI check + test file + source-path trace with no captured runtime record', () => {
    const result = enforcePassEvidenceContract({
      disposition: 'pass',
      evidence: {
        basis: 'operational',
        note: 'PR #974 merged, CI build check passed, test file gateItemVerifier.test.ts covers this, and a source-path trace through gateItemVerifier.ts confirms the code path',
      },
    });
    expect(result.disposition).toBe('needs-setup');
    expect(result.evidence).toMatchObject({
      reason: expect.stringContaining('concrete captured runtime record'),
    });
  });

  it('downgrades a pass whose evidence admits the live record could not be read', () => {
    const result = enforcePassEvidenceContract({
      disposition: 'pass',
      evidence: {
        basis: 'operational',
        note: 'merged PR #974, a CI build check, and a source-path trace',
        limitation: 'no live record was read to confirm this ran',
      },
    });
    expect(result.disposition).toBe('needs-setup');
    expect(result.evidence).toMatchObject({
      reason: expect.stringContaining('live'),
    });
  });

  it('keeps a pass naming a concrete captured runtime record', () => {
    const result = enforcePassEvidenceContract({
      disposition: 'pass',
      evidence: {
        basis: 'operational',
        note: 'session_events shows the gate-verify session reported pass after reading audit_log entries for the run',
      },
    });
    expect(result.disposition).toBe('pass');
  });

  it('leaves fail and needs-setup dispositions untouched', () => {
    const fail = enforcePassEvidenceContract({
      disposition: 'fail',
      evidence: { basis: 'source' },
    });
    expect(fail.disposition).toBe('fail');

    const needsSetup = enforcePassEvidenceContract({
      disposition: 'needs-setup',
    });
    expect(needsSetup.disposition).toBe('needs-setup');
  });
});

describe('SessionGateItemVerifier — archives its dispatched session once the disposition is consumed', () => {
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
    });
  }

  beforeEach(() => {
    vi.mocked(getSession).mockReset();
    vi.mocked(markSessionDone).mockReset();
  });

  it('marks the session done once the gate_verify_disposition event fires', async () => {
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
    expect(markSessionDone).toHaveBeenCalledWith(
      'sess-1',
      expect.any(Number),
      null,
      'gate_item_verifier_consumed',
    );
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
    expect(markSessionDone).toHaveBeenCalledWith(
      'sess-fast',
      expect.any(Number),
      null,
      'gate_item_verifier_consumed',
    );
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
});

describe('citesMissingIdentifierWithoutSearch', () => {
  it('is true for a bare "no target session ID" abstention', () => {
    expect(
      citesMissingIdentifierWithoutSearch({
        reason:
          'no accessible session_events/audit_log for an actual groom/design ' +
          'dispatch (no target session ID, no read surface for the live setting value)',
      }),
    ).toBe(true);
  });

  it('is false once the evidence records a local search', () => {
    expect(
      citesMissingIdentifierWithoutSearch({
        reason:
          'no target session ID up front, but checked .claude/session-prompts/ ' +
          'and found no matching groom/design dispatch',
      }),
    ).toBe(false);
  });

  it('is false when nothing about a missing identifier is mentioned', () => {
    expect(
      citesMissingIdentifierWithoutSearch({
        reason: 'verification budget exceeded',
      }),
    ).toBe(false);
  });

  it('is false for empty/non-object evidence', () => {
    expect(citesMissingIdentifierWithoutSearch(undefined)).toBe(false);
    expect(citesMissingIdentifierWithoutSearch('a string')).toBe(false);
  });
});

describe('enforceAbstentionEvidenceContract', () => {
  it('leaves pass/fail dispositions untouched', () => {
    const pass = enforceAbstentionEvidenceContract({
      disposition: 'pass',
      evidence: { basis: 'operational' },
    });
    expect(pass.evidence).toEqual({ basis: 'operational' });

    const fail = enforceAbstentionEvidenceContract({
      disposition: 'fail',
      evidence: { basis: 'operational' },
    });
    expect(fail.evidence).toEqual({ basis: 'operational' });
  });

  it('leaves a needs-setup with no missing-identifier citation untouched', () => {
    const result = enforceAbstentionEvidenceContract({
      disposition: 'needs-setup',
      evidence: { reason: 'verification budget exceeded' },
    });
    expect(result.evidence).toEqual({ reason: 'verification budget exceeded' });
  });

  it('leaves a needs-setup untouched when it records what was searched', () => {
    const evidence = {
      reason:
        'no target session ID; checked .claude/session-prompts/ and found none',
    };
    const result = enforceAbstentionEvidenceContract({
      disposition: 'needs-setup',
      evidence,
    });
    expect(result.evidence).toEqual(evidence);
  });

  it('flags a needs-setup citing a missing identifier with no recorded search', () => {
    const result = enforceAbstentionEvidenceContract({
      disposition: 'needs-setup',
      evidence: {
        reason:
          'no target session ID, no read surface for the live setting value',
      },
    });
    expect(result.disposition).toBe('needs-setup');
    expect(result.evidence).toMatchObject({
      reason:
        'no target session ID, no read surface for the live setting value',
      abstentionIncomplete: true,
    });
    expect(
      (result.evidence as { abstentionNote: string }).abstentionNote,
    ).toMatch(/session-prompts/);
  });
});
