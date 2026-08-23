/**
 * Tests for isSessionProcessAlive (session/processLiveness.ts).
 *
 * Matches both a fresh spawn (`--session-id <id>`) and a resumed spawn
 * (`--resume <id>`) — see CliSessionRunner/DockerSessionRunner spawnArgs,
 * which use `--resume` instead of `--session-id` whenever a session is
 * resumed rather than freshly started (e.g. every idle-session wake).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execSyncMock = vi.fn();

vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => execSyncMock(...args),
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  isSessionProcessAlive,
  scanWorktreeProcesses,
  killWorktreeProcessTree,
} from '../processLiveness';

beforeEach(() => {
  execSyncMock.mockReset();
});

describe('isSessionProcessAlive', () => {
  it('returns true when a fresh spawn --session-id <id> is in the process table', () => {
    execSyncMock.mockReturnValue('claude --session-id abc-123 --other-flag\n');

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

describe('scanWorktreeProcesses', () => {
  const WORKTREE = '/srv/app/.claude/worktrees/92d1e9c6-session';

  it('matches a pytest worker whose cmdline names the worktree but carries no --session-id/--resume flag', () => {
    // Shape from the observed leak: the venv-rooted pytest worker's argv
    // names the worktree directly (the deleted `.venv/bin/python` path);
    // its shell-wrapper ancestors (`/bin/sh -c uv run task test`) do not,
    // since they were invoked by cwd rather than by full path — the scan
    // still catches the tree's actual leaf workers, which is what holds
    // the deleted worktree's inodes open.
    execSyncMock.mockReturnValue(
      [
        `2898261 /bin/sh -c uv run task test`,
        `2898664 ${WORKTREE}/.venv/bin/python -m pytest -n 2 --dist loadfile --junitxml=.test-reports/pytest.xml`,
        `999999 some-unrelated-proc --session-id other-session`,
      ].join('\n'),
    );

    expect(scanWorktreeProcesses(WORKTREE)).toEqual([2898664]);
  });

  it('never matches a Remote Control process — its cmdline has no occasion to name a per-task worktree', () => {
    execSyncMock.mockReturnValue(
      [
        `42 /usr/bin/claude remote-control`,
        `2898664 ${WORKTREE}/.venv/bin/python -m pytest`,
      ].join('\n'),
    );

    expect(scanWorktreeProcesses(WORKTREE)).toEqual([2898664]);
  });

  it('fails safe (returns empty) when the process table is unreadable', () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('ps failed');
    });

    expect(scanWorktreeProcesses(WORKTREE)).toEqual([]);
  });
});

describe('killWorktreeProcessTree', () => {
  const WORKTREE = '/srv/app/.claude/worktrees/92d1e9c6-session';
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  it('SIGKILLs every matched pid and reports how many signals were sent', () => {
    execSyncMock.mockReturnValue(
      [
        `2898664 ${WORKTREE}/.venv/bin/python -m pytest`,
        `2898262 uv run task test ${WORKTREE}`,
      ].join('\n'),
    );

    const killed = killWorktreeProcessTree(WORKTREE);

    expect(killed).toBe(2);
    expect(killSpy).toHaveBeenCalledWith(2898664, 'SIGKILL');
    expect(killSpy).toHaveBeenCalledWith(2898262, 'SIGKILL');
  });

  it('tolerates a pid that already exited between the scan and the kill', () => {
    execSyncMock.mockReturnValue(`2898664 ${WORKTREE}/.venv/bin/python\n`);
    killSpy.mockImplementation(() => {
      throw new Error('ESRCH');
    });

    let killed: number | undefined;
    expect(() => {
      killed = killWorktreeProcessTree(WORKTREE);
    }).not.toThrow();
    expect(killed).toBe(0);
  });
});
