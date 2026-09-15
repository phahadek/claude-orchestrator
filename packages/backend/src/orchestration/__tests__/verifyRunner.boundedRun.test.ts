/**
 * Verifies that runVerifyAsGate now routes every verify: command through the
 * same bounded test-run machinery the test: lane uses (per-run cgroup
 * placement, timeout escalation, teardown verification) instead of a bare
 * spawn() — see this task's incident: a wedged verify command spawned bare
 * outlived its pipeline for hours because nothing bounded it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── child_process mock ──────────────────────────────────────────────────────

interface MockProc {
  stdout: { on: (e: string, cb: (d: Buffer) => void) => void } | null;
  stderr: { on: (e: string, cb: (d: Buffer) => void) => void } | null;
  pid: number;
  on: (e: string, cb: (...args: unknown[]) => void) => void;
}

type SpawnHook = (cmd: string, opts: unknown) => MockProc;
let _spawnHook: SpawnHook | null = null;

vi.mock('child_process', () => ({
  spawn: (cmd: string, opts: unknown): MockProc => {
    if (_spawnHook) return _spawnHook(cmd, opts);
    return makeProc(0);
  },
}));

function makeProc(
  exitCode: number,
  stdout = '',
  stderr = '',
  delayMs = 0,
): MockProc {
  const closeCbs: Array<(c: number | null, s: string | null) => void> = [];
  const outCbs: Array<(d: Buffer) => void> = [];
  const errCbs: Array<(d: Buffer) => void> = [];

  const proc: MockProc = {
    pid: 1234,
    stdout: {
      on: (e, cb) => {
        if (e === 'data') outCbs.push(cb);
      },
    },
    stderr: {
      on: (e, cb) => {
        if (e === 'data') errCbs.push(cb);
      },
    },
    on: (e, cb) => {
      if (e === 'close')
        closeCbs.push(cb as (c: number | null, s: string | null) => void);
    },
  };

  setTimeout(() => {
    if (stdout) outCbs.forEach((cb) => cb(Buffer.from(stdout)));
    if (stderr) errCbs.forEach((cb) => cb(Buffer.from(stderr)));
    closeCbs.forEach((cb) => cb(exitCode, null));
  }, delayMs);

  return proc;
}

/** A proc that never fires 'close' — mirrors the wedged full-suite pytest tree this task closes. */
function makeNonClosingProc(): MockProc {
  return {
    pid: 4321,
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: () => {},
  };
}

// ── sessionCgroup partial mock: spy on the two calls that prove bounded placement ──

vi.mock('../../session/sessionCgroup', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../session/sessionCgroup')>();
  return {
    ...actual,
    spawnIntoTestRunCgroup: vi.fn(actual.spawnIntoTestRunCgroup),
    isTestRunCgroupEmpty: vi.fn(actual.isTestRunCgroupEmpty),
  };
});

import {
  spawnIntoTestRunCgroup,
  isTestRunCgroupEmpty,
  reapStaleBackendChildProcesses,
  _setMainPathForTesting,
  _resetForTesting,
} from '../../session/sessionCgroup';
import { runVerifyAsGate } from '../verifyRunner';
import { classifyStalledPR } from '../../github/pollUtils';
import type { PullRequestRow } from '../../db/types';

beforeEach(() => {
  vi.useFakeTimers();
  _spawnHook = null;
  vi.spyOn(process, 'kill').mockImplementation(() => true as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  _resetForTesting();
});

describe('runVerifyAsGate — bounded via the shared test-run machinery', () => {
  it('returns passed:false within timeoutSec + grace for a command that never exits, with failedCommand and a [verify] TIMEOUT marker', async () => {
    _spawnHook = () => makeNonClosingProc();

    const promise = runVerifyAsGate('/repo', ['pytest -n 2'], undefined, {
      timeoutSec: 5,
    });
    // 5s timeout + 5s SIGINT grace period + buffer
    await vi.advanceTimersByTimeAsync(11_000);
    const result = await promise;

    expect(result.passed).toBe(false);
    expect(result.failedCommand).toBe('pytest -n 2');
    expect(result.truncatedOutput).toContain('[verify] TIMEOUT');
  });

  it('places each verify command via spawnIntoTestRunCgroup with one runId per runVerifyAsGate invocation, and verifies teardown on completion', async () => {
    _spawnHook = () => makeProc(0, 'ok');

    const promise = runVerifyAsGate('/repo', ['cmd-a', 'cmd-b'], undefined, {
      timeoutSec: 5,
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.passed).toBe(true);
    expect(vi.mocked(spawnIntoTestRunCgroup).mock.calls.length).toBe(2);
    const runIds = vi
      .mocked(spawnIntoTestRunCgroup)
      .mock.calls.map(([runId]) => runId);
    // Same runId reused across every command in this one invocation.
    expect(new Set(runIds).size).toBe(1);
    // verifyRunTeardown (unexported) calls isTestRunCgroupEmpty(runId)
    // internally before settling each command — this is its externally
    // observable signature.
    expect(vi.mocked(isTestRunCgroupEmpty)).toHaveBeenCalledWith(runIds[0]);

    // A second, independent invocation gets a fresh runId rather than
    // reusing the first's.
    const secondPromise = runVerifyAsGate('/repo', ['cmd-c'], undefined, {
      timeoutSec: 5,
    });
    await vi.runAllTimersAsync();
    await secondPromise;
    const secondRunId = vi.mocked(spawnIntoTestRunCgroup).mock.calls.at(-1)![0];
    expect(secondRunId).not.toBe(runIds[0]);
  });
});

describe('a verify timeout does not count as a gate_failed code failure', () => {
  function makePR(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
    return {
      id: 1,
      pr_number: 42,
      pr_url: 'https://github.com/org/repo/pull/42',
      task_id: 'notion:abc123',
      session_id: 'session-1',
      repo: 'org/repo',
      title: 'Test PR',
      body: null,
      head_branch: 'feature/test',
      base_branch: 'dev',
      state: 'open',
      draft: 0,
      review_result: null,
      review_at: null,
      created_at: null,
      updated_at: null,
      synced_at: new Date().toISOString(),
      review_session_id: null,
      review_iteration: 0,
      head_sha: 'sha1',
      last_reviewed_sha: 'sha1',
      last_signalled_head_sha: null,
      node_id: null,
      mergeable: null,
      merge_state: null,
      merge_state_checked_at: null,
      failing_checks: null,
      pending_push: 0,
      pause_reason: null,
      pause_reason_set_at: null,
      ci_remediation_attempted_sha: null,
      pre_review_stage: null,
      conflict_nudge_sha: null,
      stalled_pr_retry_count: 0,
      session_initiated_close_at: null,
      reviewer_requested_at: null,
      flake_recovery_attempts: 0,
      stalled_retry_base_exhausted: 0,
      flake_recovery_base_exhausted: 0,
      human_merge_only: 0,
      pr_intent_id: null,
      reconcile_exhausted: 0,
      reconcile_exhausted_set_at: null,
      ...overrides,
    };
  }

  it('a verify_failed verdict still classifies as gate_failed (regression guard)', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'verify_failed' }),
    });
    expect(classifyStalledPR(pr, null)?.kind).toBe('gate_failed');
  });

  it('a gate_timeout_infra_failure verdict (verify timeout) does not classify as gate_failed', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'gate_timeout_infra_failure' }),
    });
    expect(classifyStalledPR(pr, null)?.kind).not.toBe('gate_failed');
  });
});

describe('reapStaleBackendChildProcesses', () => {
  beforeEach(() => {
    _setMainPathForTesting('/sys/fs/cgroup/orchestrator.service/main');
  });

  it('kills a stale backend-parented pytest process older than the budget and leaves a fresh one alone', () => {
    const ownPid = 100;
    const stalePid = 200;
    const freshPid = 300;
    const budgetSec = 305;
    const killed: number[] = [];

    const reaped = reapStaleBackendChildProcesses(
      (cmdline) => (cmdline.includes('pytest') ? budgetSec : null),
      {
        listMainCgroupPids: () => [stalePid, freshPid],
        readPpid: () => ownPid,
        readCmdline: () => 'sh -c pytest -n 2 --dist loadfile',
        getAgeSec: (pid) =>
          pid === stalePid ? budgetSec + 100 : budgetSec - 100,
        kill: (pid) => killed.push(pid),
        ownPid,
      },
    );

    expect(reaped).toBe(1);
    expect(killed).toEqual([stalePid]);
  });

  it('leaves a process alone whose cmdline does not match any configured project command', () => {
    const ownPid = 100;
    const unrelatedPid = 400;

    const reaped = reapStaleBackendChildProcesses(() => null, {
      listMainCgroupPids: () => [unrelatedPid],
      readPpid: () => ownPid,
      readCmdline: () => '/usr/bin/git status',
      getAgeSec: () => 999_999,
      kill: () => {
        throw new Error('must not be called');
      },
      ownPid,
    });

    expect(reaped).toBe(0);
  });
});
