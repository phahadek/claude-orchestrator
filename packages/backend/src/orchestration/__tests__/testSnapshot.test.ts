import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { gzipSync } from 'zlib';
import { computeWholeTreeContentHash } from '../../session/analyzeGating';
import {
  packTestSnapshot,
  materializeAndVerifySnapshot,
  SnapshotHashMismatchError,
  SnapshotTooLargeError,
} from '../testSnapshot';

describe('testSnapshot', () => {
  let worktree: string;
  let runBase: string;

  beforeEach(() => {
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-wt-'));
    runBase = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-run-'));
    execSync('git init -q', { cwd: worktree });
    execSync('git config user.email t@example.com', { cwd: worktree });
    execSync('git config user.name t', { cwd: worktree });
    fs.writeFileSync(path.join(worktree, 'a.txt'), 'alpha');
    fs.mkdirSync(path.join(worktree, 'sub'));
    fs.writeFileSync(path.join(worktree, 'sub', 'run.sh'), '#!/bin/sh\n', {
      mode: 0o755,
    });
    execSync('git add a.txt sub/run.sh', { cwd: worktree });
    fs.writeFileSync(path.join(worktree, 'untracked.txt'), 'new');
    fs.symlinkSync('a.txt', path.join(worktree, 'link.txt'));
  });

  afterEach(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(runBase, { recursive: true, force: true });
  });

  it('round-trips and the runner-side hash equals the tree hash', async () => {
    const snap = (await packTestSnapshot(worktree))!;
    const expected = await computeWholeTreeContentHash(worktree);
    expect(snap.manifest.contentHash).toBe(expected);

    const out = materializeAndVerifySnapshot(snap, expected!, runBase);
    expect(fs.readFileSync(path.join(out.dir, 'untracked.txt'), 'utf8')).toBe(
      'new',
    );
    expect(fs.readlinkSync(path.join(out.dir, 'link.txt'))).toBe('a.txt');
    expect(fs.statSync(path.join(out.dir, 'sub', 'run.sh')).mode & 0o777).toBe(
      0o755,
    );
  });

  it('refuses a corrupted transfer and leaves no run directory', async () => {
    const snap = (await packTestSnapshot(worktree))!;
    const expected = (await computeWholeTreeContentHash(worktree))!;
    // Same-size content corruption: archive still decodes, hash must differ.
    const { gunzipSync, gzipSync } = await import('zlib');
    const raw = gunzipSync(snap.archive);
    raw[0] = raw[0] ^ 0xff;
    const corrupted = { ...snap, archive: gzipSync(raw) };

    expect(() =>
      materializeAndVerifySnapshot(corrupted, expected, runBase),
    ).toThrow(SnapshotHashMismatchError);
    expect(fs.readdirSync(runBase)).toEqual([]);
  });

  it('refuses when the manifest hash differs from the expected hash', async () => {
    const snap = (await packTestSnapshot(worktree))!;
    expect(() =>
      materializeAndVerifySnapshot(snap, 'deadbeef', runBase),
    ).toThrow(SnapshotHashMismatchError);
    expect(fs.readdirSync(runBase)).toEqual([]);
  });

  it('refuses a truncated archive', async () => {
    const snap = (await packTestSnapshot(worktree))!;
    const expected = (await computeWholeTreeContentHash(worktree))!;
    const { gunzipSync, gzipSync } = await import('zlib');
    const raw = gunzipSync(snap.archive);
    const truncated = {
      ...snap,
      archive: gzipSync(raw.subarray(0, raw.length - 2)),
    };
    expect(() =>
      materializeAndVerifySnapshot(truncated, expected, runBase),
    ).toThrow();
    expect(fs.readdirSync(runBase)).toEqual([]);
  });

  it('fails closed over the size cap, naming the largest untracked files', async () => {
    fs.writeFileSync(
      path.join(worktree, 'big-untracked.bin'),
      Buffer.alloc(5000),
    );
    fs.writeFileSync(
      path.join(worktree, 'small-untracked.bin'),
      Buffer.alloc(10),
    );
    const err = await packTestSnapshot(worktree, 1000).catch((e) => e);
    expect(err).toBeInstanceOf(SnapshotTooLargeError);
    expect(err.largestUntracked[0].path).toBe('big-untracked.bin');
    expect(err.message).toContain('big-untracked.bin');
  });

  describe('hostile manifests', () => {
    const craft = (
      entries: unknown[],
      content = '',
    ): Parameters<typeof materializeAndVerifySnapshot>[0] =>
      ({
        manifest: {
          contentHash: 'h',
          entries,
          totalBytes: Buffer.byteLength(content),
        },
        archive: gzipSync(Buffer.from(content)),
      }) as never;

    const outsideEmpty = () =>
      expect(fs.existsSync(path.join(runBase, 'x'))).toBe(false);

    it('refuses to write through a chained symlink that escapes only on the real filesystem', () => {
      const snap = craft(
        [
          {
            path: 'sub/s',
            type: 'symlink',
            mode: 0o777,
            size: 0,
            target: '../',
          },
          {
            path: 'sub/t',
            type: 'symlink',
            mode: 0o777,
            size: 0,
            target: 's/../../x',
          },
          { path: 'sub/t/foo', type: 'file', mode: 0o644, size: 3 },
        ],
        'bad',
      );
      expect(() => materializeAndVerifySnapshot(snap, 'h', runBase)).toThrow();
      expect(fs.readdirSync(runBase)).toEqual([]);
      outsideEmpty();
    });

    it('refuses a symlink that resolves outside the root via a chain', () => {
      const snap = craft([
        { path: 'a', type: 'symlink', mode: 0o777, size: 0, target: '.' },
        { path: 'b', type: 'symlink', mode: 0o777, size: 0, target: 'a/..' },
      ]);
      expect(() => materializeAndVerifySnapshot(snap, 'h', runBase)).toThrow(
        /outside snapshot root|escapes/,
      );
      expect(fs.readdirSync(runBase)).toEqual([]);
    });

    it('refuses duplicate paths', () => {
      const snap = craft(
        [
          { path: 'a', type: 'file', mode: 0o644, size: 1 },
          { path: 'a', type: 'file', mode: 0o644, size: 1 },
        ],
        'xx',
      );
      expect(() => materializeAndVerifySnapshot(snap, 'h', runBase)).toThrow(
        /Duplicate/,
      );
    });

    it('masks setuid/setgid/sticky bits from manifest modes', () => {
      const snap = craft(
        [{ path: 'a', type: 'file', mode: 0o7777, size: 1 }],
        'x',
      );
      // Hash will mismatch, but mode handling happens before; assert via a matching hash.
      const expected = createHash('sha256')
        .update('a')
        .update('\0')
        .update('x')
        .update('\0')
        .digest('hex');
      snap.manifest.contentHash = expected;
      const out = materializeAndVerifySnapshot(snap, expected, runBase);
      expect(fs.statSync(path.join(out.dir, 'a')).mode & 0o7000).toBe(0);
    });
  });

  it('returns null for an empty tree', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-empty-'));
    execSync('git init -q', { cwd: empty });
    expect(await packTestSnapshot(empty)).toBeNull();
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
