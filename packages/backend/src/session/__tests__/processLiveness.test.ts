/**
 * Tests for isSessionProcessAlive (session/processLiveness.ts).
 *
 * Matches both a fresh spawn (`--session-id <id>`) and a resumed spawn
 * (`--resume <id>`) — see CliSessionRunner/DockerSessionRunner spawnArgs,
 * which use `--resume` instead of `--session-id` whenever a session is
 * resumed rather than freshly started (e.g. every idle-session wake).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const execSyncMock = vi.fn();

vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => execSyncMock(...args),
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { isSessionProcessAlive } from '../processLiveness';

beforeEach(() => {
  execSyncMock.mockReset();
});

describe('isSessionProcessAlive', () => {
  it('returns true when a fresh spawn --session-id <id> is in the process table', () => {
    execSyncMock.mockReturnValue(
      'claude --session-id abc-123 --other-flag\n',
    );

    expect(isSessionProcessAlive('abc-123')).toBe(true);
  });

  it('returns true when a resumed spawn --resume <id> is in the process table', () => {
    execSyncMock.mockReturnValue('claude --resume abc-123 --other-flag\n');

    expect(isSessionProcessAlive('abc-123')).toBe(true);
  });

  it('returns false when neither --session-id nor --resume for this id appears', () => {
    execSyncMock.mockReturnValue(
      'claude --session-id other-session\nsome-unrelated-proc\n',
    );

    expect(isSessionProcessAlive('abc-123')).toBe(false);
  });

  it('fails safe (returns true) when the process table is unreadable', () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('ps failed');
    });

    expect(isSessionProcessAlive('abc-123')).toBe(true);
  });
});
