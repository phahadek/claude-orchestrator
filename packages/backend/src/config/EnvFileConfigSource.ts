import type { ConfigSource, DeepPartial, OrchestratorConfig } from './types.js';

/**
 * Legacy config source: reads from process.env (populated by dotenv from packages/backend/.env).
 * Read-only — write() throws. Use DataDirConfigSource for writable config.
 */
export class EnvFileConfigSource implements ConfigSource {
  read(): OrchestratorConfig {
    return {
      notion: {
        apiKey: process.env.NOTION_API_KEY ?? '',
      },
      github: {
        token: process.env.GITHUB_TOKEN ?? '',
        repo: process.env.GITHUB_REPO ?? '',
      },
      server: {
        port: Number(process.env.PORT ?? 3000),
      },
      db: {
        path: process.env.DB_PATH ?? './dashboard.db',
      },
      sessions: {
        dir: process.env.SESSIONS_DIR ?? '',
      },
      autoReview: {
        enabled: process.env.AUTO_REVIEW !== 'false',
        concurrency: Number(process.env.AUTO_REVIEW_CONCURRENCY ?? 1),
      },
    };
  }

  write(_partial: DeepPartial<OrchestratorConfig>): void {
    throw new Error(
      'EnvFileConfigSource is read-only. Edit packages/backend/.env to change settings, ' +
        'or create a config.json in the data directory to use the new config format.',
    );
  }
}
