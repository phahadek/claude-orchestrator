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
// /tmp/tmpXXXXXXXX; bash mktemp -d produces /tmp/tmp.XXXXXXXXXX. This gates
// only the (multi-syscall) Postgres cluster check — entries that don't match
// still go through the single-stat generic sweep below, since backend test
// mkdtemp dirs (oc-*, co-*, mcp-*, flaky-*, etc.) don't share this shape.
const TEMP_CLUSTER_ENTRY_RE = /^tmp[A-Za-z0-9_.]{6,}$/;

// Every test-lane run gets its own TMPDIR shaped orchestrator-run-<runId>-XXXXXX
// (test-runner.ts:276), removed on settle (test-runner.ts:353-361). A
// killed/timed-out/crashed run leaks exactly that shape and nothing else, with
// no analog to postmaster.pid to prove liveness. Age is the only safety net
// here, so the margin is set well beyond the default test_timeout_sec (300s,
// orchestrator-config.ts) plus GRACE_PERIOD_MS (test-runner.ts) — and beyond
// any realistic per-project override — rather than reusing the
// Postgres-specific ORPHAN_AGE_MS.
const GENERIC_ORPHAN_AGE_MS = 6 * 60 * 60_000; // 6h

// The one leak shape the test lane can still produce — see test-runner.ts:276.
// Only entries matching this allow-list reach the generic age-based sweep;
// everything else in /tmp belongs to something other than the test lane.
const GENERIC_LEAK_PATTERNS: RegExp[] = [/^orchestrator-run-/];

// Bounds fs.access/stat concurrency across all candidates (Postgres-shaped
// or generic) so a polluted /tmp with tens of thousands of entries can't
// saturate the threadpool.
const FIND_CLUSTER_CONCURRENCY = 8;

// Top-level /tmp entries created by the OS/other services, not by backend
// test mkdtemp calls. No structural marker (like PG_VERSION) distinguishes
// these from a leaked test dir by inspection, so they're excluded by name
// up front — the cost of over-excluding a few prefixes is negligible next
// to the cost of a false-positive removal on a production host.
const SYSTEM_ENTRY_PATTERNS: RegExp[] = [
  /^systemd-private-/,
  /^\.X11-unix$/,
  /^\.ICE-unix$/,
  /^\.font-unix$/,
  /^\.Test-unix$/,
  /^ssh-/,
  /^snap\./,
  /^\.XIM-unix$/,
];

function isSystemEntry(name: string): boolean {
  return SYSTEM_ENTRY_PATTERNS.some((pattern) => pattern.test(name));
}

interface CategoryStats {
  scanned: number;
  removed: number;
  failed: number;
}

interface CombinedSweepStats {
  postgres: CategoryStats;
  generic: CategoryStats;
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
  name: string,
  stats: CombinedSweepStats,
  now: number,
): Promise<void> {
  // Any stat/read error below on a candidate is treated defensively as
  // "not orphaned" — skip it, never remove on an inconclusive read.
  try {
    if (TEMP_CLUSTER_ENTRY_RE.test(name)) {
      const clusterDir = await findClusterDir(entryPath);
      if (clusterDir) {
        stats.postgres.scanned++;

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
        const mostRecentMtimeMs = Math.max(
          entryStat.mtimeMs,
          clusterStat.mtimeMs,
        );
        if (now - mostRecentMtimeMs < ORPHAN_AGE_MS) return;

        try {
          await fs.promises.rm(entryPath, { recursive: true, force: true });
          stats.postgres.removed++;
          logger.info(
            `[TempClusterReconciler] removed orphaned Postgres data dir ${entryPath}`,
          );
        } catch (err) {
          stats.postgres.failed++;
          logger.error(
            `[TempClusterReconciler] failed to remove orphaned Postgres data dir ${entryPath}: ${err}`,
          );
        }
        return;
      }
    }

    // Not a live Postgres cluster dir — either the name doesn't have the
    // tmp*/tmp.* shape testing.postgresql/mktemp produce, or it does but no
    // PG_VERSION was found at either depth. Fall back to the generic
    // per-run-TMPDIR leak check.
    if (isSystemEntry(name)) {
      stats.skipped++;
      return;
    }

    if (!GENERIC_LEAK_PATTERNS.some((pattern) => pattern.test(name))) {
      stats.skipped++;
      return;
    }

    stats.generic.scanned++;

    let entryStat: fs.Stats;
    try {
      entryStat = await fs.promises.stat(entryPath);
    } catch {
      return;
    }
    if (now - entryStat.mtimeMs < GENERIC_ORPHAN_AGE_MS) return;

    try {
      await fs.promises.rm(entryPath, { recursive: true, force: true });
      stats.generic.removed++;
      logger.info(
        `[TempClusterReconciler] removed orphaned temp dir ${entryPath}`,
      );
    } catch (err) {
      stats.generic.failed++;
      logger.error(
        `[TempClusterReconciler] failed to remove orphaned temp dir ${entryPath}: ${err}`,
      );
    }
  } catch {
    // fall through — treated as skip
  }
}

export async function reconcileBaseDir(
  baseDir: string,
): Promise<CombinedSweepStats> {
  const stats: CombinedSweepStats = {
    postgres: { scanned: 0, removed: 0, failed: 0 },
    generic: { scanned: 0, removed: 0, failed: 0 },
    skipped: 0,
  };

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

  const candidates: { path: string; name: string }[] = [];
  for (const dirent of entries) {
    if (!dirent.isDirectory()) {
      stats.skipped++;
      continue;
    }
    candidates.push({
      path: path.join(baseDir, dirent.name),
      name: dirent.name,
    });
  }

  await runWithConcurrency(candidates, FIND_CLUSTER_CONCURRENCY, (c) =>
    reconcileEntry(c.path, c.name, stats, now),
  );

  return stats;
}

function logSweepSummary(stats: CombinedSweepStats): void {
  if (
    stats.postgres.removed > 0 ||
    stats.postgres.failed > 0 ||
    stats.generic.removed > 0 ||
    stats.generic.failed > 0
  ) {
    logger.info(
      `[TempClusterReconciler] sweep complete — postgres scanned: ${stats.postgres.scanned}, removed: ${stats.postgres.removed}, failed: ${stats.postgres.failed}; ` +
        `generic scanned: ${stats.generic.scanned}, removed: ${stats.generic.removed}, failed: ${stats.generic.failed}; skipped: ${stats.skipped}`,
    );
  }
}

export async function runBootTempClusterReconciliation(options?: {
  baseDir?: string;
}): Promise<{ items_processed: number }> {
  const baseDir = options?.baseDir ?? os.tmpdir();
  const stats = await reconcileBaseDir(baseDir);
  logSweepSummary(stats);
  return { items_processed: stats.postgres.removed + stats.generic.removed };
}

export function register(scheduler: Scheduler): void {
  scheduler.register({
    name: 'temp_cluster_reconciler',
    intervalMs: MAINTENANCE_INTERVAL_MS,
    runOnBoot: true,
    concurrency: 'skip-if-running',
    run: async () => {
      const stats = await reconcileBaseDir(os.tmpdir());
      logSweepSummary(stats);
      return { items_processed: stats.postgres.removed + stats.generic.removed };
    },
  });
}
