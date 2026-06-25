import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// Tests the Git-Bash project_dir backfill migration in schema.ts.
// The SQL converts /c/... style paths to C:/... Win32 form.

const GITBASH_PATH = '/c/Users/phadek/IdeaProjects/proj';
const WIN32_PATH = 'C:/Users/phadek/IdeaProjects/proj';
const GITBASH_UPPER = '/D/projects/repo';
const WIN32_UPPER = 'D:/projects/repo';
const NATIVE_WIN32 = 'C:/already/native';
const POSIX_PATH = '/home/orchestrator/repo';

const BACKFILL_SQL = `
  UPDATE projects
  SET project_dir = upper(substr(project_dir, 2, 1)) || ':' || substr(project_dir, 3)
  WHERE substr(project_dir, 1, 1) = '/'
    AND substr(project_dir, 3, 1) = '/'
    AND (
      (substr(project_dir, 2, 1) BETWEEN 'a' AND 'z')
      OR (substr(project_dir, 2, 1) BETWEEN 'A' AND 'Z')
    )
`;

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      project_dir  TEXT NOT NULL,
      created_at   INTEGER NOT NULL DEFAULT 0,
      updated_at   INTEGER NOT NULL DEFAULT 0
    )
  `);
  return db;
}

function insertProject(
  db: InstanceType<typeof Database>,
  id: string,
  dir: string,
) {
  db.prepare('INSERT INTO projects(id, name, project_dir) VALUES(?,?,?)').run(
    id,
    'Test',
    dir,
  );
}

function getProjectDir(db: InstanceType<typeof Database>, id: string): string {
  const row = db
    .prepare('SELECT project_dir FROM projects WHERE id = ?')
    .get(id) as { project_dir: string };
  return row.project_dir;
}

function runBackfill(db: InstanceType<typeof Database>) {
  db.exec(BACKFILL_SQL);
}

describe('Git-Bash project_dir backfill migration', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = makeDb();
  });

  it('converts /c/... to C:/... (lowercase drive letter)', () => {
    insertProject(db, 'p1', GITBASH_PATH);
    runBackfill(db);
    expect(getProjectDir(db, 'p1')).toBe(WIN32_PATH);
  });

  it('converts /D/... to D:/... (uppercase drive letter)', () => {
    insertProject(db, 'p2', GITBASH_UPPER);
    runBackfill(db);
    expect(getProjectDir(db, 'p2')).toBe(WIN32_UPPER);
  });

  it('leaves already-native C:/... path unchanged', () => {
    insertProject(db, 'p3', NATIVE_WIN32);
    runBackfill(db);
    expect(getProjectDir(db, 'p3')).toBe(NATIVE_WIN32);
  });

  it('leaves native POSIX paths unchanged (e.g. /home/orchestrator/repo)', () => {
    insertProject(db, 'p4', POSIX_PATH);
    runBackfill(db);
    expect(getProjectDir(db, 'p4')).toBe(POSIX_PATH);
  });

  it('is idempotent — running twice is a no-op the second time', () => {
    insertProject(db, 'p5', GITBASH_PATH);
    runBackfill(db);
    const afterFirst = getProjectDir(db, 'p5');
    runBackfill(db);
    expect(getProjectDir(db, 'p5')).toBe(afterFirst);
    expect(getProjectDir(db, 'p5')).toBe(WIN32_PATH);
  });

  it('handles multiple projects — only Git-Bash paths are converted', () => {
    insertProject(db, 'a', GITBASH_PATH);
    insertProject(db, 'b', GITBASH_UPPER);
    insertProject(db, 'c', NATIVE_WIN32);
    insertProject(db, 'd', POSIX_PATH);
    runBackfill(db);
    expect(getProjectDir(db, 'a')).toBe(WIN32_PATH);
    expect(getProjectDir(db, 'b')).toBe(WIN32_UPPER);
    expect(getProjectDir(db, 'c')).toBe(NATIVE_WIN32);
    expect(getProjectDir(db, 'd')).toBe(POSIX_PATH);
  });
});
