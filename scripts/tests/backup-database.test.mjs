import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { snapshotDatabase, archiveImagesDir } from '../backup-database.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const BACKUP_SCRIPT = join(REPO_ROOT, 'scripts', 'backup-database.mjs');
const SERVICE_PATH = join(
  REPO_ROOT,
  'installers',
  'linux',
  'orchestrator-db-backup.service',
);

/** Build a source DB in WAL mode with enough data that VACUUM INTO takes measurable time. */
function buildSourceDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE sessions (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE churn (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT);
  `);
  const insert = db.prepare('INSERT INTO sessions (id, name) VALUES (?, ?)');
  const insertMany = db.transaction((rows) => {
    for (const row of rows) insert.run(row.id, row.name);
  });
  const rows = [];
  for (let i = 0; i < 30000; i++) {
    rows.push({ id: i, name: `session-${i}-${'x'.repeat(120)}` });
  }
  insertMany(rows);
  db.close();
}

/** Spawn a subprocess that continuously commits writes against dbPath for durationMs. */
function spawnConcurrentWriter(dbPath, durationMs) {
  // Under `node -e`, extra CLI args start at argv[1] (there is no script-name
  // placeholder like there is for a regular script invocation).
  const script = `
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1]);
    db.pragma('journal_mode = WAL');
    db.exec("CREATE TABLE IF NOT EXISTS churn (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");
    const insert = db.prepare('INSERT INTO churn (val) VALUES (?)');
    const end = Date.now() + Number(process.argv[2]);
    while (Date.now() < end) {
      insert.run('x'.repeat(200));
    }
    db.close();
  `;
  return spawn(process.execPath, ['-e', script, dbPath, String(durationMs)], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  });
}

describe('backup-database snapshot step', () => {
  let workDir;
  let dbPath;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), 'backup-db-test-'));
    dbPath = join(workDir, 'source.db');
    buildSourceDb(dbPath);
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('completes while the source DB is written concurrently throughout', async () => {
    const destPath = join(workDir, 'concurrent-snapshot.db');
    const writer = spawnConcurrentWriter(dbPath, 4000);
    try {
      // Give the writer a head start so commits are already in flight.
      await new Promise((resolve) => setTimeout(resolve, 100));
      snapshotDatabase(dbPath, destPath);
    } finally {
      writer.kill('SIGTERM');
    }
    assert.ok(existsSync(destPath), 'snapshot file was not produced');
  });

  it('produces an internally consistent, readable snapshot', () => {
    const destPath = join(workDir, 'consistency-snapshot.db');
    snapshotDatabase(dbPath, destPath);

    const check = new Database(destPath, { readonly: true });
    try {
      const result = check.pragma('integrity_check');
      assert.deepEqual(result, [{ integrity_check: 'ok' }]);

      const tables = check
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence'",
        )
        .all()
        .map((r) => r.name)
        .sort();
      assert.deepEqual(tables, ['churn', 'sessions']);

      const count = check.prepare('SELECT COUNT(*) AS n FROM sessions').get();
      assert.equal(count.n, 30000);
    } finally {
      check.close();
    }
  });
});

describe('backup-database.mjs plaintext cleanup', () => {
  let workDir;
  let dbPath;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), 'backup-cleanup-test-'));
    dbPath = join(workDir, 'source.db');
    buildSourceDb(dbPath);
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function listPlaintextSnapshots(dir) {
    return readdirSync(dir).filter((name) => /^dashboard-.*\.db$/.test(name));
  }

  it('removes the plaintext snapshot on the success path (--dry-run)', () => {
    const runWorkDir = join(workDir, 'success-run');
    const result = spawnSync(process.execPath, [BACKUP_SCRIPT, '--dry-run'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        DB_PATH: dbPath,
        BACKUP_WORK_DIR: runWorkDir,
        BACKUP_GPG_PASSPHRASE: 'test-passphrase',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      listPlaintextSnapshots(runWorkDir).length,
      0,
      'plaintext .db snapshot left behind after a successful run',
    );
    const encrypted = readdirSync(runWorkDir).filter((n) => n.endsWith('.gpg'));
    assert.equal(
      encrypted.length,
      1,
      'expected exactly one encrypted artifact',
    );
  });

  it('removes the plaintext snapshot when the run is killed mid-snapshot (SIGTERM)', async () => {
    const runWorkDir = join(workDir, 'killed-run');
    const child = spawn(process.execPath, [BACKUP_SCRIPT, '--dry-run'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DB_PATH: dbPath,
        BACKUP_WORK_DIR: runWorkDir,
        BACKUP_GPG_PASSPHRASE: 'test-passphrase',
      },
      stdio: 'ignore',
    });

    const exited = new Promise((resolve) => child.on('exit', resolve));

    // Poll for the plaintext snapshot to appear on disk, then kill mid-write.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (
        existsSync(runWorkDir) &&
        listPlaintextSnapshots(runWorkDir).length > 0
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    child.kill('SIGTERM');
    await exited;

    assert.equal(
      listPlaintextSnapshots(runWorkDir).length,
      0,
      'plaintext .db snapshot survived a SIGTERM mid-run',
    );
  });
});

describe('archiveImagesDir', () => {
  let workDir;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), 'backup-images-test-'));
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('returns false and writes nothing when the images dir does not exist', () => {
    const imagesDir = join(workDir, 'no-such-images-dir');
    const destPath = join(workDir, 'missing.tar');
    const produced = archiveImagesDir(imagesDir, destPath);
    assert.equal(produced, false);
    assert.equal(existsSync(destPath), false);
  });

  it('tars the images directory when it exists', () => {
    const imagesDir = join(workDir, 'investigation-report-images');
    mkdirSync(imagesDir, { recursive: true });
    writeFileSync(join(imagesDir, 'report-1.png'), 'fake-png-bytes');
    const destPath = join(workDir, 'images.tar');
    const produced = archiveImagesDir(imagesDir, destPath);
    assert.equal(produced, true);
    assert.equal(existsSync(destPath), true);

    const listing = spawnSync('tar', ['-tf', destPath], { encoding: 'utf8' });
    assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, /investigation-report-images\/report-1\.png/);
  });
});

describe('backup-database.mjs images directory coverage', () => {
  let workDir;
  let dbPath;
  let imagesDir;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), 'backup-images-cli-test-'));
    dbPath = join(workDir, 'source.db');
    buildSourceDb(dbPath);
    imagesDir = join(workDir, 'investigation-report-images');
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('snapshots/encrypts an images archive alongside the DB when the images dir exists (--dry-run)', () => {
    mkdirSync(imagesDir, { recursive: true });
    writeFileSync(join(imagesDir, 'report-1.png'), 'fake-png-bytes');

    const runWorkDir = join(workDir, 'with-images-run');
    const result = spawnSync(process.execPath, [BACKUP_SCRIPT, '--dry-run'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        DB_PATH: dbPath,
        IMAGES_DIR: imagesDir,
        BACKUP_WORK_DIR: runWorkDir,
        BACKUP_GPG_PASSPHRASE: 'test-passphrase',
      },
    });
    assert.equal(result.status, 0, result.stderr);

    const produced = readdirSync(runWorkDir);
    const dbEncrypted = produced.filter(
      (n) => n.startsWith('dashboard-') && n.endsWith('.db.gpg'),
    );
    const imagesEncrypted = produced.filter(
      (n) => n.startsWith('dashboard-images-') && n.endsWith('.tar.gpg'),
    );
    assert.equal(dbEncrypted.length, 1, 'expected one encrypted DB snapshot');
    assert.equal(
      imagesEncrypted.length,
      1,
      'expected one encrypted images archive',
    );
    // Plaintext must never survive a successful run, for either artifact.
    assert.equal(
      produced.some((n) => n.endsWith('.tar') && !n.endsWith('.tar.gpg')),
      false,
      'plaintext images tar left behind after a successful run',
    );
  });

  it('skips the images archive gracefully when the images dir does not exist', () => {
    const runWorkDir = join(workDir, 'without-images-run');
    const result = spawnSync(process.execPath, [BACKUP_SCRIPT, '--dry-run'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        DB_PATH: dbPath,
        IMAGES_DIR: join(workDir, 'no-such-images-dir'),
        BACKUP_WORK_DIR: runWorkDir,
        BACKUP_GPG_PASSPHRASE: 'test-passphrase',
      },
    });
    assert.equal(result.status, 0, result.stderr);

    const produced = readdirSync(runWorkDir);
    const dbEncrypted = produced.filter(
      (n) => n.startsWith('dashboard-') && n.endsWith('.db.gpg'),
    );
    const imagesEncrypted = produced.filter((n) => n.endsWith('.tar.gpg'));
    assert.equal(dbEncrypted.length, 1, 'expected one encrypted DB snapshot');
    assert.equal(
      imagesEncrypted.length,
      0,
      'no images archive should be produced when the images dir is absent',
    );
  });
});

describe('orchestrator-db-backup.service', () => {
  it('declares a TimeoutStartSec', () => {
    const contents = readFileSync(SERVICE_PATH, 'utf8');
    assert.match(contents, /^TimeoutStartSec=\d+/m);
  });
});
