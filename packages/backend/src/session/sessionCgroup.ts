import fs from 'fs';
import os from 'os';
import path from 'path';
import { runtimeSettings } from '../config';
import { logger } from '../logger';
import {
  getTestRequestRunById,
  getSession,
  TERMINAL_SESSION_STATUSES_WITH_SUPERSEDED,
} from '../db/queries';
import { recordEvent } from '../audit/AuditLog';

const CGROUP_ROOT = '/sys/fs/cgroup';
const MAIN_LEAF = 'main';
const SESSIONS_LEAF = 'sessions';
const TESTS_LEAF = 'tests';

/** Absolute path of the delegated sessions/ cgroup once set up; null when unavailable. */
let sessionsCgroupPath: string | null = null;

/** Absolute path of the delegated main/ cgroup (the backend's own resting
 * place) once set up; null when unavailable. */
let mainCgroupPath: string | null = null;

/**
 * Absolute path of the delegated tests/ cgroup — a sessions/-sibling leaf
 * whose per-run sub-cgroups (tests/<runId>/, see spawnIntoTestRunCgroup)
 * bound every test-request-lane subprocess, session-owned or not, once set
 * up; null when unavailable. Kept distinct from sessions/ per the locked
 * decision: a test run's bound must not depend on whether it happens to
 * have an owning session, and commingling test workers into a session's own
 * sub-cgroup would give killSessionCgroup a kill scope wider than "this
 * session's own agent process tree". Runs are further isolated from each
 * other by their own per-run leaf so one run's teardown can never reach a
 * sibling run's tree either.
 */
let testsCgroupPath: string | null = null;

/** Derived cgroup memory limits, in bytes. */
export interface SessionCgroupLimits {
  maxBytes: number;
  highBytes: number;
  denySwap: boolean;
}

/**
 * Pure derivation of memory.max / memory.high from configured settings and
 * total host memory. memory.max reserves `prodReserveMb` for the co-hosted
 * production fleet; memory.high sits at `highFraction` of memory.max.
 */
export function computeSessionCgroupLimits(inputs: {
  totalMemBytes: number;
  prodReserveMb: number;
  highFraction: number;
  denySwap: boolean;
}): SessionCgroupLimits {
  const reserveBytes = inputs.prodReserveMb * 1024 * 1024;
  const maxBytes = Math.max(0, inputs.totalMemBytes - reserveBytes);
  const highBytes = Math.floor(maxBytes * inputs.highFraction);
  return { maxBytes, highBytes, denySwap: inputs.denySwap };
}

function currentLimits(): SessionCgroupLimits {
  return computeSessionCgroupLimits({
    totalMemBytes: os.totalmem(),
    prodReserveMb: runtimeSettings.session_cgroup_prod_reserve_mb,
    highFraction: runtimeSettings.session_cgroup_memory_high_fraction,
    denySwap: runtimeSettings.session_cgroup_deny_swap,
  });
}

function warnNoop(reason: string): void {
  logger.warn(
    `[sessionCgroup] delegated cgroup unavailable (${reason}) — session memory cap disabled, spawns proceed unbounded`,
  );
}

/** Resolves the backend's own cgroup-v2 path from /proc/self/cgroup, or null if not v2. */
function readOwnCgroupPath(): string | null {
  const raw = fs.readFileSync('/proc/self/cgroup', 'utf8');
  const line = raw.split('\n').find((l) => l.startsWith('0::'));
  if (!line) return null;
  const relPath = line.slice('0::'.length).trim();
  if (!relPath) return null;
  return path.join(CGROUP_ROOT, relPath);
}

function writeLimitsTo(dir: string, limits: SessionCgroupLimits): void {
  fs.writeFileSync(path.join(dir, 'memory.max'), String(limits.maxBytes));
  fs.writeFileSync(path.join(dir, 'memory.high'), String(limits.highBytes));
  fs.writeFileSync(
    path.join(dir, 'memory.swap.max'),
    limits.denySwap ? '0' : 'max',
  );
}

/** Applies the current derived limits to every delegated leaf that's set up. */
function writeLimits(limits: SessionCgroupLimits): void {
  if (sessionsCgroupPath) writeLimitsTo(sessionsCgroupPath, limits);
  if (testsCgroupPath) writeLimitsTo(testsCgroupPath, limits);
}

/**
 * One-time boot setup: detects the delegated cgroup subtree, creates the
 * main/ and sessions/ leaves, moves the backend's own process into main/
 * (required by cgroup-v2's no-internal-processes rule), and applies memory
 * limits to sessions/. No-ops with a logged warning on any failure — a
 * missing Delegate=yes drop-in, non-Linux, or cgroup-v1 must never crash boot.
 */
export function setupSessionCgroup(): void {
  if (process.platform !== 'linux') {
    warnNoop(`unsupported platform ${process.platform}`);
    return;
  }
  try {
    if (!fs.existsSync(path.join(CGROUP_ROOT, 'cgroup.controllers'))) {
      warnNoop('not a cgroup-v2 unified hierarchy');
      return;
    }

    const ownPath = readOwnCgroupPath();
    if (!ownPath || !fs.existsSync(ownPath)) {
      warnNoop('could not resolve own cgroup-v2 path');
      return;
    }

    const controllers = fs.readFileSync(
      path.join(ownPath, 'cgroup.controllers'),
      'utf8',
    );
    if (!controllers.split(/\s+/).includes('memory')) {
      warnNoop('memory controller not delegated to this cgroup');
      return;
    }

    const mainPath = path.join(ownPath, MAIN_LEAF);
    const sessionsPath = path.join(ownPath, SESSIONS_LEAF);
    const testsPath = path.join(ownPath, TESTS_LEAF);
    fs.mkdirSync(mainPath, { recursive: true });
    fs.mkdirSync(sessionsPath, { recursive: true });
    fs.mkdirSync(testsPath, { recursive: true });

    // Move the backend's own process into main/ first — cgroup-v2's
    // no-internal-processes rule forbids enabling subtree_control while
    // this cgroup still holds member processes (fails with EBUSY).
    fs.writeFileSync(path.join(mainPath, 'cgroup.procs'), String(process.pid));

    // Now that the parent holds no processes, enable the memory
    // controller for its child cgroups.
    fs.writeFileSync(path.join(ownPath, 'cgroup.subtree_control'), '+memory');

    mainCgroupPath = mainPath;
    sessionsCgroupPath = sessionsPath;
    testsCgroupPath = testsPath;
    writeLimits(currentLimits());
    logger.info(
      `[sessionCgroup] delegated cgroup ready at ${ownPath} — sessions bounded via ${sessionsPath}, test-lane runs bounded via ${testsPath}`,
    );
  } catch (err) {
    sessionsCgroupPath = null;
    mainCgroupPath = null;
    testsCgroupPath = null;
    warnNoop((err as Error).message);
  }
}

/** Re-applies memory limits from current runtimeSettings; no-op when not set up. */
export function reapplySessionCgroupLimits(): void {
  if (!sessionsCgroupPath && !testsCgroupPath) return;
  try {
    writeLimits(currentLimits());
  } catch (err) {
    logger.warn(
      `[sessionCgroup] failed to reapply limits: ${(err as Error).message}`,
    );
  }
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Absolute path of the per-session sub-cgroup for `sessionId`, nested under
 * the delegated sessions/ leaf. Pure path derivation — callers must still
 * check sessionsCgroupPath is non-null before using this.
 */
function sessionCgroupDir(sessionId: string): string {
  return path.join(sessionsCgroupPath!, sanitizeSessionId(sessionId));
}

/**
 * Places a spawned session subprocess's PID into a cgroup.
 *
 * When `sessionId` is given, the pid is placed into a per-session
 * sub-cgroup (sessions/<sessionId>/), created on demand — this is what
 * makes killSessionCgroup's cgroup-scoped kill possible later. cgroup-v2
 * membership is inherited at fork, so the whole subtree (including
 * grandchildren that call setsid() and escape the process group) stays in
 * this cgroup regardless of process-group or parent-pid changes.
 *
 * Without `sessionId`, the pid is placed directly into the shared
 * sessions/ leaf (legacy behavior, used for one-off subprocesses that
 * don't have a session lifecycle to tear down against).
 *
 * No-ops silently when the delegated subtree was never set up — a spawn
 * must never fail because of this.
 */
export function placeSessionPid(pid: number, sessionId?: string): void {
  if (!sessionsCgroupPath) return;
  try {
    const dir = sessionId ? sessionCgroupDir(sessionId) : sessionsCgroupPath;
    if (sessionId) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cgroup.procs'), String(pid));
  } catch (err) {
    logger.warn(
      `[sessionCgroup] failed to place pid ${pid} into ${sessionId ? `session ${sessionId.slice(0, 8)}` : 'sessions'} cgroup: ${(err as Error).message}`,
    );
  }
}

/**
 * Runs `spawnFn` (expected to synchronously call child_process.spawn) with
 * the backend's own process temporarily relocated into the session's
 * sub-cgroup, so the spawned child is *born* into sessions/<sessionId>/
 * rather than being migrated there after the fact.
 *
 * This closes the fork-time race that a post-spawn placeSessionPid() call
 * can't: a child inherits its parent's cgroup at fork(), not at whatever
 * later moment the parent gets around to writing cgroup.procs. If that
 * child forks a grandchild (e.g. a test command that starts a temp
 * postgres cluster) before the post-spawn placement write lands, the
 * grandchild is born into whatever cgroup the parent was still in at that
 * moment — main/, in the pre-fix code — and stays there for its entire
 * life, invisible to killSessionCgroup. Relocating the backend itself
 * *before* calling spawn() means there is no window in which the new
 * child (or anything it forks synchronously) could ever observe the
 * backend sitting in main/.
 *
 * Node is single-threaded and every step here is a synchronous fs call, so
 * no other code can spawn a process (and thus observe the backend
 * mid-relocation) between the move-in and the restore. Falls back to
 * calling `spawnFn` directly, unrelocated, when the delegated subtree was
 * never set up.
 */
export function spawnIntoSessionCgroup<T>(
  sessionId: string,
  spawnFn: () => T,
): T {
  if (!sessionsCgroupPath || !mainCgroupPath) return spawnFn();
  return relocateForSpawn(
    sessionCgroupDir(sessionId),
    `session ${sessionId.slice(0, 8)}`,
    { mkdir: true },
    spawnFn,
  );
}

function sanitizeTestRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Absolute path of the per-run sub-cgroup for `runId`, nested under the
 * delegated tests/ leaf. Pure path derivation — callers must still check
 * testsCgroupPath is non-null before using this.
 */
function testRunCgroupDir(runId: string): string {
  return path.join(testsCgroupPath!, sanitizeTestRunId(runId));
}

/**
 * Test-lane counterpart to spawnIntoSessionCgroup: relocates the backend
 * into a per-run sub-cgroup (tests/<runId>/) before calling `spawnFn`, so a
 * test.request command's subprocess (and anything it forks synchronously —
 * e.g. a temp postgres cluster's postmaster) is born under that bounded,
 * run-scoped leaf rather than main/ or a leaf shared with other concurrent
 * runs, closing the same fork-time race for the test-request lane that
 * spawnIntoSessionCgroup closes for session spawns.
 *
 * Keyed on `runId` (a test_request_runs.id) rather than session — every run
 * gets its own leaf regardless of whether it has an owning session
 * (base_health_probe / pr_pipeline origins carry none), and killTestRunCgroup
 * can never reach a sibling run's tree, a session's tree, or the Remote
 * Control slice as a result.
 *
 * Falls back to calling `spawnFn` directly, unrelocated, when the
 * delegated subtree was never set up.
 */
export function spawnIntoTestRunCgroup<T>(runId: string, spawnFn: () => T): T {
  if (!testsCgroupPath || !mainCgroupPath) return spawnFn();
  return relocateForSpawn(
    testRunCgroupDir(runId),
    `test run ${runId.slice(0, 8)}`,
    { mkdir: true },
    spawnFn,
  );
}

/**
 * Absolute path to a test run's cgroup-v2 memory.current file, or null when
 * the delegated tests/ subtree was never set up. Pure path derivation — does
 * not check whether the run's own leaf actually exists (the leaf is created
 * lazily by spawnIntoTestRunCgroup at spawn time); callers should treat a
 * read failure (e.g. ENOENT before the leaf exists, or after teardown
 * removes it) as "no leaf" and fall back accordingly, the same convention
 * getChildRssMb already uses for a vanished /proc/<pid>.
 */
export function testRunCgroupMemoryCurrentPath(runId: string): string | null {
  if (!testsCgroupPath) return null;
  return path.join(testRunCgroupDir(runId), 'memory.current');
}

/**
 * Kills every process in a test run's sub-cgroup (tests/<runId>/) — the
 * inescapable backstop for the same class of escape killSessionCgroup
 * closes for sessions: a grandchild that called setsid(), or that was
 * re-parented to init after its own parent exited, stays a member of this
 * cgroup regardless, because cgroup-v2 membership is orthogonal to process
 * group and parent pid. Writing cgroup.kill (not scanning for pids by name)
 * is what keeps this scoped to exactly this run's own tree.
 *
 * No-ops (returns true — nothing to kill) when the delegated subtree was
 * never set up, or when this run's sub-cgroup doesn't exist (already torn
 * down, or the run's subprocess never got placed into one). Returns false
 * only when the cgroup exists but the kill write itself failed, so a caller
 * can distinguish "nothing to do" from "tried and failed".
 */
export function killTestRunCgroup(runId: string): boolean {
  if (!testsCgroupPath) return true;
  const dir = testRunCgroupDir(runId);
  if (!fs.existsSync(dir)) return true;
  try {
    fs.writeFileSync(path.join(dir, 'cgroup.kill'), '1');
    return true;
  } catch (err) {
    logger.warn(
      `[sessionCgroup] failed to kill cgroup for test run ${runId.slice(0, 8)}: ${(err as Error).message}`,
    );
    return false;
  }
}

/**
 * Whether a test run's sub-cgroup currently holds no live processes — the
 * verify half of "verify before settle": a timed-out (or normally-exited)
 * run must not be recorded as finished while a member of its cgroup is
 * still alive. Returns true (nothing to verify) when cgroups were never set
 * up or the run's leaf doesn't exist, so this degrades to a no-op on
 * platforms/configs without delegated cgroup-v2 rather than falsely
 * reporting survivors.
 */
export function isTestRunCgroupEmpty(runId: string): boolean {
  if (!testsCgroupPath) return true;
  const dir = testRunCgroupDir(runId);
  try {
    if (!fs.existsSync(dir)) return true;
    const procs = fs
      .readFileSync(path.join(dir, 'cgroup.procs'), 'utf8')
      .trim();
    return procs === '';
  } catch {
    return true;
  }
}

/**
 * Removes a now-empty test run sub-cgroup directory. Best-effort: called
 * only once verification has confirmed the cgroup holds no processes, but
 * still swallows errors since a zombie awaiting reap by its (now-dead)
 * original parent can briefly keep the dir non-empty, and a leftover empty
 * directory is otherwise harmless.
 */
export function removeTestRunCgroup(runId: string): void {
  if (!testsCgroupPath) return;
  try {
    fs.rmdirSync(testRunCgroupDir(runId));
  } catch {
    // best-effort — see doc comment
  }
}

/**
 * Shared relocate-spawn-restore body for spawnIntoSessionCgroup and
 * spawnIntoTestRunCgroup: moves the backend's own pid into `dir`, runs
 * `spawnFn` synchronously (so any child born during the call inherits
 * `dir`), then restores the backend to main/ before returning. Node is
 * single-threaded and every step here is a synchronous fs call, so no
 * other code can observe the backend mid-relocation. `mainCgroupPath` is
 * guaranteed non-null by both callers' guards.
 */
function relocateForSpawn<T>(
  dir: string,
  label: string,
  opts: { mkdir?: boolean },
  spawnFn: () => T,
): T {
  let relocated = false;
  try {
    if (opts.mkdir) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cgroup.procs'), String(process.pid));
    relocated = true;
  } catch (err) {
    logger.warn(
      `[sessionCgroup] failed to relocate backend into ${label} cgroup for spawn: ${(err as Error).message}`,
    );
  }
  try {
    return spawnFn();
  } finally {
    if (relocated) {
      try {
        fs.writeFileSync(
          path.join(mainCgroupPath!, 'cgroup.procs'),
          String(process.pid),
        );
      } catch (err) {
        logger.warn(
          `[sessionCgroup] failed to restore backend to main cgroup after spawn: ${(err as Error).message}`,
        );
      }
    }
  }
}

/**
 * Kills every process in a session's sub-cgroup (sessions/<sessionId>/) and
 * removes the directory — the backstop for the escape killProcessTree's
 * process-group kill(-pid) can't reach: a grandchild that called setsid()
 * (or was re-parented after its parent exited) stays a member of this
 * cgroup regardless, because cgroup-v2 membership is orthogonal to process
 * group and parent pid.
 *
 * Writing to cgroup.kill (not scanning for pids by name) is what keeps this
 * scoped to exactly this session's own tree — it can never reach a sibling
 * session's cgroup, main/, or anything outside sessions/<sessionId>/.
 *
 * No-ops when the delegated subtree was never set up, or when this
 * session's sub-cgroup doesn't exist (already torn down, or never
 * created) — idempotent by construction.
 */
export function killSessionCgroup(sessionId: string): void {
  if (!sessionsCgroupPath) return;
  const dir = sessionCgroupDir(sessionId);
  if (!fs.existsSync(dir)) return;
  try {
    fs.writeFileSync(path.join(dir, 'cgroup.kill'), '1');
  } catch (err) {
    logger.warn(
      `[sessionCgroup] failed to kill cgroup for session ${sessionId.slice(0, 8)}: ${(err as Error).message}`,
    );
    return;
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    // Non-fatal: the kill already reached every process. A zombie awaiting
    // reap by its (now-dead) original parent can keep the dir non-empty
    // briefly; the directory is otherwise harmless left behind.
  }
}

/** Reads a pid's parent pid from /proc/<pid>/stat; null if unreadable (pid gone). */
function readPpid(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm (2nd field) is parenthesized and may itself contain spaces/parens
    // — find the *last* ')' to skip past it before splitting the rest.
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
    const fields = afterComm.split(' ');
    const ppid = parseInt(fields[1], 10);
    return Number.isNaN(ppid) ? null : ppid;
  } catch {
    return null;
  }
}

function listMainCgroupPids(): number[] {
  if (!mainCgroupPath) return [];
  try {
    return fs
      .readFileSync(path.join(mainCgroupPath, 'cgroup.procs'), 'utf8')
      .split('\n')
      .map((l) => parseInt(l.trim(), 10))
      .filter((n) => !Number.isNaN(n));
  } catch {
    return [];
  }
}

export interface OrphanReapDeps {
  listMainCgroupPids: () => number[];
  readPpid: (pid: number) => number | null;
  kill: (pid: number) => void;
  ownPid: number;
}

/**
 * Teardown backstop for the memory/disk leak this module exists to close:
 * anything sitting in main/ (the backend's own resting cgroup) that has
 * been re-parented to init (ppid === 1) is, by construction, not the
 * backend itself and not a live child the backend is still tracking — it's
 * a daemonizing grandchild (e.g. a temp postgres cluster's postmaster,
 * double-forked by pg_ctl) whose immediate parent already exited. Nothing
 * in main/ is ever supposed to reach that state: legitimate one-off
 * spawns from the backend (git, etc.) are non-daemonizing and either exit
 * normally or stay attached to a live parent. Kills every such pid and
 * returns how many were reaped.
 *
 * A pid that is *not* re-parented (ppid still resolves and isn't 1) is
 * left alone — it may be a legitimate short-lived helper still running
 * under the backend's own pid, which briefly shares main/ with the
 * backend during any window outside spawnIntoSessionCgroup's relocation.
 */
export function reapOrphanedMainCgroupProcesses(
  deps: Partial<OrphanReapDeps> = {},
): number {
  if (!mainCgroupPath) return 0;
  const listPids = deps.listMainCgroupPids ?? listMainCgroupPids;
  const getPpid = deps.readPpid ?? readPpid;
  const kill = deps.kill ?? ((pid: number) => process.kill(pid, 'SIGKILL'));
  const ownPid = deps.ownPid ?? process.pid;

  let reaped = 0;
  for (const pid of listPids()) {
    if (pid === ownPid) continue;
    if (getPpid(pid) !== 1) continue;
    try {
      kill(pid);
      reaped++;
      logger.warn(
        `[sessionCgroup] reaped orphaned process ${pid} found sitting in main/ cgroup with ppid=1`,
      );
    } catch (err) {
      logger.warn(
        `[sessionCgroup] failed to reap orphaned process ${pid}: ${(err as Error).message}`,
      );
    }
  }
  return reaped;
}

function listTestRunDirNames(): string[] {
  if (!testsCgroupPath) return [];
  try {
    return fs
      .readdirSync(testsCgroupPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function listTestRunCgroupPids(runId: string): number[] {
  if (!testsCgroupPath) return [];
  try {
    return fs
      .readFileSync(path.join(testsCgroupPath, runId, 'cgroup.procs'), 'utf8')
      .split('\n')
      .map((l) => parseInt(l.trim(), 10))
      .filter((n) => !Number.isNaN(n));
  } catch {
    return [];
  }
}

/**
 * Whether the test run leaf named `runId` (a tests/<runId>/ sub-cgroup) has
 * no live owning session — i.e. is safe to reap. A run with no DB row, or
 * no session_id (e.g. a base-health-probe or pr-pipeline run with no
 * originating session), or whose session row has already gone terminal, all
 * mean nothing is still using this cluster. A run whose session is still
 * non-terminal is left alone: a temp postgres cluster legitimately outlives
 * individual test files within one still-running session.
 */
function isTestRunReapable(runId: string): boolean {
  const run = getTestRequestRunById(runId);
  if (!run || !run.session_id) return true;
  const session = getSession(run.session_id);
  if (!session) return true;
  return TERMINAL_SESSION_STATUSES_WITH_SUPERSEDED.has(session.status);
}

export interface TestsCgroupOrphanReapDeps {
  listTestRunDirs: () => string[];
  listRunCgroupPids: (runId: string) => number[];
  readPpid: (pid: number) => number | null;
  isRunReapable: (runId: string) => boolean;
  kill: (pid: number) => void;
  ownPid: number;
}

/**
 * tests/-scoped counterpart to reapOrphanedMainCgroupProcesses: a temp
 * postgres cluster (or any other test-lane subprocess) spawned under
 * tests/<runId>/ whose owning pytest/test-request worker dies before
 * teardown runs re-parents to init but is invisible to the main/ sweep,
 * which only ever scans main/. Same ppid=1 safety signal, plus one more
 * check the main/ sweep doesn't need: a cluster legitimately outlives
 * individual test files within one still-running session, so a leaf is
 * only reaped once isTestRunReapable confirms its owning session (if any)
 * has already gone terminal.
 *
 * A pid that is not re-parented (ppid still resolves and isn't 1) is left
 * alone — it may be a legitimate subprocess still attached to a live
 * parent within the same run.
 */
export function reapOrphanedTestsCgroupProcesses(
  deps: Partial<TestsCgroupOrphanReapDeps> = {},
): number {
  if (!testsCgroupPath) return 0;
  const listRunDirs = deps.listTestRunDirs ?? listTestRunDirNames;
  const listRunPids = deps.listRunCgroupPids ?? listTestRunCgroupPids;
  const getPpid = deps.readPpid ?? readPpid;
  const isRunReapable = deps.isRunReapable ?? isTestRunReapable;
  const kill = deps.kill ?? ((pid: number) => process.kill(pid, 'SIGKILL'));
  const ownPid = deps.ownPid ?? process.pid;

  let reaped = 0;
  for (const runId of listRunDirs()) {
    for (const pid of listRunPids(runId)) {
      if (pid === ownPid) continue;
      if (getPpid(pid) !== 1) continue;
      if (!isRunReapable(runId)) continue;
      try {
        kill(pid);
        reaped++;
        logger.warn(
          `[sessionCgroup] reaped orphaned process ${pid} found sitting in tests/${runId}/ cgroup with ppid=1`,
        );
      } catch (err) {
        logger.warn(
          `[sessionCgroup] failed to reap orphaned tests/ process ${pid}: ${(err as Error).message}`,
        );
      }
    }
  }

  if (reaped > 0) {
    recordEvent({
      event_type: 'orphan_processes_reaped',
      actor_type: 'system',
      payload: { reaped_count: reaped, reason: 'tests_cgroup_orphan' },
    });
    logger.info(
      `[sessionCgroup] reaped ${reaped} orphaned process(es) from tests/ cgroup`,
    );
  }

  return reaped;
}

/** Test-only accessor/reset for the module's cached delegated-path state. */
export function _resetForTesting(): void {
  sessionsCgroupPath = null;
  mainCgroupPath = null;
  testsCgroupPath = null;
}

export function _setSessionsPathForTesting(p: string | null): void {
  sessionsCgroupPath = p;
}

export function _setTestsPathForTesting(p: string | null): void {
  testsCgroupPath = p;
}

export function _setMainPathForTesting(p: string | null): void {
  mainCgroupPath = p;
}
