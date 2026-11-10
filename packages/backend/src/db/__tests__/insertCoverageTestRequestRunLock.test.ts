import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import { Worker } from 'worker_threads';

vi.mock('../db', async () => {
  const Database = (await import('better-sqlite3')).default;
  const { runMigrations } = await import('../schema.js');
  const dir = (await import('fs')).mkdtempSync(
    (await import('path')).join(
      (await import('os')).tmpdir(),
      'coverage-lock-',
    ),
  );
  const file = (await import('path')).join(dir, 'test.db');
  const conn = new Database(file);
  conn.pragma('journal_mode = WAL');
  conn.pragma('busy_timeout = 10000');
  runMigrations(conn);
  return { db: conn };
});

import { db } from '../db';
import {
  insertTestRequestRun,
  completeTestRequestRun,
  getTestRequestRunById,
  insertCoverageTestRequestRun,
} from '../queries';

describe('insertCoverageTestRequestRun write-lock handling', () => {
  it('waits out a second connection holding the write lock for >4.25s instead of failing', async () => {
    insertTestRequestRun('src-1', 'proj-l', 'hash-l', null, Date.now());
    completeTestRequestRun('src-1', 'passed', 'ok');
    const source = getTestRequestRunById('src-1')!;

    const dbFile = (db as unknown as { name: string }).name;
    const holder = new Worker(
      `
      const Database = require('better-sqlite3');
      const { parentPort, workerData } = require('worker_threads');
      const c = new Database(workerData.file);
      c.pragma('busy_timeout = 10000');
      c.exec('BEGIN IMMEDIATE');
      parentPort.postMessage('locked');
      setTimeout(() => { c.exec('COMMIT'); c.close(); }, 4500);
      `,
      { eval: true, workerData: { file: dbFile } },
    );
    await new Promise<void>((resolve, reject) => {
      holder.once('message', () => resolve());
      holder.once('error', reject);
    });

    const started = Date.now();
    expect(() =>
      insertCoverageTestRequestRun(
        'cov-1',
        'proj-l',
        'hash-l',
        null,
        'full',
        null,
        null,
        null,
        null,
        ['npm test'],
        Date.now(),
        source,
      ),
    ).not.toThrow();
    expect(Date.now() - started).toBeGreaterThanOrEqual(4000);
    expect(getTestRequestRunById('cov-1')).toBeTruthy();
    await holder.terminate();
    fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
  }, 20000);
});
