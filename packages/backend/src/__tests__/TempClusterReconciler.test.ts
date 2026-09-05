import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      promises: {
        ...actual.promises,
        readdir: vi.fn().mockResolvedValue([]),
        stat: vi.fn(),
        access: vi.fn(),
        readFile: vi.fn(),
        rm: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
});

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import fs from 'node:fs';
import { logger } from '../logger.js';
import { runBootTempClusterReconciliation } from '../orchestration/TempClusterReconciler.js';

const mockedLoggerInfo = vi.mocked(logger.info);

const mockedReaddir = vi.mocked(fs.promises.readdir);
const mockedStat = vi.mocked(fs.promises.stat);
const mockedAccess = vi.mocked(fs.promises.access);
const mockedReadFile = vi.mocked(fs.promises.readFile);
const mockedRm = vi.mocked(fs.promises.rm);

const BASE_DIR = '/fake/tmp';
const ORPHAN_AGE_MS = 2 * 60 * 60_000;

function makeDirent(name: string, isDirectory = true) {
  return {
    name,
    isDirectory: () => isDirectory,
  } as unknown as import('node:fs').Dirent;
}

function makeStat(mtimeMs: number) {
  return { mtimeMs } as unknown as import('node:fs').Stats;
}

const OLD_MTIME = Date.now() - ORPHAN_AGE_MS - 60_000;
const FRESH_MTIME = Date.now() - 60_000;

let livePid: number;

beforeEach(() => {
  vi.clearAllMocks();
  mockedReaddir.mockResolvedValue([] as unknown as ReturnType<
    typeof fs.readdirSync
  >);
  // A pid that is virtually guaranteed to be alive during the test run.
  livePid = process.pid;
});

interface EntryFixture {
  entryName: string;
  // Where PG_VERSION lives relative to the entry: 'top' for <entry>/PG_VERSION,
  // 'data' for <entry>/data/PG_VERSION, or 'none' for no cluster at all.
  pgVersionAt: 'top' | 'data' | 'none';
  postmasterPidContents?: string | Error;
  entryMtimeMs: number;
  clusterMtimeMs?: number;
}

function setupSingleEntry(opts: EntryFixture) {
  const clusterDir =
    opts.pgVersionAt === 'data'
      ? `${BASE_DIR}/${opts.entryName}/data`
      : `${BASE_DIR}/${opts.entryName}`;
  const entryPath = `${BASE_DIR}/${opts.entryName}`;
  const clusterMtimeMs = opts.clusterMtimeMs ?? opts.entryMtimeMs;

  mockedReaddir.mockResolvedValue([
    makeDirent(opts.entryName),
  ] as unknown as ReturnType<typeof fs.readdirSync>);

  mockedAccess.mockImplementation(async (p: unknown) => {
    const target = String(p);
    if (opts.pgVersionAt === 'top' && target === `${entryPath}/PG_VERSION`) {
      return undefined;
    }
    if (
      opts.pgVersionAt === 'data' &&
      target === `${entryPath}/data/PG_VERSION`
    ) {
      return undefined;
    }
    throw new Error('ENOENT');
  });

  mockedStat.mockImplementation(async (p: unknown) => {
    const target = String(p);
    if (target === entryPath) return makeStat(opts.entryMtimeMs);
    if (target === clusterDir) return makeStat(clusterMtimeMs);
    throw new Error('ENOENT');
  });

  mockedReadFile.mockImplementation(async (p: unknown) => {
    if (String(p) === `${clusterDir}/postmaster.pid`) {
      if (opts.postmasterPidContents instanceof Error) {
        throw opts.postmasterPidContents;
      }
      if (opts.postmasterPidContents !== undefined) {
        return opts.postmasterPidContents;
      }
      throw new Error('ENOENT');
    }
    throw new Error('ENOENT');
  });

  return { entryPath, clusterDir };
}

describe('TempClusterReconciler', () => {
  it('removes an entry whose cluster sits at <entry>/data/PG_VERSION (testing.postgresql shape) with a stale pid and old mtime', async () => {
    const { entryPath } = setupSingleEntry({
      entryName: 'pg-cluster-data-shape',
      pgVersionAt: 'data',
      postmasterPidContents: undefined,
      entryMtimeMs: OLD_MTIME,
    });

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedRm).toHaveBeenCalledWith(
      entryPath,
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it('removes an entry whose cluster sits directly at <entry>/PG_VERSION (legacy shape) — no regression', async () => {
    const { entryPath } = setupSingleEntry({
      entryName: 'pg-cluster-top-shape',
      pgVersionAt: 'top',
      postmasterPidContents: undefined,
      entryMtimeMs: OLD_MTIME,
    });

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedRm).toHaveBeenCalledWith(
      entryPath,
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it('skips a data/-shaped cluster whose postmaster.pid names a live pid', async () => {
    setupSingleEntry({
      entryName: 'pg-cluster-live',
      pgVersionAt: 'data',
      postmasterPidContents: `${livePid}\n`,
      entryMtimeMs: OLD_MTIME,
    });

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('skips a data/-shaped cluster with a dead pid but mtime inside the safety margin', async () => {
    const deadPid = 999999;
    setupSingleEntry({
      entryName: 'pg-cluster-fresh',
      pgVersionAt: 'data',
      postmasterPidContents: `${deadPid}\n`,
      entryMtimeMs: FRESH_MTIME,
      clusterMtimeMs: FRESH_MTIME,
    });

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('spares a data/-shaped cluster whose wrapper mtime is fresh even if the cluster dir mtime is old', async () => {
    const deadPid = 999999;
    setupSingleEntry({
      entryName: 'pg-cluster-mixed-mtime',
      pgVersionAt: 'data',
      postmasterPidContents: `${deadPid}\n`,
      entryMtimeMs: FRESH_MTIME,
      clusterMtimeMs: OLD_MTIME,
    });

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('removes a dir with a dead pid and old mtime (legacy top shape)', async () => {
    const deadPid = 999999;
    const { entryPath } = setupSingleEntry({
      entryName: 'pg-cluster-4',
      pgVersionAt: 'top',
      postmasterPidContents: `${deadPid}\n`,
      entryMtimeMs: OLD_MTIME,
    });

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedRm).toHaveBeenCalledWith(
      entryPath,
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it('never touches a dir with no PG_VERSION at either depth regardless of age/pid state', async () => {
    setupSingleEntry({
      entryName: 'unrelated-tmp-dir',
      pgVersionAt: 'none',
      postmasterPidContents: undefined,
      entryMtimeMs: OLD_MTIME,
    });

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('treats a stat error on a candidate as skip, not remove', async () => {
    mockedReaddir.mockResolvedValue([
      makeDirent('pg-cluster-5'),
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    mockedAccess.mockImplementation(async (p: unknown) => {
      if (String(p) === `${BASE_DIR}/pg-cluster-5/PG_VERSION`) return undefined;
      throw new Error('ENOENT');
    });
    mockedStat.mockRejectedValue(new Error('EACCES'));

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('counts scanned/removed across multiple orphaned clusters at both depths and skips non-directory entries without descending into them', async () => {
    const clusters: EntryFixture[] = [
      {
        entryName: 'orphan-top-1',
        pgVersionAt: 'top',
        postmasterPidContents: undefined,
        entryMtimeMs: OLD_MTIME,
      },
      {
        entryName: 'orphan-top-2',
        pgVersionAt: 'top',
        postmasterPidContents: undefined,
        entryMtimeMs: OLD_MTIME,
      },
      {
        entryName: 'orphan-data-1',
        pgVersionAt: 'data',
        postmasterPidContents: undefined,
        entryMtimeMs: OLD_MTIME,
      },
    ];

    const direntsForClusters = clusters.map((c) => makeDirent(c.entryName));
    const nonCandidateFiles = Array.from({ length: 50 }, (_, i) =>
      makeDirent(`some-file-${i}`, false),
    );

    mockedReaddir.mockResolvedValue([
      ...direntsForClusters,
      ...nonCandidateFiles,
    ] as unknown as ReturnType<typeof fs.readdirSync>);

    mockedAccess.mockImplementation(async (p: unknown) => {
      const target = String(p);
      for (const c of clusters) {
        const entryPath = `${BASE_DIR}/${c.entryName}`;
        if (c.pgVersionAt === 'top' && target === `${entryPath}/PG_VERSION`) {
          return undefined;
        }
        if (
          c.pgVersionAt === 'data' &&
          target === `${entryPath}/data/PG_VERSION`
        ) {
          return undefined;
        }
      }
      throw new Error('ENOENT');
    });

    mockedStat.mockImplementation(async (p: unknown) => {
      const target = String(p);
      for (const c of clusters) {
        const entryPath = `${BASE_DIR}/${c.entryName}`;
        const clusterDir =
          c.pgVersionAt === 'data' ? `${entryPath}/data` : entryPath;
        if (target === entryPath || target === clusterDir) {
          return makeStat(c.entryMtimeMs);
        }
      }
      throw new Error('ENOENT');
    });

    mockedReadFile.mockRejectedValue(new Error('ENOENT'));

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    // The public API returns void; the sweep summary log carries the
    // scanned/removed counts, so assert scanned = removed = N through it.
    expect(mockedLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining(
        `scanned: ${clusters.length}, removed: ${clusters.length}`,
      ),
    );
    expect(mockedRm).toHaveBeenCalledTimes(clusters.length);
    for (const c of clusters) {
      expect(mockedRm).toHaveBeenCalledWith(
        `${BASE_DIR}/${c.entryName}`,
        expect.objectContaining({ recursive: true, force: true }),
      );
    }
    for (const f of nonCandidateFiles) {
      expect(mockedStat).not.toHaveBeenCalledWith(
        `${BASE_DIR}/${f.name}`,
      );
      expect(mockedAccess).not.toHaveBeenCalledWith(
        expect.stringContaining(f.name),
      );
    }
  });

  it('reports scanned = 0, removed = 0 for a base dir with only non-cluster entries', async () => {
    const nonCandidateFiles = Array.from({ length: 100 }, (_, i) =>
      makeDirent(`file-${i}`, false),
    );
    mockedReaddir.mockResolvedValue(
      nonCandidateFiles as unknown as ReturnType<typeof fs.readdirSync>,
    );

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedStat).not.toHaveBeenCalled();
    expect(mockedAccess).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
  });
});
