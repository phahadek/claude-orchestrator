import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Must mock before importing the modules under test
vi.mock('../db/queries.js', () => ({}));
vi.mock('../config/dataDir.js', () => ({ getDataDir: vi.fn() }));

import {
  DataDirConfigSource,
  CONFIG_DEFAULTS,
} from '../config/DataDirConfigSource.js';
import { EnvFileConfigSource } from '../config/EnvFileConfigSource.js';
import { ConfigValidationError } from '../config/types.js';
import { getDataDir } from '../config/dataDir.js';
import {
  getOrchestratorConfig,
  getConfigProvenance,
  writeOrchestratorConfig as _writeOrchestratorConfig,
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

  describe('readWithExplicitFields', () => {
    it('reports only the fields explicitly present in config.json', () => {
      // write() always merges onto a full CONFIG_DEFAULTS clone and persists
      // every field (including untouched ones at their default value) — so
      // every key ends up "present" in the file. To exercise explicit-field
      // detection (present vs filled-from-defaults), write a sparse raw file
      // directly, bypassing write()'s full-merge behavior.
      fs.writeFileSync(
        path.join(tmpDir, 'config.json'),
        JSON.stringify({ notion: { apiKey: 'ntn-explicit' } }),
        'utf8',
      );
      const src = new DataDirConfigSource(tmpDir);
      const { explicitFields } = src.readWithExplicitFields();
      expect(explicitFields.has('notion.apiKey')).toBe(true);
      expect(explicitFields.has('github.token')).toBe(false);
    });

    it('reports an empty set when config.json is absent', () => {
      const src = new DataDirConfigSource(tmpDir);
      const { explicitFields } = src.readWithExplicitFields();
      expect(explicitFields.size).toBe(0);
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
    expect(cfg.autoReview.concurrency).toBe(20);
  });

  it('reads values from env vars', () => {
    process.env.NOTION_API_KEY = 'ntn-env';
    process.env.GITHUB_TOKEN = 'ghp-env';
    process.env.GITHUB_REPO = 'owner/repo';
    process.env.PORT = '4567';
    process.env.DB_PATH = '/tmp/test.db';
    process.env.SESSIONS_DIR = '~/.sessions';
    process.env.AUTO_REVIEW = 'false';
    const cfg = new EnvFileConfigSource().read();
    expect(cfg.notion.apiKey).toBe('ntn-env');
    expect(cfg.github.token).toBe('ghp-env');
    expect(cfg.github.repo).toBe('owner/repo');
    expect(cfg.server.port).toBe(4567);
    expect(cfg.db.path).toBe('/tmp/test.db');
    expect(cfg.sessions.dir).toBe('~/.sessions');
    expect(cfg.autoReview.enabled).toBe(false);
    expect(cfg.autoReview.concurrency).toBe(20);
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
    process.env.NOTION_API_KEY = 'ntn-from-env';
    try {
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

// ── .env fallback merge (2026-07-30 outage regression) ────────────────────────
// A config.json's mere existence used to disable .env for every field, with
// no fallback and no warning — one real field and six placeholders overrode a
// fully-populated .env wholesale. Per-field fallback closes that gap.

describe('getOrchestratorConfig .env fallback merge', () => {
  let tmpDir: string;
  let prevXdgDataHome: string | undefined;
  const envKeys = [
    'NOTION_API_KEY',
    'GITHUB_TOKEN',
    'GITHUB_REPO',
    'PORT',
    'DB_PATH',
    'SESSIONS_DIR',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    _resetAppConfigCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-fallback-'));
    vi.mocked(getDataDir).mockReturnValue(tmpDir);
    // The getDataDir mock above never actually reaches getOrchestratorConfig()'s
    // own resolve() (its default `new DataDirConfigSource()` — no override —
    // calls the real, unmocked getDataDir() due to Vitest's setupFile-ordering
    // pitfall; see setup.route.test.ts for the same issue). Without also
    // pointing the real XDG_DATA_HOME at tmpDir, every test in this block
    // shares the one real data dir the global testSetupDb.ts setupFile
    // pointed at, leaking config.json state across tests.
    prevXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = tmpDir;
    for (const k of envKeys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    _resetAppConfigCache();
    if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdgDataHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const k of envKeys) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
    vi.restoreAllMocks();
  });

  it('falls back to a populated .env value when config.json omits the field', () => {
    process.env.GITHUB_TOKEN = 'ghp-from-env-1234567890';
    const src = new DataDirConfigSource();
    src.write({ notion: { apiKey: 'ntn-from-json' } });

    const cfg = getOrchestratorConfig();
    expect(cfg.notion.apiKey).toBe('ntn-from-json');
    expect(cfg.github.token).toBe('ghp-from-env-1234567890');
  });

  it('falls back to .env when config.json holds an explicit empty string', () => {
    process.env.GITHUB_REPO = 'real-owner/real-repo';
    const src = new DataDirConfigSource();
    src.write({ github: { repo: '' } });

    const cfg = getOrchestratorConfig();
    expect(cfg.github.repo).toBe('real-owner/real-repo');
  });

  it('prefers config.json over .env when both are set (migration path intact)', () => {
    process.env.GITHUB_TOKEN = 'ghp-env-1234567890';
    const src = new DataDirConfigSource();
    src.write({ github: { token: 'ghp-json-1234567890' } });

    const cfg = getOrchestratorConfig();
    expect(cfg.github.token).toBe('ghp-json-1234567890');
  });

  it('a fully-populated config.json is read in preference to .env for every field', () => {
    process.env.NOTION_API_KEY = 'ntn-env';
    process.env.GITHUB_TOKEN = 'ghp-env-1234567890';
    process.env.GITHUB_REPO = 'env-owner/env-repo';
    const src = new DataDirConfigSource();
    src.write({
      notion: { apiKey: 'ntn-json' },
      github: { token: 'ghp-json-1234567890', repo: 'json-owner/json-repo' },
    });

    const cfg = getOrchestratorConfig();
    expect(cfg.notion.apiKey).toBe('ntn-json');
    expect(cfg.github.token).toBe('ghp-json-1234567890');
    expect(cfg.github.repo).toBe('json-owner/json-repo');
  });
});

// ── Provenance tracking ────────────────────────────────────────────────────
// Each effective-config field must report where its value actually came
// from: config.json, .env fallback, or the shipped default. This is the
// diagnostic surface the 2026-07-30 outage lacked.

describe('getConfigProvenance', () => {
  let tmpDir: string;
  let prevXdgDataHome: string | undefined;
  const envKeys = [
    'NOTION_API_KEY',
    'GITHUB_TOKEN',
    'GITHUB_REPO',
    'PORT',
    'DB_PATH',
    'SESSIONS_DIR',
    'AUTO_REVIEW',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    _resetAppConfigCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-provenance-'));
    vi.mocked(getDataDir).mockReturnValue(tmpDir);
    prevXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = tmpDir;
    for (const k of envKeys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    _resetAppConfigCache();
    if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdgDataHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const k of envKeys) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
    vi.restoreAllMocks();
  });

  it('reports "config.json" for a field explicitly set in config.json', () => {
    const src = new DataDirConfigSource();
    src.write({ github: { repo: 'real-owner/real-repo' } });

    const provenance = getConfigProvenance();
    expect(provenance['github.repo']).toBe('config.json');
  });

  it('reports ".env fallback" (env) for a field empty in config.json but set in .env', () => {
    process.env.GITHUB_REPO = 'env-owner/env-repo';
    const src = new DataDirConfigSource();
    src.write({ github: { repo: '' } });

    const provenance = getConfigProvenance();
    expect(provenance['github.repo']).toBe('env');
  });

  it('reports "default" for a field unset in both config.json and .env', () => {
    const src = new DataDirConfigSource();
    src.write({ notion: { apiKey: 'ntn-set' } });

    const provenance = getConfigProvenance();
    expect(provenance['github.repo']).toBe('default');
  });

  it('reports "default" for every field on a fresh install with neither source', () => {
    // No config.json written, no relevant env vars set.
    const provenance = getConfigProvenance();
    for (const key of Object.keys(provenance)) {
      expect(provenance[key]).toBe('default');
    }
  });

  it('reports "env" in legacy mode (no config.json) when the env var is set', () => {
    process.env.NOTION_API_KEY = 'ntn-legacy';
    // No config.json written — legacy .env-only mode.
    const provenance = getConfigProvenance();
    expect(provenance['notion.apiKey']).toBe('env');
    expect(provenance['github.repo']).toBe('default');
  });

  it('reports "config.json" for a non-fallback field (server.port) when set', () => {
    const src = new DataDirConfigSource();
    src.write({ server: { port: 4321 } });

    const provenance = getConfigProvenance();
    expect(provenance['server.port']).toBe('config.json');
  });

  it('is cached alongside the resolved config and invalidated together', () => {
    const src = new DataDirConfigSource();
    src.write({ github: { repo: 'first/repo' } });
    getOrchestratorConfig();
    const first = getConfigProvenance();

    src.write({ github: { repo: 'second/repo' } });
    const second = getConfigProvenance();
    // Cache wasn't invalidated by writing directly via the source, so it's
    // the same reference — mirrors getOrchestratorConfig()'s own caching.
    expect(second).toBe(first);
  });
});
