import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getPauseIntervalsBySession,
  hasAuthParkedSession,
  insertPauseInterval,
  insertSession,
  updateSessionStatus,
} from '../../db/queries';
import {
  connectAuthResume,
  clearAuthLapse,
  getAuthLapse,
  isAuthAdmitted,
  onAuthRestored,
  recordAuthLapse,
} from '../authAdmission';
import { AuthLapseProbe } from '../AuthLapseProbe';

const OK = {
  exitCode: 0,
  stdout: JSON.stringify({ type: 'result', result: 'ok' }),
};
const AUTH_FAIL = {
  exitCode: 1,
  stdout: JSON.stringify({
    type: 'result',
    is_error: true,
    result: 'Failed to authenticate. API Error: 401',
  }),
};
const NET_FAIL = { exitCode: 1, stdout: '' };

describe('auth lapsed state', () => {
  beforeEach(() => {
    clearAuthLapse();
  });

  it('recording sets the persisted state, re-readable and idempotent', () => {
    expect(isAuthAdmitted().allowed).toBe(true);
    recordAuthLapse(1000);
    recordAuthLapse(2000);
    const state = getAuthLapse();
    expect(state).toEqual({ lapsed: true, since: 1000 });
    expect(isAuthAdmitted()).toMatchObject({
      allowed: false,
      reason: 'cli_auth_lapsed',
    });
  });

  it('clear emits the restored event exactly once', () => {
    const listener = vi.fn();
    const off = onAuthRestored(listener);
    recordAuthLapse();
    expect(clearAuthLapse()).toBe(true);
    expect(clearAuthLapse()).toBe(false);
    off();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clear triggers the resume sweep exactly once with the lapse id', () => {
    const resume = vi.fn().mockResolvedValue(null);
    const off = connectAuthResume(resume);
    recordAuthLapse(4242);
    clearAuthLapse();
    clearAuthLapse();
    off();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]![0]).toBe('4242');
  });
});

describe('auth_failed pause interval closure', () => {
  it('terminalizing closes the open interval and clears hasAuthParkedSession', () => {
    const id = `auth-park-${Date.now()}`;
    insertSession({
      session_id: id,
      task_id: null,
      task_url: 'u',
      project_context_url: 'p',
      status: 'idle',
      started_at: Date.now(),
    } as Parameters<typeof insertSession>[0]);
    insertPauseInterval(id, 'auth_failed');
    expect(hasAuthParkedSession()).toBe(true);
    updateSessionStatus(id, 'done', Date.now());
    expect(hasAuthParkedSession()).toBe(false);
    expect(
      getPauseIntervalsBySession(id).every((p) => p.resumed_at != null),
    ).toBe(true);
  });
});

describe('AuthLapseProbe', () => {
  let now = 0;
  let credPath: string;

  beforeEach(() => {
    clearAuthLapse();
    now = 1_000_000;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-probe-'));
    credPath = path.join(dir, '.credentials.json');
    fs.writeFileSync(credPath, '{}');
  });

  function make(
    exec: () => Promise<{ exitCode: number | null; stdout: string }>,
  ) {
    return new AuthLapseProbe({
      exec,
      now: () => now,
      credentialsPath: credPath,
      isActive: () => getAuthLapse().lapsed,
    });
  }

  it('is idle when the state is clear', async () => {
    const exec = vi.fn().mockResolvedValue(OK);
    const probe = make(exec);
    expect(await probe.tick()).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('failure keeps state and backs off exponentially; success clears', async () => {
    recordAuthLapse();
    const exec = vi
      .fn()
      .mockResolvedValueOnce(AUTH_FAIL)
      .mockResolvedValueOnce(NET_FAIL)
      .mockResolvedValueOnce(OK);
    const probe = make(exec);

    expect(await probe.tick()).toBe(true);
    expect(getAuthLapse().lapsed).toBe(true);
    now += 59_000;
    expect(await probe.tick()).toBe(false);
    now += 1_000;
    expect(await probe.tick()).toBe(true);
    expect(getAuthLapse().lapsed).toBe(true);
    now += 119_000;
    expect(await probe.tick()).toBe(false);
    now += 1_000;
    const listener = vi.fn();
    const off = onAuthRestored(listener);
    expect(await probe.tick()).toBe(true);
    off();
    expect(getAuthLapse().lapsed).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('caps the backoff at 30 minutes', async () => {
    recordAuthLapse();
    const exec = vi.fn().mockResolvedValue(NET_FAIL);
    const probe = make(exec);
    for (let i = 0; i < 8; i++) {
      await probe.tick();
      now += 30 * 60_000;
    }
    const calls = exec.mock.calls.length;
    now -= 1;
    expect(await probe.tick()).toBe(false);
    now += 1;
    expect(await probe.tick()).toBe(true);
    expect(exec).toHaveBeenCalledTimes(calls + 1);
  });

  it('a credentials mtime change probes early but does not clear without success', async () => {
    recordAuthLapse();
    const exec = vi.fn().mockResolvedValue(AUTH_FAIL);
    const probe = make(exec);
    await probe.tick();
    expect(exec).toHaveBeenCalledTimes(1);
    now += 1000;
    expect(await probe.tick()).toBe(false);
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(credPath, future, future);
    expect(await probe.tick()).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(getAuthLapse().lapsed).toBe(true);
  });

  it('probeNow (recheck route) runs immediately and shares an in-flight probe', async () => {
    recordAuthLapse();
    const exec = vi.fn().mockResolvedValue(NET_FAIL);
    const probe = make(exec);
    const [a, b] = await Promise.all([probe.probeNow(), probe.probeNow()]);
    expect(a).toBe('other_failure');
    expect(b).toBe('other_failure');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(getAuthLapse().lapsed).toBe(true);
  });
});
