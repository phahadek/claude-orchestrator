import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  applyPerformancePragmas,
  DB_CACHE_SIZE_PRAGMA_KB,
  DB_MMAP_SIZE_BYTES,
} from '../db.js';

describe('applyPerformancePragmas', () => {
  it('sets cache_size to the chosen 256 MB value', () => {
    const db = new Database(':memory:');
    applyPerformancePragmas(db, ':memory:');
    expect(DB_CACHE_SIZE_PRAGMA_KB).toBe(-262144);
    const actual = (db.pragma('cache_size') as { cache_size: number }[])[0]
      ?.cache_size;
    expect(actual).toBe(DB_CACHE_SIZE_PRAGMA_KB);
  });

  it('sets mmap_size to the chosen 1 GB value on a file-backed connection', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-pragma-test-'));
    const file = path.join(dir, 'test.db');
    const db = new Database(file);
    try {
      applyPerformancePragmas(db, file);
      expect(DB_MMAP_SIZE_BYTES).toBe(1073741824);
      const actual = (db.pragma('mmap_size') as { mmap_size: number }[])[0]
        ?.mmap_size;
      expect(actual).toBe(DB_MMAP_SIZE_BYTES);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws if cache_size does not take effect (regression guard)', () => {
    const db = new Database(':memory:');
    // Simulate a driver/config that silently ignores the pragma by asserting
    // against a value it will never report.
    const original = db.pragma.bind(db);
    let callCount = 0;
    db.pragma = ((sql: string, opts?: unknown) => {
      callCount++;
      if (callCount === 2) {
        return [{ cache_size: -16000 }];
      }
      return original(sql as string, opts as never);
    }) as typeof db.pragma;
    expect(() => applyPerformancePragmas(db, ':memory:')).toThrow(
      /cache_size pragma did not apply/,
    );
  });
});

describe('performance pragma constants', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('covers a meaningful working set relative to a large production db', () => {
    // Documents the sizing decision from grooming: cache ~256 MB, mmap ~1 GB
    // against a ~4.4 GB production database.
    expect(Math.abs(DB_CACHE_SIZE_PRAGMA_KB) * 1024).toBe(256 * 1024 * 1024);
    expect(DB_MMAP_SIZE_BYTES).toBe(1024 * 1024 * 1024);
  });
});
