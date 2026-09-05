import { describe, it, expect } from 'vitest';
import { isMcpUnreachable } from '../AgentSession';

describe('isMcpUnreachable', () => {
  const GRACE_MS = 3 * 60_000;

  it('is false once init reports the orchestrator server connected', () => {
    expect(
      isMcpUnreachable({
        orchestratorMcpStatus: 'connected',
        nowMs: 1_000_000,
        lastSpawnMs: 0,
        graceMs: GRACE_MS,
      }),
    ).toBe(false);
  });

  it('is true once init reports the orchestrator server failed, even with no elapsed time', () => {
    expect(
      isMcpUnreachable({
        orchestratorMcpStatus: 'failed',
        nowMs: 0,
        lastSpawnMs: 0,
        graceMs: GRACE_MS,
      }),
    ).toBe(true);
  });

  it('is true once init reports the orchestrator server failed, even after a connection was established and closed', () => {
    // A connection that opens and then immediately closes with an error
    // still leaves the session with no orchestrator tools — the init
    // event's reported status is authoritative, not connection history.
    expect(
      isMcpUnreachable({
        orchestratorMcpStatus: 'failed',
        nowMs: 1_000_000,
        lastSpawnMs: 0,
        graceMs: GRACE_MS,
      }),
    ).toBe(true);
  });

  it('is false inside the startup grace window when no init has reported yet', () => {
    expect(
      isMcpUnreachable({
        orchestratorMcpStatus: undefined,
        nowMs: GRACE_MS - 1,
        lastSpawnMs: 0,
        graceMs: GRACE_MS,
      }),
    ).toBe(false);
  });

  it('is true once the grace window has elapsed with no init reported', () => {
    expect(
      isMcpUnreachable({
        orchestratorMcpStatus: undefined,
        nowMs: GRACE_MS,
        lastSpawnMs: 0,
        graceMs: GRACE_MS,
      }),
    ).toBe(true);
  });
});
