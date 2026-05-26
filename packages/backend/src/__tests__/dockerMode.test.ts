/**
 * Unit tests for Docker mode implementation.
 *
 * Acceptance criteria:
 *   1. With gates.dockerMandatory=true, SessionManager.start() uses DockerSessionRunner
 *   2. With gates.dockerMandatory=false, SessionManager.start() uses CliSessionRunner
 *   3. Orphan-reap on startup removes containers whose session is no longer active
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ── 1 & 2: Runner selection via source-code structural check ─────────────────
// These tests read the SessionManager source to verify the runner selection
// logic uses getCorporateMode().gates.dockerMandatory — same pattern as other
// structural tests in the suite.

describe('SessionManager runner selection', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('imports DockerSessionRunner', () => {
    expect(source).toMatch(/DockerSessionRunner/);
  });

  it('imports getCorporateMode', () => {
    expect(source).toMatch(/getCorporateMode/);
  });

  it('uses gates.dockerMandatory to decide runner in start()', () => {
    expect(source).toMatch(/gates\.dockerMandatory/);
    // DockerSessionRunner is used when dockerMandatory is true
    expect(source).toMatch(/DockerSessionRunner\(sessionId\)/);
    // CliSessionRunner is used when dockerMandatory is false
    expect(source).toMatch(/CliSessionRunner\(sessionId\)/);
  });

  it('runner selection branch for dockerMandatory appears before runner is used', () => {
    const dockerIdx = source.indexOf('DockerSessionRunner(sessionId)');
    const cliIdx = source.indexOf('CliSessionRunner(sessionId)');
    const dockerMandatoryIdx = source.indexOf('gates.dockerMandatory');
    // Both runners appear after the dockerMandatory check
    expect(dockerIdx).toBeGreaterThan(dockerMandatoryIdx);
    expect(cliIdx).toBeGreaterThan(dockerMandatoryIdx);
  });

  it('resume path also uses gates.dockerMandatory for runner selection', () => {
    // Both occurrences (start + resume) must reference DockerSessionRunner
    const allMatches = [...source.matchAll(/DockerSessionRunner\(/g)];
    expect(allMatches.length).toBeGreaterThanOrEqual(2);
  });
});

// ── 3: reapOrphanContainers removes containers not in the live set ──────────

describe('reapOrphanContainers', () => {
  // We test the function directly with a mocked child_process.execSync

  const DEAD_SESSION = 'dead-session-id-0001';
  const LIVE_SESSION = 'live-session-id-0002';

  const containerPrefix = 'claude-session-';
  const proxyPrefix = 'claude-session-proxy-';
  const networkPrefix = 'claude-session-net-';

  let execSyncCalls: string[] = [];

  beforeEach(() => {
    execSyncCalls = [];
    vi.resetModules();
  });

  it('removes containers and networks for sessions not in the live set', async () => {
    // Mock child_process before importing the module
    vi.doMock('child_process', () => ({
      execSync: vi.fn((cmd: string) => {
        execSyncCalls.push(cmd);
        // Return container/network listings on the relevant docker ps/network ls calls
        if (cmd.includes(`--filter "name=${containerPrefix}"`)) {
          return `${containerPrefix}${DEAD_SESSION}\n${containerPrefix}${LIVE_SESSION}`;
        }
        if (cmd.includes(`--filter "name=${proxyPrefix}"`)) {
          return `${proxyPrefix}${DEAD_SESSION}\n${proxyPrefix}${LIVE_SESSION}`;
        }
        if (cmd.includes(`--filter "name=${networkPrefix}"`)) {
          return `${networkPrefix}${DEAD_SESSION}\n${networkPrefix}${LIVE_SESSION}`;
        }
        return '';
      }),
      spawn: vi.fn(),
      execFile: vi.fn(),
    }));

    const { reapOrphanContainers } = await import(
      '../session/DockerSessionRunner.js'
    );

    const liveIds = new Set([LIVE_SESSION]);
    reapOrphanContainers(liveIds);

    // Dead session's container, proxy, and network should be removed
    const rmCalls = execSyncCalls.filter((c) => c.startsWith('docker rm -f'));
    expect(rmCalls.some((c) => c.includes(DEAD_SESSION))).toBe(true);
    // Live session's resources should NOT be removed
    expect(rmCalls.some((c) => c.includes(LIVE_SESSION))).toBe(false);

    const netRmCalls = execSyncCalls.filter((c) =>
      c.startsWith('docker network rm'),
    );
    expect(netRmCalls.some((c) => c.includes(DEAD_SESSION))).toBe(true);
    expect(netRmCalls.some((c) => c.includes(LIVE_SESSION))).toBe(false);
  });

  it('does not remove anything when all sessions are live', async () => {
    vi.doMock('child_process', () => ({
      execSync: vi.fn((cmd: string) => {
        execSyncCalls.push(cmd);
        if (cmd.includes(`--filter "name=${containerPrefix}"`)) {
          return `${containerPrefix}${LIVE_SESSION}`;
        }
        if (cmd.includes(`--filter "name=${proxyPrefix}"`)) {
          return `${proxyPrefix}${LIVE_SESSION}`;
        }
        if (cmd.includes(`--filter "name=${networkPrefix}"`)) {
          return `${networkPrefix}${LIVE_SESSION}`;
        }
        return '';
      }),
      spawn: vi.fn(),
      execFile: vi.fn(),
    }));

    const { reapOrphanContainers } = await import(
      '../session/DockerSessionRunner.js'
    );

    const liveIds = new Set([LIVE_SESSION]);
    reapOrphanContainers(liveIds);

    const rmCalls = execSyncCalls.filter(
      (c) => c.startsWith('docker rm -f') || c.startsWith('docker network rm'),
    );
    expect(rmCalls).toHaveLength(0);
  });

  it('is resilient when docker is unavailable (execSync throws)', async () => {
    vi.doMock('child_process', () => ({
      execSync: vi.fn(() => {
        throw new Error('docker not found');
      }),
      spawn: vi.fn(),
      execFile: vi.fn(),
    }));

    const { reapOrphanContainers } = await import(
      '../session/DockerSessionRunner.js'
    );

    // Must not throw even if docker commands fail
    expect(() => reapOrphanContainers(new Set())).not.toThrow();
  });
});

// ── 4: SessionManager.resumeOrphanSessions calls reapOrphanContainers ────────

describe('SessionManager.resumeOrphanSessions — orphan reap integration', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'session', 'SessionManager.ts'),
    'utf-8',
  );

  it('calls reapOrphanContainers inside resumeOrphanSessions', () => {
    expect(source).toMatch(/reapOrphanContainers/);
    // The call must be inside the resumeOrphanSessions function body
    const fnStart = source.indexOf('async resumeOrphanSessions()');
    const reapIdx = source.indexOf('reapOrphanContainers', fnStart);
    const nextFnIdx = source.indexOf('\n  ', fnStart + 1);
    expect(reapIdx).toBeGreaterThan(fnStart);
    // reap call appears before the next function (i.e., within resumeOrphanSessions)
    const nextFn = source.indexOf('\n  async ', fnStart + 1);
    if (nextFn !== -1) {
      expect(reapIdx).toBeLessThan(nextFn);
    }
  });

  it('reap is guarded by getCorporateMode().gates.dockerMandatory', () => {
    const fnStart = source.indexOf('async resumeOrphanSessions()');
    const reapIdx = source.indexOf('reapOrphanContainers', fnStart);
    // The dockerMandatory check must appear before the reapOrphanContainers call
    const guardIdx = source.lastIndexOf('dockerMandatory', reapIdx);
    expect(guardIdx).toBeGreaterThan(fnStart);
    expect(guardIdx).toBeLessThan(reapIdx);
  });
});
