/**
 * Tests for the screenshot storage write path added to reportStore.ts (Add
 * backend-owned screenshot storage for investigation reports task):
 *
 * - getReportImagesDir()'s storage directory is created automatically
 *   (fs.mkdirSync({recursive:true})) on the first write against a fresh
 *   checkout — exercised here via XDG_DATA_HOME pointed at a temp dir, the
 *   same real getDataDir() resolution path production uses (mirrors
 *   logger.test.ts's own approach).
 * - A failed image write never leaves a committed row referencing a missing
 *   file: the file write happens before the DB update, so a write failure
 *   never reaches the update, and a post-write DB failure rolls the file
 *   back.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import {
  insertReport,
  getReport,
  writeReportImage,
  getReportImagesDir,
} from '../reportStore.js';

let tmpParent: string;
let prevXdgDataHome: string | undefined;

beforeEach(() => {
  db.prepare('DELETE FROM investigation_report_dispatch').run();
  db.prepare('DELETE FROM investigation_report').run();
  db.prepare('DELETE FROM audit_log').run();
  tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'report-images-test-'));
  prevXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = tmpParent;
});

afterEach(() => {
  if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = prevXdgDataHome;
  fs.rmSync(tmpParent, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeReport() {
  return insertReport({
    projectId: 'proj-1',
    milestoneId: 'milestone-uuid-1',
    title: 'Something is wrong',
    symptomText: 'Sessions crash on startup',
    createdAt: '2026-08-13T00:00:00Z',
  });
}

describe('writeReportImage', () => {
  it('creates the storage directory on first write against a fresh checkout', () => {
    const report = makeReport();
    const dir = getReportImagesDir();
    expect(fs.existsSync(dir)).toBe(false);

    writeReportImage(
      report.id,
      Buffer.from('fake-png-bytes'),
      '.png',
      '2026-08-13T01:00:00Z',
    );

    expect(fs.existsSync(dir)).toBe(true);
  });

  it('writes the file and records image_path on the row', () => {
    const report = makeReport();
    const updated = writeReportImage(
      report.id,
      Buffer.from('fake-png-bytes'),
      '.png',
      '2026-08-13T01:00:00Z',
    );

    expect(updated.image_path).toBeTruthy();
    expect(fs.existsSync(updated.image_path as string)).toBe(true);
    expect(fs.readFileSync(updated.image_path as string, 'utf8')).toBe(
      'fake-png-bytes',
    );

    const reread = getReport(report.id);
    expect(reread?.image_path).toBe(updated.image_path);
  });

  it('does not leave a committed row referencing a missing file when the write fails', () => {
    const report = makeReport();
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    expect(() =>
      writeReportImage(
        report.id,
        Buffer.from('x'),
        '.png',
        '2026-08-13T01:00:00Z',
      ),
    ).toThrow('ENOSPC');

    writeSpy.mockRestore();

    const reread = getReport(report.id);
    expect(reread?.image_path).toBeNull();
  });

  it('rolls back the written file if the row update fails', () => {
    const report = makeReport();
    const originalPrepare = db.prepare.bind(db);
    const runSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      const stmt = originalPrepare(sql);
      if (sql.includes('UPDATE investigation_report SET image_path')) {
        return {
          ...stmt,
          run: () => {
            throw new Error('simulated DB failure');
          },
        } as unknown as ReturnType<typeof db.prepare>;
      }
      return stmt;
    });

    expect(() =>
      writeReportImage(
        report.id,
        Buffer.from('x'),
        '.png',
        '2026-08-13T01:00:00Z',
      ),
    ).toThrow('simulated DB failure');

    runSpy.mockRestore();

    const dir = getReportImagesDir();
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    expect(files).toHaveLength(0);

    const reread = getReport(report.id);
    expect(reread?.image_path).toBeNull();
  });
});
