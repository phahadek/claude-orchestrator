/**
 * Periodic disk-space reclamation sweep for the dependency-cache pool (see
 * dependencyCachePool.ts). Pure space reclamation, decoupled from
 * correctness: a project's `dependency_verify_command` already re-proves an
 * entry's validity on every use, so evicting an entry here can never produce
 * a wrong build — the next launch for that (project, lockHash) simply falls
 * through to a normal cache miss and rebuild.
 *
 * Cadence/shape mirrors WorktreeReconciler.ts's 30-minute periodic sweep
 * rather than inventing a new scheduler.
 *
 * Safety: a `ready` entry's `last_used_at` is touched at the *start* of
 * materialization (see dependencyCachePool.ts), before any copy begins. This
 * sweep never evicts an entry touched within GRACE_MS — a window well short
 * of the sweep interval — so a same-cycle race can't delete a directory
 * another launch is actively copying from.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';
import {
  listReadyDependencyCacheEntries,
  deleteDependencyCacheEntry,
} from '../db/queries';
import { typedGetSetting } from '../config/settings';
import { cacheStorageDir } from './dependencyCachePool';
import type { Scheduler } from './Scheduler';

const MAINTENANCE_INTERVAL_MS = 30 * 60_000;
const GRACE_MS = 5 * 60_000;

async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSizeBytes(full);
    } else {
      try {
        total += (await fs.promises.stat(full)).size;
      } catch {
        // file vanished mid-walk — ignore
      }
    }
  }
  return total;
}

interface SweepStats {
  evictedByAge: number;
  evictedBySize: number;
  bytesFreed: number;
  failed: number;
}

async function runDependencyCacheSweep(): Promise<SweepStats> {
  const stats: SweepStats = {
    evictedByAge: 0,
    evictedBySize: 0,
    bytesFreed: 0,
    failed: 0,
  };

  const maxAgeMs =
    typedGetSetting('dependency_cache_max_age_hours') * 60 * 60_000;
  const maxTotalBytes =
    typedGetSetting('dependency_cache_max_total_size_mb') * 1024 * 1024;

  const now = Date.now();
  const ageCutoff = now - Math.max(maxAgeMs, GRACE_MS);
  const graceCutoff = now - GRACE_MS;

  const entries = listReadyDependencyCacheEntries();

  async function evict(
    entry: (typeof entries)[number],
    size: number,
  ): Promise<boolean> {
    const dir = cacheStorageDir(entry.project_id, entry.lock_hash);
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch (err) {
      stats.failed++;
      logger.error(
        `[DependencyCacheReconciler] failed to remove cache dir ${dir}: ${err}`,
      );
      return false;
    }
    deleteDependencyCacheEntry(entry.project_id, entry.lock_hash);
    stats.bytesFreed += size;
    logger.info(
      `[DependencyCacheReconciler] evicted project ${entry.project_id} lockHash=${entry.lock_hash.slice(0, 12)} bytes=${size}`,
    );
    return true;
  }

  const survivors: { entry: (typeof entries)[number]; size: number }[] = [];
  for (const entry of entries) {
    const size = await dirSizeBytes(
      cacheStorageDir(entry.project_id, entry.lock_hash),
    );
    if (entry.last_used_at < ageCutoff) {
      if (await evict(entry, size)) stats.evictedByAge++;
      continue;
    }
    survivors.push({ entry, size });
  }

  // Size budget: entries are already ordered oldest-used first (see
  // listReadyDependencyCacheEntries), so evicting from the front of
  // `survivors` evicts the least-recently-used entries first.
  let totalBytes = survivors.reduce((sum, s) => sum + s.size, 0);
  for (const { entry, size } of survivors) {
    if (totalBytes <= maxTotalBytes) break;
    if (entry.last_used_at >= graceCutoff) continue; // protected by grace window
    if (await evict(entry, size)) {
      stats.evictedBySize++;
      totalBytes -= size;
    }
  }

  if (stats.evictedByAge > 0 || stats.evictedBySize > 0 || stats.failed > 0) {
    logger.info(
      `[DependencyCacheReconciler] sweep complete — evicted-by-age: ${stats.evictedByAge}, evicted-by-size: ${stats.evictedBySize}, bytes-freed: ${stats.bytesFreed}, failed: ${stats.failed}`,
    );
  }

  return stats;
}

export function register(scheduler: Scheduler): void {
  scheduler.register({
    name: 'dependency_cache_reconciler',
    intervalMs: MAINTENANCE_INTERVAL_MS,
    runOnBoot: true,
    concurrency: 'skip-if-running',
    run: async () => {
      await runDependencyCacheSweep();
    },
  });
}
