import { describe, it, expect } from 'vitest';
import { isMcpUnreachable } from '../AgentSession';

describe('isMcpUnreachable', () => {
  const GRACE_MS = 3 * 60_000;

  it('is false once a connection was established since the last spawn', () => {
    expect(
      isMcpUnreachable({
        hasConnectedSinceSpawn: true,
        nowMs: 1_000_000,
        lastSpawnMs: 0,
        graceMs: GRACE_MS,
      }),
    ).toBe(false);
  });

  it('is false inside the startup grace window', () => {
    expect(
      isMcpUnreachable({
        hasConnectedSinceSpawn: false,
        nowMs: GRACE_MS - 1,
        lastSpawnMs: 0,
        graceMs: GRACE_MS,
      }),
    ).toBe(false);
  });

  it('is true once the grace window has elapsed with no connection', () => {
    expect(
      isMcpUnreachable({
        hasConnectedSinceSpawn: false,
        nowMs: GRACE_MS,
        lastSpawnMs: 0,
        graceMs: GRACE_MS,
      }),
    ).toBe(true);
  });
});
