import fs from 'fs';
import path from 'path';
import { getDataDir } from './dataDir.js';
import {
  ConfigValidationError,
  type ConfigSource,
  type DeepPartial,
  type OrchestratorConfig,
} from './types.js';

const KNOWN_KEYS = new Set([
  'notion',
  'github',
  'server',
  'db',
  'sessions',
  'autoReview',
]);

export const CONFIG_DEFAULTS: OrchestratorConfig = {
  notion: { apiKey: '' },
  github: { token: '', repo: '' },
  server: { port: 3000 },
  db: { path: './dashboard.db' },
  sessions: { dir: '' },
  autoReview: { enabled: true, concurrency: 1 },
};

function str(v: unknown, field: string): string {
  if (typeof v !== 'string') {
    throw new ConfigValidationError(
      `[config] config.json: "${field}" must be a string, got ${JSON.stringify(v)}. Fix the file and restart.`,
    );
  }
  return v;
}

function num(v: unknown, field: string): number {
  if (typeof v !== 'number') {
    throw new ConfigValidationError(
      `[config] config.json: "${field}" must be a number, got ${JSON.stringify(v)}. Fix the file and restart.`,
    );
  }
  return v;
}

function bool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') {
    throw new ConfigValidationError(
      `[config] config.json: "${field}" must be a boolean, got ${JSON.stringify(v)}. Fix the file and restart.`,
    );
  }
  return v;
}

function obj(v: unknown, field: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ConfigValidationError(
      `[config] config.json: "${field}" must be an object, got ${JSON.stringify(v)}. Fix the file and restart.`,
    );
  }
  return v as Record<string, unknown>;
}

function validateConfig(raw: unknown): OrchestratorConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigValidationError(
      '[config] config.json must be a JSON object. Fix the file and restart.',
    );
  }
  const top = raw as Record<string, unknown>;

  const unknownKeys = Object.keys(top).filter((k) => !KNOWN_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw new ConfigValidationError(
      `[config] config.json has unknown top-level field(s): ${unknownKeys.join(', ')}. Remove them and restart.`,
    );
  }

  const result = structuredClone(CONFIG_DEFAULTS);

  if ('notion' in top) {
    const n = obj(top.notion, 'notion');
    if ('apiKey' in n) result.notion.apiKey = str(n.apiKey, 'notion.apiKey');
  }
  if ('github' in top) {
    const g = obj(top.github, 'github');
    if ('token' in g) result.github.token = str(g.token, 'github.token');
    if ('repo' in g) result.github.repo = str(g.repo, 'github.repo');
  }
  if ('server' in top) {
    const s = obj(top.server, 'server');
    if ('port' in s) result.server.port = num(s.port, 'server.port');
  }
  if ('db' in top) {
    const d = obj(top.db, 'db');
    if ('path' in d) result.db.path = str(d.path, 'db.path');
  }
  if ('sessions' in top) {
    const se = obj(top.sessions, 'sessions');
    if ('dir' in se) result.sessions.dir = str(se.dir, 'sessions.dir');
  }
  if ('autoReview' in top) {
    const ar = obj(top.autoReview, 'autoReview');
    if ('enabled' in ar)
      result.autoReview.enabled = bool(ar.enabled, 'autoReview.enabled');
    if ('concurrency' in ar)
      result.autoReview.concurrency = num(
        ar.concurrency,
        'autoReview.concurrency',
      );
  }

  return result;
}

function deepMerge(
  target: OrchestratorConfig,
  source: DeepPartial<OrchestratorConfig>,
): OrchestratorConfig {
  const result = structuredClone(target) as unknown as Record<string, unknown>;
  const src = source as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    const sv = src[key];
    if (sv !== undefined && typeof sv === 'object' && sv !== null) {
      const tv = result[key];
      result[key] =
        typeof tv === 'object' && tv !== null
          ? { ...(tv as object), ...(sv as object) }
          : { ...(sv as object) };
    } else if (sv !== undefined) {
      result[key] = sv;
    }
  }
  return result as unknown as OrchestratorConfig;
}

export class DataDirConfigSource implements ConfigSource {
  readonly configPath: string;

  constructor(dataDir?: string) {
    const dir = dataDir ?? getDataDir();
    fs.mkdirSync(dir, { recursive: true });
    this.configPath = path.join(dir, 'config.json');
  }

  exists(): boolean {
    return fs.existsSync(this.configPath);
  }

  read(): OrchestratorConfig {
    if (!this.exists()) {
      return structuredClone(CONFIG_DEFAULTS);
    }
    const raw: unknown = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    return validateConfig(raw);
  }

  write(partial: DeepPartial<OrchestratorConfig>): void {
    const existing = this.exists()
      ? this.read()
      : structuredClone(CONFIG_DEFAULTS);
    const merged = deepMerge(existing, partial);
    fs.writeFileSync(this.configPath, JSON.stringify(merged, null, 2), 'utf8');
  }
}
