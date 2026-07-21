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
  enforcePassEvidenceContract,
  hasOperationalEvidence,
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

describe('enforcePassEvidenceContract', () => {
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
        evidence: { basis: 'operational' },
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
});
