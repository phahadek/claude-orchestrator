import fs from 'fs';
import os from 'os';
import path from 'path';
import { runtimeSettings } from '../config';
import { logger } from '../logger';

const CGROUP_ROOT = '/sys/fs/cgroup';
const MAIN_LEAF = 'main';
const SESSIONS_LEAF = 'sessions';

/** Absolute path of the delegated sessions/ cgroup once set up; null when unavailable. */
let sessionsCgroupPath: string | null = null;

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
  const line = raw
    .split('\n')
    .find((l) => l.startsWith('0::'));
  if (!line) return null;
  const relPath = line.slice('0::'.length).trim();
  if (!relPath) return null;
  return path.join(CGROUP_ROOT, relPath);
}

function writeLimits(limits: SessionCgroupLimits): void {
  if (!sessionsCgroupPath) return;
  fs.writeFileSync(
    path.join(sessionsCgroupPath, 'memory.max'),
    String(limits.maxBytes),
  );
  fs.writeFileSync(
    path.join(sessionsCgroupPath, 'memory.high'),
    String(limits.highBytes),
  );
  fs.writeFileSync(
    path.join(sessionsCgroupPath, 'memory.swap.max'),
    limits.denySwap ? '0' : 'max',
  );
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

    // Enable the memory controller for child cgroups of our own leaf.
    fs.writeFileSync(
      path.join(ownPath, 'cgroup.subtree_control'),
      '+memory',
    );

    const mainPath = path.join(ownPath, MAIN_LEAF);
    const sessionsPath = path.join(ownPath, SESSIONS_LEAF);
    fs.mkdirSync(mainPath, { recursive: true });
    fs.mkdirSync(sessionsPath, { recursive: true });

    // Move the backend's own process into main/ — cgroup-v2 forbids a
    // cgroup from holding both processes and controller-enabled children.
    fs.writeFileSync(
      path.join(mainPath, 'cgroup.procs'),
      String(process.pid),
    );

    sessionsCgroupPath = sessionsPath;
    writeLimits(currentLimits());
    logger.info(
      `[sessionCgroup] delegated cgroup ready at ${ownPath} — sessions bounded via ${sessionsPath}`,
    );
  } catch (err) {
    sessionsCgroupPath = null;
    warnNoop((err as Error).message);
  }
}

/** Re-applies memory limits from current runtimeSettings; no-op when not set up. */
export function reapplySessionCgroupLimits(): void {
  if (!sessionsCgroupPath) return;
  try {
    writeLimits(currentLimits());
  } catch (err) {
    logger.warn(
      `[sessionCgroup] failed to reapply limits: ${(err as Error).message}`,
    );
  }
}

/**
 * Places a spawned session subprocess's PID into the sessions/ cgroup.
 * cgroup-v2 membership is inherited at fork, so the whole subtree (child
 * processes it spawns) is bounded. No-ops silently when the delegated
 * subtree was never set up — a spawn must never fail because of this.
 */
export function placeSessionPid(pid: number): void {
  if (!sessionsCgroupPath) return;
  try {
    fs.writeFileSync(
      path.join(sessionsCgroupPath, 'cgroup.procs'),
      String(pid),
    );
  } catch (err) {
    logger.warn(
      `[sessionCgroup] failed to place pid ${pid} into sessions cgroup: ${(err as Error).message}`,
    );
  }
}

/** Test-only accessor/reset for the module's cached delegated-path state. */
export function _resetForTesting(): void {
  sessionsCgroupPath = null;
}

export function _setSessionsPathForTesting(p: string | null): void {
  sessionsCgroupPath = p;
}
