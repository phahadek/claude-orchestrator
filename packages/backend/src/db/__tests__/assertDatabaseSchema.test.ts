import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { assertDatabaseSchema } from '../assertDatabaseSchema.js';

describe('assertDatabaseSchema', () => {
  it('does nothing when the file did not exist before open (genuine first run)', () => {
    const db = new Database(':memory:');
    expect(() =>
      assertDatabaseSchema(db, '/some/fresh/dashboard.db', false),
    ).not.toThrow();
  });

  describe('legacy-candidate probing (fileExistedBeforeOpen === false)', () => {
    let tmpDir: string;

    afterEach(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function makeTmpDir(): string {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-db-schema-'));
      return tmpDir;
    }

    it('throws, naming both paths, when a legacy candidate is populated', () => {
      const dir = makeTmpDir();
      const legacyPath = path.join(dir, 'legacy-dashboard.db');
      const legacyDb = new Database(legacyPath);
      legacyDb.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`);
      legacyDb.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY)`);
      legacyDb.prepare(`INSERT INTO sessions (session_id) VALUES ('s1')`).run();
      legacyDb.close();

      const newPath = path.join(dir, 'dashboard.db');
      const db = new Database(':memory:');
      expect(() =>
        assertDatabaseSchema(db, newPath, false, [legacyPath]),
      ).toThrowError(
        new RegExp(
          `${newPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*${legacyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
          's',
        ),
      );
    });

    it('does not throw when the legacy candidate is empty (present but not populated)', () => {
      const dir = makeTmpDir();
      const legacyPath = path.join(dir, 'legacy-dashboard.db');
      const legacyDb = new Database(legacyPath);
      legacyDb.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`);
      legacyDb.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY)`);
      legacyDb.close();

      const newPath = path.join(dir, 'dashboard.db');
      const db = new Database(':memory:');
      expect(() =>
        assertDatabaseSchema(db, newPath, false, [legacyPath]),
      ).not.toThrow();
    });

    it('does not throw when no legacy candidate exists on disk', () => {
      const dir = makeTmpDir();
      const legacyPath = path.join(dir, 'never-created.db');
      const newPath = path.join(dir, 'dashboard.db');
      const db = new Database(':memory:');
      expect(() =>
        assertDatabaseSchema(db, newPath, false, [legacyPath]),
      ).not.toThrow();
    });
  });

  it('throws when a pre-existing file has no settings table (not a first run)', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY)`);
    expect(() =>
      assertDatabaseSchema(db, '/srv/orchestrator/dashboard.db', true),
    ).toThrow(/no application schema/);
  });

  it('does not throw when a pre-existing file already has the settings table', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`);
    expect(() =>
      assertDatabaseSchema(db, '/srv/orchestrator/dashboard.db', true),
    ).not.toThrow();
  });
});
