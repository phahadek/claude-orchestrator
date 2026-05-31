import path from 'path';
import { DataDirConfigSource } from './DataDirConfigSource.js';
import { EnvFileConfigSource } from './EnvFileConfigSource.js';
import { getDataDir } from './dataDir.js';
import {
  ConfigValidationError,
  type ConfigSource,
  type DeepPartial,
  type OrchestratorConfig,
} from './types.js';

let cached: OrchestratorConfig | null = null;
let sourceOverride: ConfigSource | null = null;

function resolve(): OrchestratorConfig {
  if (sourceOverride) return sourceOverride.read();

  const dataDirSource = new DataDirConfigSource();

  if (dataDirSource.exists()) {
    try {
      return dataDirSource.read();
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    }
  }

  // Fall back to .env (legacy dev mode)
  const recommendedPath = path.join(getDataDir(), 'config.json');
  console.warn(
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
