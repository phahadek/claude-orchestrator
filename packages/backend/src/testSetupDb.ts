import { resolveTestScratchDataDir } from './testScratchDataDir';
import { EnvFileConfigSource } from './config/EnvFileConfigSource';
import { _setDefaultTestConfigSource } from './config/appConfig';
import type {
  ConfigSource,
  DeepPartial,
  OrchestratorConfig,
} from './config/types';

// Vitest setupFile — runs before any test file's module graph is evaluated.
// Forces every test process onto an in-memory database, regardless of what
// DB_PATH (or any other env var pointing at a production data file) was
// inherited from the parent process. This must run ahead of the first
// `import '../db/db'` anywhere in the suite, since db.ts opens its database
// connection at module load time.
process.env.DB_PATH = ':memory:';
// Likewise for config resolution: appConfig.ts's resolve() falls back to
// DataDirConfigSource (a real on-disk config.json under the OS data dir —
// see config/dataDir.ts) whenever one exists there, ignoring DB_PATH/
// in-memory-DB isolation entirely. A host that has ever run the real app
// (or a previous test worker that wrote real config via
// writeOrchestratorConfig(), which always targets the real data dir — see
// its doc comment in appConfig.ts) would otherwise leak production-looking
// config into every test process. Point every worker at its own disposable,
// process-scoped data dir instead. pid-scoped (not shared) so parallel
// vitest worker processes can never race on the same config.json.
// Anchored to this module's own location (not process.cwd()) so the
// directory always lands under packages/backend/ regardless of where
// vitest was invoked from — see testScratchDataDir.ts and .gitignore.
process.env.XDG_DATA_HOME = resolveTestScratchDataDir(process.pid);

// appConfig.ts's resolve() prefers a data-dir config.json over DB_PATH
// whenever one exists (see DataDirConfigSource, above). A test calling
// writeOrchestratorConfig() writes exactly that file into this worker's
// scratch XDG_DATA_HOME, so every later test file in the same worker would
// otherwise resolve db.path from that leftover file instead of from
// DB_PATH. Pin config resolution to an in-memory source up front — read
// everything else the normal legacy way (env), but always report db.path
// as ':memory:' regardless of what's on disk or in DB_PATH. Installed via
// _setDefaultTestConfigSource so _resetAppConfigCache() (called by several
// test files) restores to this instead of falling back to the data-dir
// branch. Tests whose subject is config resolution itself (provenance,
// .env fallback, etc.) need the real branch back — see
// _clearConfigSourceForTesting() in appConfig.ts, which opts a single test
// out of this restore without disabling it for the rest of the suite.
class InMemoryTestConfigSource implements ConfigSource {
  read(): OrchestratorConfig {
    const config = new EnvFileConfigSource().read();
    config.db.path = ':memory:';
    return config;
  }
  write(_partial: DeepPartial<OrchestratorConfig>): void {
    throw new Error('InMemoryTestConfigSource is read-only.');
  }
}
_setDefaultTestConfigSource(new InMemoryTestConfigSource());

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
