// Vitest setupFile — runs before any test file's module graph is evaluated.
// Forces every test process onto an in-memory database, regardless of what
// DB_PATH (or any other env var pointing at a production data file) was
// inherited from the parent process. This must run ahead of the first
// `import '../db/db'` anywhere in the suite, since db.ts opens its database
// connection at module load time.
process.env.DB_PATH = ':memory:';

// Dynamic imports (not static ones) so this module's DB_PATH assignment above
// runs before db.ts opens its connection — a static `import` would be
// hoisted ahead of it. Top-level await runs fine under Vitest's own ESM
// transform (which Vitest awaits before running this file's tests), even
// though the backend's CommonJS tsconfig doesn't allow the syntax standalone.
// @ts-expect-error -- top-level await; disallowed by tsconfig's CommonJS
// module setting, but this file is only ever run through Vitest, never tsc.
const { db } = await import('./db/db');
// @ts-expect-error -- top-level await; see above.
const { runMigrations } = await import('./db/schema');

// Production boot (server.ts) is the only other caller of runMigrations();
// the in-memory DB used by tests needs the same tables (e.g. audit_log,
// settings) that db.ts's own inline CREATE TABLE statements don't create.
runMigrations(db);
