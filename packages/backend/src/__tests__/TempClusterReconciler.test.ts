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
import {
  runBootTempClusterReconciliation,
  reconcileBaseDir,
  register,
} from '../orchestration/TempClusterReconciler.js';

const mockedLoggerInfo = vi.mocked(logger.info);

const mockedReaddir = vi.mocked(fs.promises.readdir);
const mockedStat = vi.mocked(fs.promises.stat);
const mockedAccess = vi.mocked(fs.promises.access);
const mockedReadFile = vi.mocked(fs.promises.readFile);
const mockedRm = vi.mocked(fs.promises.rm);

const BASE_DIR = '/fake/tmp';
const ORPHAN_AGE_MS = 2 * 60 * 60_000;
const GENERIC_ORPHAN_AGE_MS = 6 * 60 * 60_000;

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
const OLD_GENERIC_MTIME = Date.now() - GENERIC_ORPHAN_AGE_MS - 60_000;
const FRESH_GENERIC_MTIME = Date.now() - GENERIC_ORPHAN_AGE_MS + 60_000;

let livePid: number;

beforeEach(() => {
  vi.clearAllMocks();
  mockedReaddir.mockResolvedValue(
    [] as unknown as ReturnType<typeof fs.readdirSync>,
  );
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
      entryName: 'tmppgclusterdatashape',
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
      entryName: 'tmppgclustertopshape',
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
      entryName: 'tmppgclusterlive',
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
      entryName: 'tmppgclusterfresh',
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
      entryName: 'tmppgclustermixedmtime',
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
      entryName: 'tmppgcluster4',
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
      entryName: 'tmpunrelateddir',
      pgVersionAt: 'none',
      postmasterPidContents: undefined,
      entryMtimeMs: OLD_MTIME,
    });

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('treats a stat error on a candidate as skip, not remove', async () => {
    mockedReaddir.mockResolvedValue([
      makeDirent('tmppgcluster5'),
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    mockedAccess.mockImplementation(async (p: unknown) => {
      if (String(p) === `${BASE_DIR}/tmppgcluster5/PG_VERSION`)
        return undefined;
      throw new Error('ENOENT');
    });
    mockedStat.mockRejectedValue(new Error('EACCES'));

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('counts scanned/removed across multiple orphaned clusters at both depths and skips non-directory entries without descending into them', async () => {
    const clusters: EntryFixture[] = [
      {
        entryName: 'tmporphantop1',
        pgVersionAt: 'top',
        postmasterPidContents: undefined,
        entryMtimeMs: OLD_MTIME,
      },
      {
        entryName: 'tmporphantop2',
        pgVersionAt: 'top',
        postmasterPidContents: undefined,
        entryMtimeMs: OLD_MTIME,
      },
      {
        entryName: 'tmporphandata1',
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
      expect(mockedStat).not.toHaveBeenCalledWith(`${BASE_DIR}/${f.name}`);
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

  it('prefilters by the tmp* name shape: only the single tmp* candidate among 1000 unrelated dirs is access-ed for a Postgres cluster; the rest route to the generic sweep instead', async () => {
    const clusterName = 'tmpabc12345';
    const entryPath = `${BASE_DIR}/${clusterName}`;
    const clusterDir = `${entryPath}/data`;

    const unrelatedDirents = Array.from({ length: 1000 }, (_, i) =>
      makeDirent(`orchestrator-run-${i}-XXXXXX`),
    );

    mockedReaddir.mockResolvedValue([
      ...unrelatedDirents,
      makeDirent(clusterName),
    ] as unknown as ReturnType<typeof fs.readdirSync>);

    mockedAccess.mockImplementation(async (p: unknown) => {
      if (String(p) === `${clusterDir}/PG_VERSION`) return undefined;
      throw new Error('ENOENT');
    });

    mockedStat.mockImplementation(async (p: unknown) => {
      const target = String(p);
      if (target === entryPath || target === clusterDir) {
        return makeStat(OLD_MTIME);
      }
      if (target.startsWith(`${BASE_DIR}/orchestrator-run-`)) {
        return makeStat(FRESH_GENERIC_MTIME);
      }
      throw new Error('ENOENT');
    });

    mockedReadFile.mockRejectedValue(new Error('ENOENT'));

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedAccess).toHaveBeenCalledTimes(2);
    expect(mockedRm).toHaveBeenCalledWith(
      entryPath,
      expect.objectContaining({ recursive: true, force: true }),
    );
    expect(mockedLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('postgres scanned: 1, removed: 1'),
    );
    expect(mockedLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('generic scanned: 1000, removed: 0'),
    );
  });

  it('recognises and removes both the tmpXXXXXXXX/data/PG_VERSION and tmp.XXXXXXXXXX/PG_VERSION name shapes when not live', async () => {
    const entries: { entryName: string; pgVersionAt: 'top' | 'data' }[] = [
      { entryName: 'tmpabcdefgh', pgVersionAt: 'data' },
      { entryName: 'tmp.abcdefghij', pgVersionAt: 'top' },
    ];

    mockedReaddir.mockResolvedValue(
      entries.map((e) => makeDirent(e.entryName)) as unknown as ReturnType<
        typeof fs.readdirSync
      >,
    );

    mockedAccess.mockImplementation(async (p: unknown) => {
      const target = String(p);
      for (const e of entries) {
        const entryPath = `${BASE_DIR}/${e.entryName}`;
        if (e.pgVersionAt === 'top' && target === `${entryPath}/PG_VERSION`) {
          return undefined;
        }
        if (
          e.pgVersionAt === 'data' &&
          target === `${entryPath}/data/PG_VERSION`
        ) {
          return undefined;
        }
      }
      throw new Error('ENOENT');
    });

    mockedStat.mockImplementation(async (p: unknown) => {
      const target = String(p);
      for (const e of entries) {
        const entryPath = `${BASE_DIR}/${e.entryName}`;
        const clusterDir =
          e.pgVersionAt === 'data' ? `${entryPath}/data` : entryPath;
        if (target === entryPath || target === clusterDir) {
          return makeStat(OLD_MTIME);
        }
      }
      throw new Error('ENOENT');
    });

    mockedReadFile.mockRejectedValue(new Error('ENOENT'));

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    for (const e of entries) {
      expect(mockedRm).toHaveBeenCalledWith(
        `${BASE_DIR}/${e.entryName}`,
        expect.objectContaining({ recursive: true, force: true }),
      );
    }
  });

  it('skips a regular file whose name matches the tmp* shape, without any access call', async () => {
    mockedReaddir.mockResolvedValue([
      makeDirent('tmpfoo12345', false),
    ] as unknown as ReturnType<typeof fs.readdirSync>);

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedAccess).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('bounds findClusterDir concurrency to the configured limit across 50 tmp* candidates', async () => {
    const CONCURRENCY_LIMIT = 8;
    const names = Array.from(
      { length: 50 },
      (_, i) => `tmpcandidate${String(i).padStart(2, '0')}`,
    );
    mockedReaddir.mockResolvedValue(
      names.map((n) => makeDirent(n)) as unknown as ReturnType<
        typeof fs.readdirSync
      >,
    );

    let inFlight = 0;
    let maxInFlight = 0;
    mockedAccess.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => setImmediate(resolve));
      inFlight--;
      throw new Error('ENOENT');
    });

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(maxInFlight).toBeGreaterThan(0);
    expect(maxInFlight).toBeLessThanOrEqual(CONCURRENCY_LIMIT);
  });
});

describe('TempClusterReconciler generic orchestrator-run sweep', () => {
  function setupGenericEntry(name: string, mtimeMs: number) {
    const entryPath = `${BASE_DIR}/${name}`;
    mockedReaddir.mockResolvedValue([makeDirent(name)] as unknown as ReturnType<
      typeof fs.readdirSync
    >);
    // No PG_VERSION at any depth — not a Postgres cluster.
    mockedAccess.mockRejectedValue(new Error('ENOENT'));
    mockedStat.mockImplementation(async (p: unknown) => {
      if (String(p) === entryPath) return makeStat(mtimeMs);
      throw new Error('ENOENT');
    });
    return entryPath;
  }

  it('removes an orchestrator-run-* leak dir older than GENERIC_ORPHAN_AGE_MS', async () => {
    const entryPath = setupGenericEntry(
      'orchestrator-run-abc-XYZ123',
      OLD_GENERIC_MTIME,
    );

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedRm).toHaveBeenCalledWith(
      entryPath,
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it('spares an orchestrator-run-* leak dir within GENERIC_ORPHAN_AGE_MS', async () => {
    setupGenericEntry('orchestrator-run-abc-XYZ123', FRESH_GENERIC_MTIME);

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('never removes an orchestrator-run-* dir within the safety margin even under the old (2h) Postgres age', async () => {
    // A generic dir aged past ORPHAN_AGE_MS but not past GENERIC_ORPHAN_AGE_MS
    // must survive — the Postgres age margin does not apply to it.
    setupGenericEntry('orchestrator-run-flaky-xyz', OLD_MTIME);

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedRm).not.toHaveBeenCalled();
  });

  it.each([
    'systemd-private-abc123-foo.service-xyz',
    '.X11-unix',
    '.ICE-unix',
    '.font-unix',
    'ssh-AbCdEf',
    'snap.some-app',
  ])(
    'never removes the known system entry %s regardless of age',
    async (name) => {
      setupGenericEntry(name, OLD_GENERIC_MTIME);

      await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

      expect(mockedRm).not.toHaveBeenCalled();
      expect(mockedStat).not.toHaveBeenCalledWith(`${BASE_DIR}/${name}`);
    },
  );

  it.each([
    'claude-1000',
    'cc-socks',
    'orchestrator-backup',
    'pytest-of-paulie',
    'snap-private-tmp',
    'node-jiti',
  ])(
    'spares non-leak-shaped entry %s (7 days old) and counts it in skipped, without stat-ing it',
    async (name) => {
      mockedReaddir.mockResolvedValue([
        makeDirent(name),
      ] as unknown as ReturnType<typeof fs.readdirSync>);
      mockedAccess.mockRejectedValue(new Error('ENOENT'));
      mockedStat.mockRejectedValue(new Error('should not be stat-ed'));

      const stats = await reconcileBaseDir(BASE_DIR);

      expect(mockedRm).not.toHaveBeenCalled();
      expect(mockedStat).not.toHaveBeenCalledWith(`${BASE_DIR}/${name}`);
      expect(stats.skipped).toBe(1);
      expect(stats.generic.scanned).toBe(0);
    },
  );

  it('treats a stat error on an orchestrator-run-* candidate as skip, not remove', async () => {
    mockedReaddir.mockResolvedValue([
      makeDirent('orchestrator-run-proj-1-abc'),
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    mockedAccess.mockRejectedValue(new Error('ENOENT'));
    mockedStat.mockRejectedValue(new Error('EACCES'));

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('reports removed/failed counts for the generic category separately from the postgres category', async () => {
    const removableEntry = 'orchestrator-run-route-old-abc';
    const failingEntry = 'orchestrator-run-stub-old-xyz';
    const entries = [removableEntry, failingEntry];

    mockedReaddir.mockResolvedValue(
      entries.map((n) => makeDirent(n)) as unknown as ReturnType<
        typeof fs.readdirSync
      >,
    );
    mockedAccess.mockRejectedValue(new Error('ENOENT'));
    mockedStat.mockImplementation(async (p: unknown) => {
      const target = String(p);
      if (target === `${BASE_DIR}/${removableEntry}`) {
        return makeStat(OLD_GENERIC_MTIME);
      }
      if (target === `${BASE_DIR}/${failingEntry}`) {
        return makeStat(OLD_GENERIC_MTIME);
      }
      throw new Error('ENOENT');
    });
    mockedRm.mockImplementation(async (p: unknown) => {
      if (String(p) === `${BASE_DIR}/${failingEntry}`) {
        throw new Error('EBUSY');
      }
      return undefined;
    });

    await runBootTempClusterReconciliation({ baseDir: BASE_DIR });

    expect(mockedLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('generic scanned: 2, removed: 1, failed: 1'),
    );
  });
});

describe('TempClusterReconciler items_processed reporting', () => {
  it('runBootTempClusterReconciliation resolves items_processed = number of dirs removed', async () => {
    const removable1 = 'orchestrator-run-aaa-111';
    const removable2 = 'orchestrator-run-bbb-222';
    mockedReaddir.mockResolvedValue(
      [removable1, removable2].map((n) => makeDirent(n)) as unknown as ReturnType<
        typeof fs.readdirSync
      >,
    );
    mockedAccess.mockRejectedValue(new Error('ENOENT'));
    mockedStat.mockResolvedValue(makeStat(OLD_GENERIC_MTIME));

    const result = await runBootTempClusterReconciliation({
      baseDir: BASE_DIR,
    });

    expect(result).toEqual({ items_processed: 2 });
  });

  it('runBootTempClusterReconciliation resolves items_processed = 0 when nothing is removed', async () => {
    mockedReaddir.mockResolvedValue([
      makeDirent('claude-1000'),
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    mockedAccess.mockRejectedValue(new Error('ENOENT'));

    const result = await runBootTempClusterReconciliation({
      baseDir: BASE_DIR,
    });

    expect(result).toEqual({ items_processed: 0 });
  });

  it("registered job's run() resolves to { items_processed } matching dirs removed", async () => {
    const removable1 = 'orchestrator-run-ccc-333';
    const removable2 = 'orchestrator-run-ddd-444';
    mockedReaddir.mockResolvedValue(
      [removable1, removable2].map((n) => makeDirent(n)) as unknown as ReturnType<
        typeof fs.readdirSync
      >,
    );
    mockedAccess.mockRejectedValue(new Error('ENOENT'));
    mockedStat.mockResolvedValue(makeStat(OLD_GENERIC_MTIME));

    const registerCall = vi.fn();
    const scheduler = { register: registerCall } as unknown as {
      register: (opts: {
        run: () => Promise<{ items_processed?: number } | void>;
      }) => void;
    };

    register(scheduler as never);

    expect(registerCall).toHaveBeenCalledOnce();
    const opts = registerCall.mock.calls[0][0] as {
      run: () => Promise<{ items_processed?: number } | void>;
    };
    const result = await opts.run();

    expect(result).toEqual({ items_processed: 2 });
  });
});
