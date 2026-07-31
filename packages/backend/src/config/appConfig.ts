import path from 'path';
import { DataDirConfigSource } from './DataDirConfigSource';
import { EnvFileConfigSource } from './EnvFileConfigSource';
import { getDataDir } from './dataDir';
import { logger } from '../logger';
import {
  ConfigValidationError,
  type ConfigSource,
  type DeepPartial,
  type OrchestratorConfig,
} from './types';

let cached: OrchestratorConfig | null = null;
let sourceOverride: ConfigSource | null = null;

// Fields for which an absent-or-empty config.json value falls back to the
// legacy .env value, rather than config.json's mere existence silently
// disabling a fully-populated .env for every field (the cause of the
// 2026-07-30 outage: a config.json with one real field and six placeholders
// overrode a working .env in every field, with no warning).
const ENV_FALLBACK_FIELDS: Array<{
  key: string;
  get: (c: OrchestratorConfig) => string;
  set: (c: OrchestratorConfig, v: string) => void;
}> = [
  {
    key: 'notion.apiKey',
    get: (c) => c.notion.apiKey,
    set: (c, v) => {
      c.notion.apiKey = v;
    },
  },
  {
    key: 'github.token',
    get: (c) => c.github.token,
    set: (c, v) => {
      c.github.token = v;
    },
  },
  {
    key: 'github.repo',
    get: (c) => c.github.repo,
    set: (c, v) => {
      c.github.repo = v;
    },
  },
  {
    key: 'db.path',
    get: (c) => c.db.path,
    set: (c, v) => {
      c.db.path = v;
    },
  },
  {
    key: 'sessions.dir',
    get: (c) => c.sessions.dir,
    set: (c, v) => {
      c.sessions.dir = v;
    },
  },
];

function applyEnvFallback(
  config: OrchestratorConfig,
  explicitFields: Set<string>,
): OrchestratorConfig {
  const envConfig = new EnvFileConfigSource().read();
  const filledFromEnv: string[] = [];
  const overriddenFromEnv: string[] = [];

  for (const field of ENV_FALLBACK_FIELDS) {
    const envValue = field.get(envConfig);
    const explicitlySet =
      explicitFields.has(field.key) && field.get(config) !== '';
    if (!explicitlySet) {
      if (envValue) {
        field.set(config, envValue);
        filledFromEnv.push(field.key);
      }
    } else if (envValue && envValue !== field.get(config)) {
      overriddenFromEnv.push(field.key);
    }
  }

  if (filledFromEnv.length > 0) {
    logger.info(
      `[config] config.json is missing/empty for ${filledFromEnv.join(', ')} — filled in from .env.`,
    );
  }
  if (overriddenFromEnv.length > 0) {
    logger.warn(
      `[config] config.json overrides a populated .env value for: ${overriddenFromEnv.join(', ')}. ` +
        `The .env value(s) are being ignored in favor of config.json. Remove them from .env, or update ` +
        `config.json, if this is unintended.`,
    );
  }

  return config;
}

function resolve(): OrchestratorConfig {
  if (sourceOverride) return sourceOverride.read();

  const dataDirSource = new DataDirConfigSource();

  if (dataDirSource.exists()) {
    try {
      const { config, explicitFields } = dataDirSource.readWithExplicitFields();
      return applyEnvFallback(config, explicitFields);
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        logger.error(err.message);
        process.exit(1);
      }
      throw err;
    }
  }

  // Fall back to .env (legacy dev mode)
  const recommendedPath = path.join(getDataDir(), 'config.json');
  logger.warn(
    `[config] No config.json found in the data directory. Reading credentials from .env (legacy mode).\n` +
      `  To migrate, create: ${recommendedPath}\n` +
      `  The first-run wizard will handle this automatically when available.`,
  );
  return new EnvFileConfigSource().read();
}

/** Returns the resolved OrchestratorConfig (cached per process lifetime). */
export function getOrchestratorConfig(): OrchestratorConfig {
  if (!cached) cached = resolve();
  return cached;
}

/**
 * Writes a partial config to the data-dir config.json, deep-merging with the existing file.
 * Always targets the data dir (creates it if necessary), regardless of the current active source.
 */
export function writeOrchestratorConfig(
  partial: DeepPartial<OrchestratorConfig>,
): void {
  const source = new DataDirConfigSource();
  source.write(partial);
  cached = null;
}

/** Override the config source — for unit tests only. */
export function _setConfigSourceForTesting(src: ConfigSource): void {
  sourceOverride = src;
  cached = null;
}

/** Reset cached state — for unit tests only. */
export function _resetAppConfigCache(): void {
  cached = null;
  sourceOverride = null;
}
