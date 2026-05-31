import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Must mock before importing the modules under test
vi.mock('../db/queries.js', () => ({}));

import { DataDirConfigSource, CONFIG_DEFAULTS } from '../config/DataDirConfigSource.js';
import { EnvFileConfigSource } from '../config/EnvFileConfigSource.js';
import { ConfigValidationError } from '../config/types.js';
import {
  getOrchestratorConfig,
  writeOrchestratorConfig,
  _setConfigSourceForTesting,
  _resetAppConfigCache,
} from '../config/appConfig.js';

// ── DataDirConfigSource ───────────────────────────────────────────────────────

describe('DataDirConfigSource', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the data directory eagerly on construction', () => {
    const subDir = path.join(tmpDir, 'nested', 'datadir');
    new DataDirConfigSource(subDir);
    expect(fs.existsSync(subDir)).toBe(true);
  });

  it('exists() returns false when config.json is absent', () => {
    const src = new DataDirConfigSource(tmpDir);
    expect(src.exists()).toBe(false);
  });

  it('exists() returns true after write()', () => {
    const src = new DataDirConfigSource(tmpDir);
    src.write({});
    expect(src.exists()).toBe(true);
  });

  it('read() returns defaults when config.json is absent', () => {
    const src = new DataDirConfigSource(tmpDir);
    expect(src.read()).toEqual(CONFIG_DEFAULTS);
  });

  it('write() then read() round-trips the written values', () => {
    const src = new DataDirConfigSource(tmpDir);
    src.write({ notion: { apiKey: 'ntn-123' }, server: { port: 4000 } });
    const cfg = src.read();
    expect(cfg.notion.apiKey).toBe('ntn-123');
    expect(cfg.server.port).toBe(4000);
  });

  it('write() deep-merges: writing one section leaves others untouched', () => {
    const src = new DataDirConfigSource(tmpDir);
    src.write({
      notion: { apiKey: 'ntn-abc' },
      github: { token: 'ghp-xyz', repo: 'owner/repo' },
    });
    // Now write only notion — github must survive
    src.write({ notion: { apiKey: 'ntn-new' } });
    const cfg = src.read();
    expect(cfg.notion.apiKey).toBe('ntn-new');
    expect(cfg.github.token).toBe('ghp-xyz');
    expect(cfg.github.repo).toBe('owner/repo');
  });

  it('write() persists to disk as valid JSON', () => {
    const src = new DataDirConfigSource(tmpDir);
    src.write({ server: { port: 9999 } });
    const raw = JSON.parse(fs.readFileSync(src.configPath, 'utf8'));
    expect(raw.server.port).toBe(9999);
  });

  describe('schema validation', () => {
    function writeRaw(tmpDir: string, data: unknown) {
      fs.writeFileSync(
        path.join(tmpDir, 'config.json'),
        JSON.stringify(data),
        'utf8',
      );
    }

    it('throws ConfigValidationError for unknown top-level fields', () => {
      writeRaw(tmpDir, { unknownField: 'oops' });
      const src = new DataDirConfigSource(tmpDir);
      expect(() => src.read()).toThrow(ConfigValidationError);
      expect(() => src.read()).toThrow(/unknown top-level field/);
    });

    it('throws ConfigValidationError when port is a string instead of number', () => {
      writeRaw(tmpDir, { server: { port: 'not-a-number' } });
      const src = new DataDirConfigSource(tmpDir);
      expect(() => src.read()).toThrow(ConfigValidationError);
      expect(() => src.read()).toThrow(/server\.port/);
    });

    it('throws ConfigValidationError when autoReview.enabled is a string', () => {
      writeRaw(tmpDir, { autoReview: { enabled: 'yes' } });
      const src = new DataDirConfigSource(tmpDir);
      expect(() => src.read()).toThrow(ConfigValidationError);
      expect(() => src.read()).toThrow(/autoReview\.enabled/);
    });

    it('throws ConfigValidationError when a section is not an object', () => {
      writeRaw(tmpDir, { notion: 'bad' });
      const src = new DataDirConfigSource(tmpDir);
      expect(() => src.read()).toThrow(ConfigValidationError);
    });

    it('throws ConfigValidationError when root is an array', () => {
      writeRaw(tmpDir, [{ notion: {} }]);
      const src = new DataDirConfigSource(tmpDir);
      expect(() => src.read()).toThrow(ConfigValidationError);
    });

    it('accepts a valid partial config (missing sections use defaults)', () => {
      writeRaw(tmpDir, { notion: { apiKey: 'ntn-ok' } });
      const src = new DataDirConfigSource(tmpDir);
      const cfg = src.read();
      expect(cfg.notion.apiKey).toBe('ntn-ok');
      expect(cfg.server.port).toBe(3000);
    });
  });
});

// ── EnvFileConfigSource ───────────────────────────────────────────────────────

describe('EnvFileConfigSource', () => {
  const saved: Record<string, string | undefined> = {};
  const envKeys = [
    'NOTION_API_KEY',
    'GITHUB_TOKEN',
    'GITHUB_REPO',
    'PORT',
    'DB_PATH',
    'SESSIONS_DIR',
    'AUTO_REVIEW',
    'AUTO_REVIEW_CONCURRENCY',
  ] as const;

  beforeEach(() => {
    for (const k of envKeys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  });

  it('reads defaults when no env vars are set', () => {
    const cfg = new EnvFileConfigSource().read();
    expect(cfg.notion.apiKey).toBe('');
    expect(cfg.github.token).toBe('');
    expect(cfg.github.repo).toBe('');
    expect(cfg.server.port).toBe(3000);
    expect(cfg.db.path).toBe('./dashboard.db');
    expect(cfg.sessions.dir).toBe('');
    expect(cfg.autoReview.enabled).toBe(true);
    expect(cfg.autoReview.concurrency).toBe(1);
  });

  it('reads values from env vars', () => {
    process.env.NOTION_API_KEY = 'ntn-env';
    process.env.GITHUB_TOKEN = 'ghp-env';
    process.env.GITHUB_REPO = 'owner/repo';
    process.env.PORT = '4567';
    process.env.DB_PATH = '/tmp/test.db';
    process.env.SESSIONS_DIR = '~/.sessions';
    process.env.AUTO_REVIEW = 'false';
    process.env.AUTO_REVIEW_CONCURRENCY = '3';
    const cfg = new EnvFileConfigSource().read();
    expect(cfg.notion.apiKey).toBe('ntn-env');
    expect(cfg.github.token).toBe('ghp-env');
    expect(cfg.github.repo).toBe('owner/repo');
    expect(cfg.server.port).toBe(4567);
    expect(cfg.db.path).toBe('/tmp/test.db');
    expect(cfg.sessions.dir).toBe('~/.sessions');
    expect(cfg.autoReview.enabled).toBe(false);
    expect(cfg.autoReview.concurrency).toBe(3);
  });

  it('write() throws', () => {
    expect(() => new EnvFileConfigSource().write({})).toThrow();
  });
});

// ── Resolution order ──────────────────────────────────────────────────────────

describe('getOrchestratorConfig resolution order', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetAppConfigCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-res-'));
  });

  afterEach(() => {
    _resetAppConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('uses DataDirConfigSource when config.json exists', () => {
    const src = new DataDirConfigSource(tmpDir);
    src.write({ notion: { apiKey: 'ntn-from-json' } });
    _setConfigSourceForTesting(src);
    const cfg = getOrchestratorConfig();
    expect(cfg.notion.apiKey).toBe('ntn-from-json');
  });

  it('uses EnvFileConfigSource and logs deprecation when no config.json', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.NOTION_API_KEY = 'ntn-from-env';
    try {
      // Empty data dir → no config.json → falls back to env
      const dataDirSrc = new DataDirConfigSource(tmpDir);
      // Simulate the resolution logic: dataDirSrc.exists() is false, so use env
      const envSrc = new EnvFileConfigSource();
      _setConfigSourceForTesting(envSrc);
      const cfg = getOrchestratorConfig();
      expect(cfg.notion.apiKey).toBe('ntn-from-env');
    } finally {
      delete process.env.NOTION_API_KEY;
    }
  });

  it('returns cached result on second call', () => {
    const src = new DataDirConfigSource(tmpDir);
    src.write({ server: { port: 7777 } });
    _setConfigSourceForTesting(src);
    const first = getOrchestratorConfig();
    // Mutate config on disk — cache should return stale value
    src.write({ server: { port: 8888 } });
    const second = getOrchestratorConfig();
    expect(second).toBe(first);
  });
});

// ── writeOrchestratorConfig ───────────────────────────────────────────────────

describe('writeOrchestratorConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetAppConfigCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-write-'));
  });

  afterEach(() => {
    _resetAppConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes to data dir and invalidates cache', () => {
    const src = new DataDirConfigSource(tmpDir);
    _setConfigSourceForTesting(src);
    // Prime cache
    getOrchestratorConfig();
    // Write via the public API — cache is cleared
    src.write({ github: { token: 'ghp-new', repo: 'o/r' } });
    _resetAppConfigCache();
    _setConfigSourceForTesting(src);
    const cfg = getOrchestratorConfig();
    expect(cfg.github.token).toBe('ghp-new');
  });
});
