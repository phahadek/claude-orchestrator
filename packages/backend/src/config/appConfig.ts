import path from 'path';
import { DataDirConfigSource } from './DataDirConfigSource';
import { EnvFileConfigSource } from './EnvFileConfigSource';
import { getDataDir } from './dataDir';
import { logger } from '../logger';
import {
  ConfigValidationError,
  type ConfigFieldSource,
  type ConfigProvenance,
  type ConfigSource,
  type DeepPartial,
  type OrchestratorConfig,
} from './types';

let cached: OrchestratorConfig | null = null;
let cachedProvenance: ConfigProvenance | null = null;
let sourceOverride: ConfigSource | null = null;

/** Every effective-config field, in the shape reported by the provenance surface. */
const ALL_FIELDS: Array<{
  key: string;
  get: (c: OrchestratorConfig) => unknown;
  /** process.env var consulted for this field in legacy (no config.json) mode. */
  envVar?: string;
}> = [
  {
    key: 'notion.apiKey',
    get: (c) => c.notion.apiKey,
    envVar: 'NOTION_API_KEY',
  },
  { key: 'github.token', get: (c) => c.github.token, envVar: 'GITHUB_TOKEN' },
  { key: 'github.repo', get: (c) => c.github.repo, envVar: 'GITHUB_REPO' },
  { key: 'db.path', get: (c) => c.db.path, envVar: 'DB_PATH' },
  { key: 'sessions.dir', get: (c) => c.sessions.dir, envVar: 'SESSIONS_DIR' },
  { key: 'server.port', get: (c) => c.server.port, envVar: 'PORT' },
  {
    key: 'autoReview.enabled',
    get: (c) => c.autoReview.enabled,
    envVar: 'AUTO_REVIEW',
  },
  { key: 'autoReview.concurrency', get: (c) => c.autoReview.concurrency },
  { key: 'setupComplete', get: (c) => c.setupComplete },
];

/** Fields whose values must never be logged or returned in full — presence/length only. */
export const SECRET_FIELDS = new Set(['notion.apiKey', 'github.token']);

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
): { config: OrchestratorConfig; provenance: ConfigProvenance } {
  const envConfig = new EnvFileConfigSource().read();
  const filledFromEnv: string[] = [];
  const overriddenFromEnv: string[] = [];
  const provenance: ConfigProvenance = {};

  for (const field of ENV_FALLBACK_FIELDS) {
    const envValue = field.get(envConfig);
    const explicitlySet =
      explicitFields.has(field.key) && field.get(config) !== '';
    if (!explicitlySet) {
      if (envValue) {
        field.set(config, envValue);
        filledFromEnv.push(field.key);
        provenance[field.key] = 'env';
      } else {
        provenance[field.key] = 'default';
      }
    } else {
      provenance[field.key] = 'config.json';
      if (envValue && envValue !== field.get(config)) {
        overriddenFromEnv.push(field.key);
      }
    }
  }

  // Fields not eligible for .env fallback: config.json if explicitly set, else default.
  for (const field of ALL_FIELDS) {
    if (field.key in provenance) continue;
    provenance[field.key] = explicitFields.has(field.key)
      ? 'config.json'
      : 'default';
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

  return { config, provenance };
}

/** Provenance for legacy (no config.json) mode: env if the var is set, else default. */
function legacyProvenance(): ConfigProvenance {
  const provenance: ConfigProvenance = {};
  for (const field of ALL_FIELDS) {
    const source: ConfigFieldSource =
      field.envVar && process.env[field.envVar] !== undefined
        ? 'env'
        : 'default';
    provenance[field.key] = source;
  }
  return provenance;
}

function logProvenanceSummary(provenance: ConfigProvenance): void {
  const config = getOrchestratorConfig();
  const parts = ALL_FIELDS.map((field) => {
    const source = provenance[field.key] ?? 'default';
    if (SECRET_FIELDS.has(field.key)) {
      const value = String(field.get(config) ?? '');
      return `${field.key}=${source}${value ? ` (${value.length} chars)` : ''}`;
    }
    return `${field.key}=${source}`;
  });
  logger.info(`[config] effective configuration: ${parts.join(', ')}`);
}

function resolve(): {
  config: OrchestratorConfig;
  provenance: ConfigProvenance;
} {
  if (sourceOverride) {
    // Test-only override: no provenance tracking, everything reports as config.json.
    const config = sourceOverride.read();
    const provenance: ConfigProvenance = {};
    for (const field of ALL_FIELDS) provenance[field.key] = 'config.json';
    return { config, provenance };
  }

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
  return {
    config: new EnvFileConfigSource().read(),
    provenance: legacyProvenance(),
  };
}

function ensureResolved(): void {
  if (cached) return;
  const result = resolve();
  cached = result.config;
  cachedProvenance = result.provenance;
}

/** Returns the resolved OrchestratorConfig (cached per process lifetime). */
export function getOrchestratorConfig(): OrchestratorConfig {
  ensureResolved();
  return cached!;
}

/**
 * Returns where each effective-config field's value came from: config.json,
 * .env fallback, or the shipped default. Computed alongside the same resolve()
 * pass that produces getOrchestratorConfig(), and cached with it.
 */
export function getConfigProvenance(): ConfigProvenance {
  ensureResolved();
  return cachedProvenance!;
}

/** Logs a one-line, secret-safe summary of the effective config and its provenance. */
export function logConfigProvenanceSummary(): void {
  logProvenanceSummary(getConfigProvenance());
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
  cachedProvenance = null;
}

/** Override the config source — for unit tests only. */
export function _setConfigSourceForTesting(src: ConfigSource): void {
  sourceOverride = src;
  cached = null;
  cachedProvenance = null;
}

/** Reset cached state — for unit tests only. */
export function _resetAppConfigCache(): void {
  cached = null;
  cachedProvenance = null;
  sourceOverride = null;
}
