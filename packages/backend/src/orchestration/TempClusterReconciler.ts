import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { logger } from '../logger';
import type { Scheduler } from './Scheduler';
import { runWithConcurrency } from '../utils/concurrency';

// A wide safety margin well beyond any project's configured test_timeout_sec
// plus the 5s GRACE_PERIOD_MS (test-runner.ts:71) a run could legitimately
// still be inside — see WorktreeReconciler.ts's terminal-session guard for
// the analogous "never touch anything that might still be live" posture.
const ORPHAN_AGE_MS = 2 * 60 * 60_000; // 2h
const MAINTENANCE_INTERVAL_MS = 30 * 60_000;

// testing.postgresql (Python tempfile.mkdtemp(), default prefix) produces
// /tmp/tmpXXXXXXXX; bash mktemp -d produces /tmp/tmp.XXXXXXXXXX. Nothing the
// reconciler reclaims lives under any other name shape, so entries that
// don't match are skipped before any fs.access/stat call.
const TEMP_CLUSTER_ENTRY_RE = /^tmp[A-Za-z0-9_.]{6,}$/;

// Bounds fs.access/stat concurrency for the (small) set of name-shape
// candidates so a future large candidate set can't saturate the threadpool.
const FIND_CLUSTER_CONCURRENCY = 8;

interface SweepStats {
  scanned: number;
  removed: number;
  failed: number;
  skipped: number;
}

async function isPostgresDataDir(dirPath: string): Promise<boolean> {
  try {
    await fs.promises.access(path.join(dirPath, 'PG_VERSION'));
    return true;
  } catch {
    return false;
  }
}

// testing.postgresql lays clusters out at <entry>/data/PG_VERSION; older/manual
// clusters may sit directly at <entry>/PG_VERSION. Check both shapes but do not
// recurse further — this is a fixed two-shape check, not a directory walk.
async function findClusterDir(entryPath: string): Promise<string | null> {
  if (await isPostgresDataDir(entryPath)) return entryPath;
  const dataDir = path.join(entryPath, 'data');
  if (await isPostgresDataDir(dataDir)) return dataDir;
  return null;
}

async function isLive(dirPath: string): Promise<boolean> {
  let contents: string;
  try {
    contents = await fs.promises.readFile(
      path.join(dirPath, 'postmaster.pid'),
      'utf8',
    );
  } catch {
    // Missing postmaster.pid means Postgres never started or already stopped.
    return false;
  }

  const firstLine = contents.split('\n')[0]?.trim();
  const pid = firstLine ? Number(firstLine) : NaN;
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH (or any other failure to signal) — treat as not-live.
    return false;
  }
}

async function reconcileEntry(
  entryPath: string,
  stats: SweepStats,
  now: number,
): Promise<void> {
  // Any stat/read error below on a candidate is treated defensively as
  // "not orphaned" — skip it, never remove on an inconclusive read.
  try {
    const clusterDir = await findClusterDir(entryPath);
    if (!clusterDir) return;

    stats.scanned++;

    if (await isLive(clusterDir)) return;

    let entryStat: fs.Stats;
    let clusterStat: fs.Stats;
    try {
      entryStat = await fs.promises.stat(entryPath);
      clusterStat =
        clusterDir === entryPath
          ? entryStat
          : await fs.promises.stat(clusterDir);
    } catch {
      return;
    }
    const mostRecentMtimeMs = Math.max(entryStat.mtimeMs, clusterStat.mtimeMs);
    if (now - mostRecentMtimeMs < ORPHAN_AGE_MS) return;

    try {
      await fs.promises.rm(entryPath, { recursive: true, force: true });
      stats.removed++;
      logger.info(
        `[TempClusterReconciler] removed orphaned Postgres data dir ${entryPath}`,
      );
    } catch (err) {
      stats.failed++;
      logger.error(
        `[TempClusterReconciler] failed to remove orphaned Postgres data dir ${entryPath}: ${err}`,
      );
    }
  } catch {
    // fall through — treated as skip
  }
}

async function reconcileBaseDir(baseDir: string): Promise<SweepStats> {
  const stats: SweepStats = { scanned: 0, removed: 0, failed: 0, skipped: 0 };

  // withFileTypes lets us discard non-directory entries using the same
  // syscall as the listing itself, avoiding a stat() per entry across a
  // /tmp that can hold tens of thousands of unrelated files.
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
  } catch {
    return stats;
  }

  const now = Date.now();

  const candidatePaths: string[] = [];
  for (const dirent of entries) {
    if (!dirent.isDirectory() || !TEMP_CLUSTER_ENTRY_RE.test(dirent.name)) {
      stats.skipped++;
      continue;
    }
    candidatePaths.push(path.join(baseDir, dirent.name));
  }

  await runWithConcurrency(
    candidatePaths,
    FIND_CLUSTER_CONCURRENCY,
    (entryPath) => reconcileEntry(entryPath, stats, now),
  );

  return stats;
}

export async function runBootTempClusterReconciliation(options?: {
  baseDir?: string;
}): Promise<void> {
  const baseDir = options?.baseDir ?? os.tmpdir();
  const stats = await reconcileBaseDir(baseDir);
  if (stats.removed > 0 || stats.failed > 0) {
    logger.info(
      `[TempClusterReconciler] sweep complete — scanned: ${stats.scanned}, removed: ${stats.removed}, failed: ${stats.failed}, skipped: ${stats.skipped}`,
    );
  }
}

export function register(scheduler: Scheduler): void {
  scheduler.register({
    name: 'temp_cluster_reconciler',
    intervalMs: MAINTENANCE_INTERVAL_MS,
    runOnBoot: true,
    concurrency: 'skip-if-running',
    run: async () => {
      const stats = await reconcileBaseDir(os.tmpdir());
      if (stats.removed > 0 || stats.failed > 0) {
        logger.info(
          `[TempClusterReconciler] sweep complete — scanned: ${stats.scanned}, removed: ${stats.removed}, failed: ${stats.failed}, skipped: ${stats.skipped}`,
        );
      }
    },
  });
}
