import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { gunzipSync, gzipSync } from 'zlib';
import { hashWorktreeFiles, listWorktreeFiles } from '../session/analyzeGating';

/** Raw (uncompressed) byte cap on a snapshot's regular-file content. */
const MAX_SNAPSHOT_RAW_BYTES = 100 * 1024 * 1024;

type SnapshotEntry =
  | { path: string; type: 'file'; mode: number; size: number }
  | { path: string; type: 'symlink'; mode: number; size: 0; target: string }
  // Tracked-but-deleted/unreadable: contributes the MISSING marker to the hash.
  | { path: string; type: 'missing'; mode: 0; size: 0 };

interface SnapshotManifest {
  /** Value of computeWholeTreeContentHash for the packed tree. */
  contentHash: string;
  /** Sorted exactly as computeWholeTreeContentHash sorts. */
  entries: SnapshotEntry[];
  totalBytes: number;
}

export interface TestSnapshot {
  manifest: SnapshotManifest;
  /** gzip of the concatenated file bytes, in manifest order. */
  archive: Buffer;
}

export class SnapshotTooLargeError extends Error {
  constructor(
    readonly totalBytes: number,
    readonly capBytes: number,
    readonly largestUntracked: { path: string; size: number }[],
  ) {
    super(
      `Test snapshot is ${totalBytes} bytes raw, exceeding the ${capBytes}-byte cap. ` +
        (largestUntracked.length
          ? `Largest untracked files: ${largestUntracked
              .map((f) => `${f.path} (${f.size})`)
              .join(', ')}`
          : 'No untracked files contribute; the tracked tree itself is too large.'),
    );
    this.name = 'SnapshotTooLargeError';
  }
}

export class SnapshotHashMismatchError extends Error {
  constructor(
    readonly expectedHash: string,
    readonly actualHash: string,
  ) {
    super(
      `Snapshot content hash mismatch: expected ${expectedHash}, materialized ${actualHash}`,
    );
    this.name = 'SnapshotHashMismatchError';
  }
}

class SnapshotIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotIntegrityError';
  }
}

function listUntrackedFiles(worktreePath: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '--others', '--exclude-standard'],
      { cwd: worktreePath, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => resolve(err ? [] : stdout.split('\n').filter(Boolean)),
    );
  });
}

function statFollowed(full: string): fs.Stats | null {
  try {
    return fs.statSync(full);
  } catch {
    return null;
  }
}

/**
 * Packs the exact file set computeWholeTreeContentHash identifies (tracked +
 * untracked-non-ignored). Fails closed with SnapshotTooLargeError at admission
 * — before any content is read — if the raw size exceeds the cap; never
 * truncates. Returns null for an empty tree (mirrors the hash).
 */
export async function packTestSnapshot(
  worktreePath: string,
  capBytes: number = MAX_SNAPSHOT_RAW_BYTES,
): Promise<TestSnapshot | null> {
  const files = (await listWorktreeFiles(worktreePath)).sort();
  if (files.length === 0) return null;

  const sizes = new Map<string, number>();
  let totalBytes = 0;
  for (const file of files) {
    const st = statFollowed(path.join(worktreePath, file));
    const size = st?.isFile() ? st.size : 0;
    sizes.set(file, size);
    totalBytes += size;
  }
  if (totalBytes > capBytes) {
    const untracked = new Set(await listUntrackedFiles(worktreePath));
    const largest = files
      .filter((f) => untracked.has(f))
      .map((f) => ({ path: f, size: sizes.get(f) ?? 0 }))
      .sort((a, b) => b.size - a.size)
      .slice(0, 5);
    throw new SnapshotTooLargeError(totalBytes, capBytes, largest);
  }

  const entries: SnapshotEntry[] = [];
  const chunks: Buffer[] = [];
  let packedBytes = 0;
  for (const file of files) {
    const full = path.join(worktreePath, file);
    const lst = (() => {
      try {
        return fs.lstatSync(full);
      } catch {
        return null;
      }
    })();
    if (lst?.isSymbolicLink()) {
      entries.push({
        path: file,
        type: 'symlink',
        mode: lst.mode & 0o777,
        size: 0,
        target: fs.readlinkSync(full),
      });
      continue;
    }
    let content: Buffer | null = null;
    if (lst?.isFile()) {
      try {
        content = fs.readFileSync(full);
      } catch {
        content = null;
      }
    }
    if (!lst || content === null) {
      entries.push({ path: file, type: 'missing', mode: 0, size: 0 });
      continue;
    }
    entries.push({
      path: file,
      type: 'file',
      mode: lst.mode & 0o777,
      size: content.length,
    });
    chunks.push(content);
    packedBytes += content.length;
  }
  if (packedBytes > capBytes) {
    throw new SnapshotTooLargeError(packedBytes, capBytes, []);
  }

  return {
    manifest: {
      contentHash: hashWorktreeFiles(worktreePath, files),
      entries,
      totalBytes: packedBytes,
    },
    archive: gzipSync(Buffer.concat(chunks)),
  };
}

function safeRelativePath(root: string, rel: string): string {
  if (!rel || path.isAbsolute(rel) || rel.includes('\0')) {
    throw new SnapshotIntegrityError(`Unsafe snapshot path: ${rel}`);
  }
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) {
    throw new SnapshotIntegrityError(`Snapshot path escapes root: ${rel}`);
  }
  return full;
}

/** Creates parent dirs one component at a time, refusing to traverse a symlink or non-directory. */
function mkdirRealParents(root: string, full: string): void {
  let current = root;
  for (const part of path.relative(root, path.dirname(full)).split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    let st: fs.Stats | null;
    try {
      st = fs.lstatSync(current);
    } catch {
      st = null;
    }
    if (!st) {
      fs.mkdirSync(current);
    } else if (!st.isDirectory()) {
      throw new SnapshotIntegrityError(
        `Snapshot path traverses a non-directory: ${current}`,
      );
    }
  }
}

export interface MaterializedSnapshot {
  dir: string;
  contentHash: string;
}

/**
 * Runner side: materializes the snapshot into a fresh per-run directory under
 * `baseDir` and recomputes the hash with the same hashWorktreeFiles the
 * orchestrator used. On any mismatch or malformed input the directory is
 * removed and an error is thrown — callers must not spawn commands.
 */
export function materializeAndVerifySnapshot(
  snapshot: TestSnapshot,
  expectedHash: string,
  baseDir: string = os.tmpdir(),
  capBytes: number = MAX_SNAPSHOT_RAW_BYTES,
): MaterializedSnapshot {
  const { manifest } = snapshot;
  if (manifest.contentHash !== expectedHash) {
    throw new SnapshotHashMismatchError(expectedHash, manifest.contentHash);
  }
  if (manifest.totalBytes > capBytes) {
    throw new SnapshotTooLargeError(manifest.totalBytes, capBytes, []);
  }

  fs.mkdirSync(baseDir, { recursive: true });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(baseDir, 'test-run-')));
  try {
    const raw = gunzipSync(snapshot.archive, { maxOutputLength: capBytes });
    const seen = new Set<string>();
    for (const entry of manifest.entries) {
      if (seen.has(entry.path)) {
        throw new SnapshotIntegrityError(
          `Duplicate snapshot path: ${entry.path}`,
        );
      }
      seen.add(entry.path);
    }

    // Pass 1 writes only regular files, so no symlink exists yet to write through.
    let offset = 0;
    for (const entry of manifest.entries) {
      if (entry.type !== 'file') continue;
      const full = safeRelativePath(dir, entry.path);
      if (
        !Number.isInteger(entry.size) ||
        entry.size < 0 ||
        !Number.isInteger(entry.mode)
      ) {
        throw new SnapshotIntegrityError(
          `Invalid entry metadata: ${entry.path}`,
        );
      }
      if (offset + entry.size > raw.length) {
        throw new SnapshotIntegrityError('Snapshot archive truncated');
      }
      mkdirRealParents(dir, full);
      // 'wx' refuses to follow or overwrite anything already at the path.
      fs.writeFileSync(full, raw.subarray(offset, offset + entry.size), {
        flag: 'wx',
        mode: entry.mode & 0o777,
      });
      fs.chmodSync(full, entry.mode & 0o777);
      offset += entry.size;
    }
    if (offset !== raw.length) {
      throw new SnapshotIntegrityError('Snapshot archive has trailing bytes');
    }

    for (const entry of manifest.entries) {
      if (entry.type !== 'symlink') continue;
      const full = safeRelativePath(dir, entry.path);
      const resolved = path.resolve(path.dirname(full), entry.target);
      if (
        typeof entry.target !== 'string' ||
        path.isAbsolute(entry.target) ||
        !(resolved + path.sep).startsWith(dir + path.sep)
      ) {
        throw new SnapshotIntegrityError(
          `Symlink escapes snapshot root: ${entry.path} -> ${entry.target}`,
        );
      }
      mkdirRealParents(dir, full);
      fs.symlinkSync(entry.target, full);
    }

    // Lexical checks can't see chained symlinks; verify against the real filesystem.
    for (const entry of manifest.entries) {
      if (entry.type !== 'symlink') continue;
      let real: string;
      try {
        // .native: the JS realpath collapses ".." lexically, which is what the check must not do.
        real = fs.realpathSync.native(path.join(dir, entry.path));
      } catch {
        continue; // dangling or looping: hashes as MISSING, reads nothing
      }
      if (real !== dir && !real.startsWith(dir + path.sep)) {
        throw new SnapshotIntegrityError(
          `Symlink resolves outside snapshot root: ${entry.path}`,
        );
      }
    }

    const actual = hashWorktreeFiles(
      dir,
      manifest.entries.map((e) => e.path),
    );
    if (actual !== expectedHash) {
      throw new SnapshotHashMismatchError(expectedHash, actual);
    }
    return { dir, contentHash: actual };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
