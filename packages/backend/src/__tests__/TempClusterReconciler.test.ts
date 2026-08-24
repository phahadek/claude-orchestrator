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
import { runBootTempClusterReconciliation } from '../orchestration/TempClusterReconciler.js';

const mockedReaddir = vi.mocked(fs.promises.readdir);
const mockedStat = vi.mocked(fs.promises.stat);
const mockedAccess = vi.mocked(fs.promises.access);
const mockedReadFile = vi.mocked(fs.promises.readFile);
const mockedRm = vi.mocked(fs.promises.rm);

const BASE_DIR = '/fake/tmp';
const ORPHAN_AGE_MS = 2 * 60 * 60_000;

function makeStat(mtimeMs: number, isDirectory = true) {
  return {
    isDirectory: () => isDirectory,
    mtimeMs,
  } as unknown as import('node:fs').Stats;
}

const OLD_MTIME = Date.now() - ORPHAN_AGE_MS - 60_000;
const FRESH_MTIME = Date.now() - 60_000;

let livePid: number;

beforeEach(() => {
  vi.clearAllMocks();
  mockedReaddir.mockResolvedValue([] as unknown as string[]);
  // A pid that is virtually guaranteed to be alive during the test run.
  livePid = process.pid;
});

function setupSingleEntry(opts: {
  entryName: string;
  hasPgVersion: boolean;
  postmasterPidContents?: string | Error;
  mtimeMs: number;
}) {
  mockedReaddir.mockResolvedValue([opts.entryName] as unknown as string[]);
  mockedStat.mockImplementation(async () => makeStat(opts.mtimeMs));
  mockedAccess.mockImplementation(async (p: unknown) => {
    if (String(p).endsWith('PG_VERSION')) {
      if (opts.hasPgVersion) return undefined;
      throw new Error('ENOENT');
    }
    throw new Error('ENOENT');
  });
  mockedReadFile.mockImplementation(async (p: unknown) => {
    if (String(p).endsWith('postmaster.pid')) {
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
}

describe('TempClusterReconciler', () => {
  it('removes a dir with PG_VERSION, no postmaster.pid, and mtime older than ORPHAN_AGE_MS', async () => {
    setupSingleEntry({
      entryName: 'pg-cluster-1',
      hasPgVersion: true,
      postmasterPidContents: undefined,
      mtimeMs: OLD_MTIME,
    });

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedRm).toHaveBeenCalledWith(
      `${BASE_DIR}/pg-cluster-1`,
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it('skips a dir with postmaster.pid naming a live pid', async () => {
    setupSingleEntry({
      entryName: 'pg-cluster-2',
      hasPgVersion: true,
      postmasterPidContents: `${livePid}\n`,
      mtimeMs: OLD_MTIME,
    });

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('skips a dir with a dead pid but mtime inside the safety margin', async () => {
    // A pid extremely unlikely to be alive.
    const deadPid = 999999;
    setupSingleEntry({
      entryName: 'pg-cluster-3',
      hasPgVersion: true,
      postmasterPidContents: `${deadPid}\n`,
      mtimeMs: FRESH_MTIME,
    });

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('removes a dir with a dead pid and old mtime', async () => {
    const deadPid = 999999;
    setupSingleEntry({
      entryName: 'pg-cluster-4',
      hasPgVersion: true,
      postmasterPidContents: `${deadPid}\n`,
      mtimeMs: OLD_MTIME,
    });

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedRm).toHaveBeenCalledWith(
      `${BASE_DIR}/pg-cluster-4`,
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it('never touches a dir with no PG_VERSION regardless of age/pid state', async () => {
    setupSingleEntry({
      entryName: 'unrelated-tmp-dir',
      hasPgVersion: false,
      postmasterPidContents: undefined,
      mtimeMs: OLD_MTIME,
    });

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('treats a stat error on a candidate as skip, not remove', async () => {
    mockedReaddir.mockResolvedValue(['pg-cluster-5'] as unknown as string[]);
    mockedStat.mockRejectedValue(new Error('EACCES'));

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedRm).not.toHaveBeenCalled();
  });
});
