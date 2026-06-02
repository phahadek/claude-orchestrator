import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/schema.js';

export function setupTestDb(): Database.Database {
  const mem = new Database(':memory:');
  runMigrations(mem);
  return mem;
}
