// Vitest setupFile — runs before any test file's module graph is evaluated.
// Forces every test process onto an in-memory database, regardless of what
// DB_PATH (or any other env var pointing at a production data file) was
// inherited from the parent process. This must run ahead of the first
// `import '../db/db'` anywhere in the suite, since db.ts opens its database
// connection at module load time.
process.env.DB_PATH = ':memory:';
