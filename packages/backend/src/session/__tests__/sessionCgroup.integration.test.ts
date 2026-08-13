import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import {
  placeSessionPid,
  killSessionCgroup,
  _resetForTesting,
  _setSessionsPathForTesting,
} from '../sessionCgroup';

/**
 * Real cgroup-v2, no mocked fs. This is the regression coverage for the
 * exact escape described in the task: killProcessTree's `process.kill(-pid,
 * signal)` targets a process *group*, so a grandchild that calls setsid()
 * leaves that group and survives a teardown that only signals it. A
 * cgroup-scoped kill doesn't have that gap — cgroup-v2 membership is
 * inherited at fork and is unaffected by setsid() or by the parent's own
 * exit/reparenting.
 *
 * Skips (rather than fails) when the host doesn't expose a writable
 * delegated cgroup-v2 subtree — CI runners commonly don't.
 */

const CGROUP_ROOT = '/sys/fs/cgroup';

function readOwnCgroupPath(): string | null {
  try {
    const raw = fs.readFileSync('/proc/self/cgroup', 'utf8');
    const line = raw.split('\n').find((l) => l.startsWith('0::'));
    if (!line) return null;
    const rel = line.slice('0::'.length).trim();
    if (!rel) return null;
    return path.join(CGROUP_ROOT, rel);
  } catch {
    return null;
  }
}

let testRoot: string | null = null;
let available = false;

beforeAll(() => {
  const ownPath = readOwnCgroupPath();
  if (!ownPath) return;
  const probe = path.join(ownPath, `cgtest-probe-${process.pid}`);
  try {
    fs.mkdirSync(probe);
    fs.rmdirSync(probe);
  } catch {
    return;
  }
  testRoot = path.join(
    ownPath,
    `cgtest-${process.pid}-${process.hrtime.bigint()}`,
  );
  try {
    fs.mkdirSync(testRoot);
    available = true;
  } catch {
    testRoot = null;
    available = false;
  }
});

afterAll(() => {
  if (testRoot) {
    try {
      fs.rmdirSync(testRoot);
    } catch {
      // best-effort cleanup
    }
  }
});

const liveProcs: ChildProcess[] = [];
const liveExtraPids: number[] = [];

afterEach(() => {
  _resetForTesting();
  for (const p of liveProcs.splice(0)) {
    try {
      if (p.pid) process.kill(-p.pid, 'SIGKILL');
    } catch {
      // already gone
    }
    try {
      if (p.pid) process.kill(p.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  for (const pid of liveExtraPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Spawns a detached bash "session" whose child grandchild calls setsid(). */
function spawnWithSetsidGrandchild(): ChildProcess {
  const proc = spawn('bash', ['-c', 'setsid sleep 300 & echo $!; wait'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  liveProcs.push(proc);
  return proc;
}

/** Spawns a detached bash "session" with a plain (non-setsid) grandchild. */
function spawnWithPlainGrandchild(): ChildProcess {
  const proc = spawn('bash', ['-c', 'sleep 300 & echo $!; wait'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  liveProcs.push(proc);
  return proc;
}

async function readGrandchildPid(proc: ChildProcess): Promise<number> {
  let out = '';
  proc.stdout!.on('data', (d) => {
    out += d.toString();
  });
  await waitFor(() => out.trim().length > 0);
  const pid = parseInt(out.trim(), 10);
  expect(Number.isNaN(pid)).toBe(false);
  liveExtraPids.push(pid);
  return pid;
}

describe.skipIf(!available || !testRoot)(
  'killSessionCgroup — real cgroup-v2 regression coverage',
  () => {
    it('kills a grandchild that called setsid() and escaped the process group (regression for the killProcessTree gap)', async () => {
      _setSessionsPathForTesting(testRoot);
      const sessionId = `setsid-escape-${process.hrtime.bigint()}`;
      const proc = spawnWithSetsidGrandchild();
      expect(proc.pid).toBeDefined();
      placeSessionPid(proc.pid!, sessionId);

      const gcPid = await readGrandchildPid(proc);
      await waitFor(() => isAlive(gcPid));

      // The existing first-step teardown: process-group kill. Because the
      // grandchild called setsid(), it left this group — this must NOT
      // reach it. This assertion documents/reproduces the defect.
      try {
        process.kill(-proc.pid!, 'SIGKILL');
      } catch {
        // already gone
      }
      await new Promise((r) => setTimeout(r, 200));
      expect(isAlive(gcPid)).toBe(true);

      // The backstop: cgroup-scoped kill reaches it regardless.
      killSessionCgroup(sessionId);
      await waitFor(() => !isAlive(gcPid));
      expect(isAlive(gcPid)).toBe(false);
    });

    it('still kills a grandchild that stayed inside the process group, as today', async () => {
      _setSessionsPathForTesting(testRoot);
      const sessionId = `plain-group-${process.hrtime.bigint()}`;
      const proc = spawnWithPlainGrandchild();
      expect(proc.pid).toBeDefined();
      placeSessionPid(proc.pid!, sessionId);

      const gcPid = await readGrandchildPid(proc);
      await waitFor(() => isAlive(gcPid));

      process.kill(-proc.pid!, 'SIGKILL');
      await waitFor(() => !isAlive(gcPid));
      expect(isAlive(gcPid)).toBe(false);

      // Cgroup teardown afterward must not throw even though the process
      // is already gone (idempotent backstop).
      expect(() => killSessionCgroup(sessionId)).not.toThrow();
    });

    it('is idempotent — tearing down an already-gone session cgroup does not throw', () => {
      _setSessionsPathForTesting(testRoot);
      expect(() =>
        killSessionCgroup(`never-created-${process.hrtime.bigint()}`),
      ).not.toThrow();
      // Calling it twice in a row for a real, freshly-created cgroup must
      // also not throw the second time.
      const sessionId = `double-teardown-${process.hrtime.bigint()}`;
      const dir = path.join(testRoot!, sessionId);
      fs.mkdirSync(dir);
      killSessionCgroup(sessionId);
      expect(fs.existsSync(dir)).toBe(false);
      expect(() => killSessionCgroup(sessionId)).not.toThrow();
    });

    it('tearing down one session leaves a concurrently-running session untouched', async () => {
      _setSessionsPathForTesting(testRoot);
      const sessionA = `concurrent-a-${process.hrtime.bigint()}`;
      const sessionB = `concurrent-b-${process.hrtime.bigint()}`;
      const procA = spawnWithPlainGrandchild();
      const procB = spawnWithPlainGrandchild();
      placeSessionPid(procA.pid!, sessionA);
      placeSessionPid(procB.pid!, sessionB);

      const gcA = await readGrandchildPid(procA);
      const gcB = await readGrandchildPid(procB);
      await waitFor(() => isAlive(gcA) && isAlive(gcB));

      killSessionCgroup(sessionA);
      await waitFor(() => !isAlive(gcA));

      expect(isAlive(gcA)).toBe(false);
      expect(isAlive(gcB)).toBe(true);

      killSessionCgroup(sessionB);
      await waitFor(() => !isAlive(gcB));
    });
  },
);
