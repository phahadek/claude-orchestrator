/**
 * Dependency-cache pool: an opt-in fast path in front of a project's
 * `bootstrap_script` (see SessionManager.ts's completeStart), for projects
 * that declare `dependency_lock_paths` / `dependency_cache_dirs` /
 * `dependency_verify_command` in `.claude-orchestrator.yml`.
 *
 * Shape mirrors orchestration/testRequestLane.ts:
 *  - Fast-path lookup key: a content hash over the declared lock file(s)
 *    (analyzeGating.ts's computeTriggerContentHash), keying a durable
 *    `dependency_cache_entries` row. Only a `ready` row is a valid hit — a
 *    crash mid-build leaves a `building` row, resolved by the boot-time
 *    recoverInterruptedDependencyCacheBuilds sweep (mirrors
 *    recoverInterruptedTestRequestRuns).
 *  - Build-coalescing: concurrent session launches for the same
 *    (projectId, lockHash) share one in-flight bootstrap_script run via an
 *    in-flight Promise map, the same pattern testRequestLane's
 *    `inFlightRuns` uses. No new admission/concurrency cap — this reuses
 *    the existing session-launch concurrency limits.
 *  - Materialization is always a plain recursive copy into the run's
 *    worktree over the declared `dependency_cache_dirs`, never a
 *    symlink/hardlink.
 *  - Correctness gate: after materializing a candidate hit (or after a
 *    follower joins someone else's build), the project's
 *    `dependency_verify_command` must exit zero. A non-zero exit is treated
 *    exactly like a cache miss.
 */

import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger';
import { getDataDir } from '../config/dataDir';
import { computeTriggerContentHash } from '../session/analyzeGating';
import {
  insertBuildingDependencyCacheEntry,
  markDependencyCacheEntryStatus,
  getReadyDependencyCacheEntry,
  touchDependencyCacheEntryLastUsed,
  listBuildingDependencyCacheEntries,
} from '../db/queries';

const exec = promisify(execCb);

export interface DependencyCachePoolSpec {
  projectId: string;
  projectDir: string;
  worktreePath: string;
  bootstrapScript: string;
  lockPaths: string[];
  cacheDirs: string[];
  verifyCommand: string;
  sessionId: string;
}

const BOOTSTRAP_TIMEOUT_MS = 120_000;
const VERIFY_TIMEOUT_MS = 120_000;

export function cacheStorageDir(projectId: string, lockHash: string): string {
  return path.join(getDataDir(), 'dependency-cache', projectId, lockHash);
}

function coalesceKey(projectId: string, lockHash: string): string {
  return `${projectId}:${lockHash}`;
}

/** Recursive, non-symlink copy — always a fresh copy of `src` at `dest`. */
function copyDir(src: string, dest: string): void {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true });
}

/** Copies each declared cache dir from durable storage into the worktree. Returns false if any source is missing. */
function materializeCacheDirs(
  projectId: string,
  lockHash: string,
  cacheDirs: string[],
  worktreePath: string,
): boolean {
  const storageDir = cacheStorageDir(projectId, lockHash);
  for (const rel of cacheDirs) {
    const src = path.join(storageDir, rel);
    if (!fs.existsSync(src)) return false;
    try {
      copyDir(src, path.join(worktreePath, rel));
    } catch (err) {
      logger.warn(
        `[dependencyCachePool] materialize failed for ${rel}: ${err}`,
      );
      return false;
    }
  }
  return true;
}

/** Copies each declared cache dir from a freshly-built worktree into durable storage. Returns false if any output is missing. */
function publishCacheDirs(
  projectId: string,
  lockHash: string,
  cacheDirs: string[],
  worktreePath: string,
): boolean {
  const storageDir = cacheStorageDir(projectId, lockHash);
  for (const rel of cacheDirs) {
    const src = path.join(worktreePath, rel);
    if (!fs.existsSync(src)) return false;
    try {
      copyDir(src, path.join(storageDir, rel));
    } catch (err) {
      logger.warn(`[dependencyCachePool] publish failed for ${rel}: ${err}`);
      return false;
    }
  }
  return true;
}

async function runVerify(
  worktreePath: string,
  verifyCommand: string,
): Promise<boolean> {
  try {
    await exec(verifyCommand, {
      cwd: worktreePath,
      timeout: VERIFY_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    logger.info(`[dependencyCachePool] verify command failed: ${err}`);
    return false;
  }
}

const inFlightBuilds = new Map<string, Promise<boolean>>();

/**
 * Runs (or joins) the coalesced full-bootstrap build for
 * (spec.projectId, lockHash), executed in `spec.worktreePath` — the first
 * caller's worktree becomes the build site; later joiners share this same
 * promise rather than re-running bootstrap_script themselves.
 */
function runCoalescedBuild(
  spec: DependencyCachePoolSpec,
  lockHash: string,
): Promise<boolean> {
  const key = coalesceKey(spec.projectId, lockHash);
  const existing = inFlightBuilds.get(key);
  if (existing) return existing;

  const build = executeBuild(spec, lockHash).finally(() => {
    if (inFlightBuilds.get(key) === build) inFlightBuilds.delete(key);
  });
  inFlightBuilds.set(key, build);
  return build;
}

async function executeBuild(
  spec: DependencyCachePoolSpec,
  lockHash: string,
): Promise<boolean> {
  insertBuildingDependencyCacheEntry(spec.projectId, lockHash);
  try {
    await exec(`bash "${spec.bootstrapScript}" "${spec.worktreePath}"`, {
      cwd: spec.projectDir,
      timeout: BOOTSTRAP_TIMEOUT_MS,
    });
    if (
      !publishCacheDirs(
        spec.projectId,
        lockHash,
        spec.cacheDirs,
        spec.worktreePath,
      )
    ) {
      markDependencyCacheEntryStatus(spec.projectId, lockHash, 'failed');
      return false;
    }
    markDependencyCacheEntryStatus(spec.projectId, lockHash, 'ready');
    return true;
  } catch (err) {
    logger.warn(
      `[dependencyCachePool] bootstrap build failed for project ${spec.projectId}: ${err}`,
    );
    markDependencyCacheEntryStatus(spec.projectId, lockHash, 'failed');
    return false;
  }
}

/**
 * Attempts the dependency-cache pool path for a session launch. Returns
 * true when `spec.worktreePath` is fully provisioned (a verified cache hit,
 * or a coalesced/solo build that ran bootstrap_script and published a fresh
 * entry) — the caller should skip its own bootstrap_script call. Returns
 * false when the pool isn't applicable (no lock files matched) or every
 * path failed — the caller must fall back to running bootstrap_script
 * itself, exactly as it does for projects that never opted in.
 */
export async function tryDependencyCachePool(
  spec: DependencyCachePoolSpec,
): Promise<boolean> {
  const lockHash = await computeTriggerContentHash(
    spec.worktreePath,
    spec.lockPaths,
  );
  if (!lockHash) return false;

  const existing = getReadyDependencyCacheEntry(spec.projectId, lockHash);
  if (existing) {
    // Touched before materialization starts (not after) — the periodic
    // DependencyCacheReconciler sweep never evicts an entry it just saw
    // touched within its grace window, so this closes the race where the
    // sweep could delete a storage dir another launch is actively copying
    // from.
    touchDependencyCacheEntryLastUsed(spec.projectId, lockHash);
    if (
      materializeCacheDirs(
        spec.projectId,
        lockHash,
        spec.cacheDirs,
        spec.worktreePath,
      ) &&
      (await runVerify(spec.worktreePath, spec.verifyCommand))
    ) {
      logger.info(
        `[dependencyCachePool] cache hit for project ${spec.projectId} lockHash=${lockHash.slice(0, 12)} session=${spec.sessionId.slice(0, 8)}`,
      );
      return true;
    }
    logger.info(
      `[dependencyCachePool] cache hit failed verify for project ${spec.projectId} lockHash=${lockHash.slice(0, 12)} — treating as miss`,
    );
  }

  const isLeader = !inFlightBuilds.has(coalesceKey(spec.projectId, lockHash));
  const built = await runCoalescedBuild(spec, lockHash);
  if (!built) return false;

  if (isLeader) {
    // bootstrap_script already ran directly in this session's own worktree.
    return true;
  }

  // Dependencies were built in a different session's worktree — materialize + verify locally.
  touchDependencyCacheEntryLastUsed(spec.projectId, lockHash);
  if (
    materializeCacheDirs(
      spec.projectId,
      lockHash,
      spec.cacheDirs,
      spec.worktreePath,
    ) &&
    (await runVerify(spec.worktreePath, spec.verifyCommand))
  ) {
    return true;
  }
  return false;
}

/**
 * Boot-time recovery: a `building` row left over from a prior process (the
 * backend was killed/crashed mid-build) can never resolve its own
 * coalescing promise again — that in-memory state died with the process —
 * so it is marked `failed` rather than left stuck, forcing the next
 * session launch for that (project, lockHash) to rebuild from scratch.
 */
export function recoverInterruptedDependencyCacheBuilds(): void {
  const building = listBuildingDependencyCacheEntries();
  for (const entry of building) {
    logger.warn(
      `[dependencyCachePool] recovering interrupted build ${entry.project_id}:${entry.lock_hash.slice(0, 12)} as failed`,
    );
    markDependencyCacheEntryStatus(entry.project_id, entry.lock_hash, 'failed');
  }
}
