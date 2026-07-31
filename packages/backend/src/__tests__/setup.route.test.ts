import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockedFunction,
} from 'vitest';
import express from 'express';
import supertest from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Mocks (hoisted before all imports) ───────────────────────────────────────

vi.mock('../db/queries.js', () => ({
  countProjects: vi.fn().mockReturnValue(0),
  upsertTaskCache: vi.fn(),
  getCacheAge: vi.fn().mockReturnValue(Infinity),
  getTaskCache: vi.fn().mockReturnValue(null),
  getDeviceByToken: vi.fn().mockReturnValue(null),
  updateDeviceLastSeen: vi.fn(),
  getActiveDeviceCount: vi.fn().mockReturnValue(0),
}));

vi.mock('../config/credentialsPath.js', () => ({
  claudeCredentialsPath: vi.fn(),
}));

// Static imports — Vitest resolves these through the mocks above
import setupRouter, {
  isSetupRequired,
  requireSetupAccess,
  _setEnvImportRootsForTesting,
} from '../routes/setup.js';
import { countProjects, getActiveDeviceCount } from '../db/queries.js';
import { claudeCredentialsPath } from '../config/credentialsPath.js';
import {
  DataDirConfigSource,
  CONFIG_DEFAULTS,
} from '../config/DataDirConfigSource.js';
import {
  _setConfigSourceForTesting,
  _resetAppConfigCache,
  getOrchestratorConfig,
} from '../config/appConfig.js';

const mockedCountProjects = countProjects as MockedFunction<
  typeof countProjects
>;
const mockedGetActiveDeviceCount = getActiveDeviceCount as MockedFunction<
  typeof getActiveDeviceCount
>;
const mockedClaudeCredentialsPath = claudeCredentialsPath as MockedFunction<
  typeof claudeCredentialsPath
>;

// ── Test app ─────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', setupRouter);
  return app;
}

// ── GET /api/setup/status ─────────────────────────────────────────────────────

describe('GET /api/setup/status', () => {
  let tmpDir: string;
  let prevXdgDataHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-setup-'));
    // writeOrchestratorConfig() always targets the real data dir (see its
    // doc comment in appConfig.ts) — a getDataDir mock never reaches it, and
    // by the time this file's vi.mock hoisting runs, testSetupDb.ts (an
    // earlier-running Vitest setupFile) has already resolved appConfig.ts's
    // own unmocked getDataDir import (see logger.test.ts for the same
    // pitfall). Point the REAL data dir at this tmp dir instead.
    prevXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = tmpDir;
    // The status route now reads the resolved config (config.json → .env fallback),
    // so drive it through the app-config override pointed at this test's data dir.
    _setConfigSourceForTesting(new DataDirConfigSource(tmpDir));
    mockedCountProjects.mockReturnValue(0);
  });

  afterEach(() => {
    _resetAppConfigCache();
    if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdgDataHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('reports setupNeeded=true with all missing sections when no config exists', async () => {
    const res = await supertest(buildApp()).get('/api/setup/status');
    expect(res.status).toBe(200);
    expect(res.body.setupNeeded).toBe(true);
    expect(res.body.missing).toContain('github.token');
    expect(res.body.missing).toContain('notion.apiKey');
    expect(res.body.missing).toContain('project');
  });

  it('reports setupNeeded=false when all required values are present', async () => {
    const src = new DataDirConfigSource(tmpDir);
    src.write({
      github: { token: 'ghp-ok', repo: '' },
      notion: { apiKey: 'ntn-ok' },
    });
    mockedCountProjects.mockReturnValue(1);

    const res = await supertest(buildApp()).get('/api/setup/status');
    expect(res.status).toBe(200);
    expect(res.body.setupNeeded).toBe(false);
    expect(res.body.missing).toHaveLength(0);
  });

  it('reports missing github.token when token is empty', async () => {
    const src = new DataDirConfigSource(tmpDir);
    src.write({ notion: { apiKey: 'ntn-ok' } });
    mockedCountProjects.mockReturnValue(1);

    const res = await supertest(buildApp()).get('/api/setup/status');
    expect(res.body.missing).toContain('github.token');
    expect(res.body.missing).not.toContain('notion.apiKey');
  });
});

// ── Setup writes invalidate the config cache (no restart required) ────────────

describe('setup writes bust the config cache', () => {
  let tmpDir: string;
  let prevXdgDataHome: string | undefined;
  // Before config.json exists, resolve() falls back to EnvFileConfigSource,
  // which reads these directly off process.env — an inherited GITHUB_TOKEN /
  // NOTION_API_KEY (e.g. exported in a dev's shell, or set for this session's
  // own `gh` CLI use) would make the "missing" assertions below false
  // negatives. Clear them for the duration of this block.
  const ENV_KEYS = ['GITHUB_TOKEN', 'NOTION_API_KEY', 'GITHUB_REPO'] as const;
  const prevEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-setup-cache-'));
    // No _setConfigSourceForTesting override here: these tests exercise
    // writeOrchestratorConfig() (via the setup routes), which always targets
    // the real data dir and ignores any source override — so reads must go
    // through the same real (XDG_DATA_HOME-derived) path via the default
    // resolve(), not a tmpDir-literal override that the writes never reach.
    prevXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = tmpDir;
    // POST /setup/import (tested below) writes its .env fixture under
    // tmpDir, outside the default permitted import roots — allow it.
    _setEnvImportRootsForTesting([tmpDir]);
    for (const key of ENV_KEYS) {
      prevEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    _setEnvImportRootsForTesting(null);
    _resetAppConfigCache();
    if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdgDataHome;
    for (const key of ENV_KEYS) {
      if (prevEnv[key] === undefined) delete process.env[key];
      else process.env[key] = prevEnv[key];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('POST /setup/complete makes GET /setup/status report setupNeeded=false without a restart', async () => {
    // Prime the cache with the pre-complete config, as the running process would have.
    const before = await supertest(buildApp()).get('/api/setup/status');
    expect(before.body.setupNeeded).toBe(true);

    const app = buildApp();
    const complete = await supertest(app).post('/api/setup/complete');
    expect(complete.status).toBe(200);
    expect(complete.body.ok).toBe(true);

    const after = await supertest(app).get('/api/setup/status');
    expect(after.body.setupNeeded).toBe(false);
  });

  it('POST /setup/save-credentials makes getOrchestratorConfig() reflect the new tokens without a restart', async () => {
    // Prime the cache with the pre-save config.
    const primed = await supertest(buildApp()).get('/api/setup/status');
    expect(primed.body.missing).toContain('github.token');
    expect(primed.body.missing).toContain('notion.apiKey');

    const res = await supertest(buildApp())
      .post('/api/setup/save-credentials')
      .send({
        githubToken: 'ghp-saved',
        notionApiKey: 'ntn-saved',
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const cfg = getOrchestratorConfig();
    expect(cfg.github.token).toBe('ghp-saved');
    expect(cfg.notion.apiKey).toBe('ntn-saved');
  });

  it('POST /setup/import makes getOrchestratorConfig() reflect imported values without a restart', async () => {
    const envFile = path.join(tmpDir, '.env');
    fs.writeFileSync(
      envFile,
      ['GITHUB_TOKEN=ghp-from-import', 'NOTION_API_KEY=ntn-from-import'].join(
        '\n',
      ),
      'utf8',
    );

    // Prime the cache with the pre-import config.
    const primed = await supertest(buildApp()).get('/api/setup/status');
    expect(primed.body.missing).toContain('github.token');

    const res = await supertest(buildApp())
      .post('/api/setup/import')
      .send({ path: envFile });
    expect(res.status).toBe(200);

    const cfg = getOrchestratorConfig();
    expect(cfg.github.token).toBe('ghp-from-import');
    expect(cfg.notion.apiKey).toBe('ntn-from-import');
  });
});

// ── POST /setup/complete validation ────────────────────────────────────────────
// Regression for the 2026-07-30 outage: setupComplete was previously stamped
// on any payload, including a config holding "owner/repo" and a 5-character
// token. /setup/complete must now refuse to bless a config that can't work.

describe('POST /setup/complete validation', () => {
  let tmpDir: string;
  let prevXdgDataHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-setup-complete-'));
    // The getDataDir mock never actually reaches writeOrchestratorConfig()
    // (see the other describe blocks in this file) — point the real data
    // dir at this tmp dir so the real write path stays isolated too.
    prevXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = tmpDir;
    // No _setConfigSourceForTesting override: /setup/complete's write
    // (writeOrchestratorConfig) and its own db.path writability check
    // (getDataDir()) both always target the real (XDG_DATA_HOME-derived)
    // data dir — a tmpDir-literal override would desync reads from writes.
    // Constructing a real DataDirConfigSource() creates that dir as a
    // side effect, which the writability check needs to already exist.
    new DataDirConfigSource();
  });

  afterEach(() => {
    _resetAppConfigCache();
    if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdgDataHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('rejects a placeholder-shaped github.repo', async () => {
    const src = new DataDirConfigSource();
    src.write({
      github: { token: 'ghp-real-1234567890', repo: 'owner/repo' },
    });

    const res = await supertest(buildApp()).post('/api/setup/complete');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_config');
    expect(res.body.problems.join(' ')).toMatch(/owner\/repo/);

    expect(getOrchestratorConfig().setupComplete).toBe(false);
  });

  it('rejects an obviously-too-short github.token', async () => {
    const src = new DataDirConfigSource();
    src.write({ github: { token: 'ghp-x', repo: 'real-owner/real-repo' } });

    const res = await supertest(buildApp()).post('/api/setup/complete');
    expect(res.status).toBe(400);
    expect(res.body.problems.join(' ')).toMatch(/github\.token/);
  });

  it('rejects an obviously-too-short notion.apiKey', async () => {
    const src = new DataDirConfigSource();
    src.write({
      github: { token: 'ghp-real-1234567890', repo: 'real-owner/real-repo' },
      notion: { apiKey: 'ntn-1' },
    });

    const res = await supertest(buildApp()).post('/api/setup/complete');
    expect(res.status).toBe(400);
    expect(res.body.problems.join(' ')).toMatch(/notion\.apiKey/);
  });

  it('rejects a db.path whose directory is not writable', async () => {
    const src = new DataDirConfigSource();
    src.write({
      github: { token: 'ghp-real-1234567890', repo: 'real-owner/real-repo' },
      db: { path: '/nonexistent-dir-xyz/dashboard.db' },
    });

    const res = await supertest(buildApp()).post('/api/setup/complete');
    expect(res.status).toBe(400);
    expect(res.body.problems.join(' ')).toMatch(/db\.path/);
  });

  it('genuine first-run (real-looking credentials, writable db path) completes successfully', async () => {
    const src = new DataDirConfigSource();
    src.write({
      github: { token: 'ghp-real-1234567890', repo: 'real-owner/real-repo' },
    });

    const res = await supertest(buildApp()).post('/api/setup/complete');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(getOrchestratorConfig().setupComplete).toBe(true);
  });

  it('does not block first-run when notion.apiKey and db.path are left unset', async () => {
    const src = new DataDirConfigSource();
    src.write({
      github: { token: 'ghp-real-1234567890', repo: 'real-owner/real-repo' },
    });
    // db.path/notion.apiKey untouched — defaults apply, must not be treated as placeholders.
    expect(src.read().notion.apiKey).toBe('');

    const res = await supertest(buildApp()).post('/api/setup/complete');
    expect(res.status).toBe(200);
  });
});

// ── isSetupRequired — legacy .env fallback regression ─────────────────────────

describe('isSetupRequired (legacy .env / resolved-config regression)', () => {
  afterEach(() => {
    _resetAppConfigCache();
    vi.clearAllMocks();
  });

  it('does NOT require setup when the resolved config carries a github token and projects exist (legacy .env mode)', () => {
    // Regression: isSetupRequired previously read config.json directly and ignored
    // the .env fallback, wrongly gating every legacy dev install behind the wizard
    // (TypeError: projects.find is not a function on the dashboard).
    _setConfigSourceForTesting({
      read: () => ({
        ...CONFIG_DEFAULTS,
        github: { ...CONFIG_DEFAULTS.github, token: 'ghp-from-env' },
      }),
      write: () => {},
    });
    mockedCountProjects.mockReturnValue(3);
    expect(isSetupRequired()).toBe(false);
  });

  it('requires setup when no source provides a github token', () => {
    _setConfigSourceForTesting({
      read: () => CONFIG_DEFAULTS,
      write: () => {},
    });
    mockedCountProjects.mockReturnValue(0);
    expect(isSetupRequired()).toBe(true);
  });
});

// ── GET /api/setup/env-check ──────────────────────────────────────────────────

describe('GET /api/setup/env-check', () => {
  let tmpDir: string;
  const origApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-creds-'));
    delete process.env.ANTHROPIC_API_KEY;
    // Default: no credentials file at the mocked path
    mockedClaudeCredentialsPath.mockReturnValue(
      path.join(tmpDir, '.credentials.json'),
    );
  });

  afterEach(() => {
    if (origApiKey !== undefined) process.env.ANTHROPIC_API_KEY = origApiKey;
    else delete process.env.ANTHROPIC_API_KEY;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('returns claudeInstalled and gitInstalled booleans', async () => {
    const res = await supertest(buildApp()).get('/api/setup/env-check');
    expect(res.status).toBe(200);
    expect(typeof res.body.claudeInstalled).toBe('boolean');
    expect(typeof res.body.gitInstalled).toBe('boolean');
    expect(typeof res.body.claudeAuthenticated).toBe('boolean');
  });

  it('reports claudeAuthenticated=false when credentials file is absent', async () => {
    const res = await supertest(buildApp()).get('/api/setup/env-check');
    expect(res.status).toBe(200);
    expect(res.body.claudeAuthenticated).toBe(false);
  });

  it('reports claudeAuthenticated=true with claudeAiOauth bundle (real credential shape)', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.credentials.json'),
      JSON.stringify({
        mcpOAuth: {},
        claudeAiOauth: { accessToken: 'tok-abc', expiresAt: 9999999999 },
      }),
      'utf8',
    );
    // claudeAuthenticated is only checked when claudeInstalled=true, so test
    // isClaudeAuthenticated logic directly via the helper that the route uses.
    // Since claudeInstalled depends on the real host, check conditionally.
    const res = await supertest(buildApp()).get('/api/setup/env-check');
    expect(res.status).toBe(200);
    if (res.body.claudeInstalled) {
      expect(res.body.claudeAuthenticated).toBe(true);
    }
  });

  it('reports claudeAuthenticated=true with back-compat claudeAiOauthToken string', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauthToken: 'tok-legacy' }),
      'utf8',
    );
    const res = await supertest(buildApp()).get('/api/setup/env-check');
    expect(res.status).toBe(200);
    if (res.body.claudeInstalled) {
      expect(res.body.claudeAuthenticated).toBe(true);
    }
  });

  it('reports claudeAuthenticated=true when ANTHROPIC_API_KEY is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const res = await supertest(buildApp()).get('/api/setup/env-check');
    expect(res.status).toBe(200);
    if (res.body.claudeInstalled) {
      expect(res.body.claudeAuthenticated).toBe(true);
    }
  });

  it('regression: claudeAiOauth object shape does not produce false negative', async () => {
    // This is the exact shape that caused the false negative bug on Windows.
    fs.writeFileSync(
      path.join(tmpDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'tok', tokenType: 'Bearer' },
      }),
      'utf8',
    );
    const res = await supertest(buildApp()).get('/api/setup/env-check');
    expect(res.status).toBe(200);
    if (res.body.claudeInstalled) {
      expect(res.body.claudeAuthenticated).toBe(true);
    }
  });

  it('reports claudeAuthenticated=false for empty claudeAiOauth', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: null }),
      'utf8',
    );
    const res = await supertest(buildApp()).get('/api/setup/env-check');
    expect(res.status).toBe(200);
    expect(res.body.claudeAuthenticated).toBe(false);
  });
});

// ── POST /api/setup/validate ──────────────────────────────────────────────────

describe('POST /api/setup/validate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns 400 for unknown type', async () => {
    const res = await supertest(buildApp())
      .post('/api/setup/validate')
      .send({ type: 'jira', token: 'tok' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when token is missing', async () => {
    const res = await supertest(buildApp())
      .post('/api/setup/validate')
      .send({ type: 'github' });
    expect(res.status).toBe(400);
  });

  it('returns valid=true for a good GitHub PAT', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ login: 'octocat' }), { status: 200 }),
        ),
    );

    const res = await supertest(buildApp())
      .post('/api/setup/validate')
      .send({ type: 'github', token: 'ghp-good' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.message).toContain('octocat');
  });

  it('returns valid=false for a bad GitHub PAT', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 })),
    );

    const res = await supertest(buildApp())
      .post('/api/setup/validate')
      .send({ type: 'github', token: 'ghp-bad' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.message).toContain('401');
  });

  it('returns valid=true for a good Notion token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ name: 'Test Bot', type: 'bot' }), {
          status: 200,
        }),
      ),
    );

    const res = await supertest(buildApp())
      .post('/api/setup/validate')
      .send({ type: 'notion', token: 'ntn-good' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it('returns valid=false for a bad Notion token', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 })),
    );

    const res = await supertest(buildApp())
      .post('/api/setup/validate')
      .send({ type: 'notion', token: 'ntn-bad' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.message).toContain('401');
  });
});

// ── POST /api/setup/import ────────────────────────────────────────────────────

describe('POST /api/setup/import', () => {
  let tmpDir: string;
  let prevXdgDataHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-import-'));
    // Treat tmpDir as the sole permitted root so existing fixtures (which
    // live under os.tmpdir(), not the real home dir) stay under bounds.
    _setEnvImportRootsForTesting([tmpDir]);
    // writeOrchestratorConfig() always targets the real data dir (see its
    // doc comment in appConfig.ts) — the getDataDir mock above never reaches
    // it, since testSetupDb.ts (an earlier-running Vitest setupFile) has
    // already resolved appConfig.ts's own unmocked getDataDir import (see
    // logger.test.ts for the same pitfall). Point the REAL data dir at this
    // tmp dir instead.
    prevXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = tmpDir;
  });

  afterEach(() => {
    _setEnvImportRootsForTesting(null);
    _resetAppConfigCache();
    if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdgDataHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('returns 400 when path is missing', async () => {
    const res = await supertest(buildApp()).post('/api/setup/import').send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 when the .env file does not exist', async () => {
    const res = await supertest(buildApp())
      .post('/api/setup/import')
      .send({ path: path.join(tmpDir, 'nested', '.env') });
    expect(res.status).toBe(404);
  });

  it('imports env keys into config.json sections', async () => {
    const envFile = path.join(tmpDir, '.env');
    fs.writeFileSync(
      envFile,
      [
        'NOTION_API_KEY=ntn-imported',
        'GITHUB_TOKEN=ghp-imported',
        'GITHUB_REPO=owner/repo',
        '# a comment',
        '',
        'PORT=4567',
      ].join('\n'),
      'utf8',
    );

    const res = await supertest(buildApp())
      .post('/api/setup/import')
      .send({ path: envFile });

    expect(res.status).toBe(200);
    expect(res.body.imported).toContain('notion.apiKey');
    expect(res.body.imported).toContain('github.token');
    expect(res.body.imported).toContain('github.repo');
    expect(res.body.imported).toContain('server.port');
    expect(res.body.dbFound).toBe(false);

    // Verify config.json was written correctly. writeOrchestratorConfig()
    // always targets the real (XDG_DATA_HOME-derived) data dir, which
    // appends a 'claude-orchestrator' subdir onto tmpDir — read from there,
    // not from tmpDir directly.
    const src = new DataDirConfigSource();
    const cfg = src.read();
    expect(cfg.notion.apiKey).toBe('ntn-imported');
    expect(cfg.github.token).toBe('ghp-imported');
    expect(cfg.github.repo).toBe('owner/repo');
    expect(cfg.server.port).toBe(4567);
  });

  it('reports dbFound=true when dashboard.db exists next to the .env', async () => {
    const envDir = path.join(tmpDir, 'legacy');
    fs.mkdirSync(envDir);
    fs.writeFileSync(path.join(envDir, '.env'), 'GITHUB_TOKEN=ghp-x\n', 'utf8');
    fs.writeFileSync(path.join(envDir, 'dashboard.db'), '', 'utf8');

    const res = await supertest(buildApp())
      .post('/api/setup/import')
      .send({ path: path.join(envDir, '.env') });

    expect(res.status).toBe(200);
    expect(res.body.dbFound).toBe(true);
    expect(res.body.dbPath).toContain('dashboard.db');
  });

  it('rejects a path outside the permitted (home) directory', async () => {
    // homedir() is mocked to tmpDir above — a file elsewhere on disk (e.g.
    // under a sibling tmp dir) must be rejected, and the file must exist so
    // this proves the rejection is the path bound, not the 404 branch.
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-outside-'));
    const outsideFile = path.join(outsideDir, '.env');
    fs.writeFileSync(outsideFile, 'GITHUB_TOKEN=ghp-outside\n', 'utf8');

    try {
      const res = await supertest(buildApp())
        .post('/api/setup/import')
        .send({ path: outsideFile });

      expect(res.status).toBe(400);
      // The response must not disclose the rejected file's contents.
      expect(JSON.stringify(res.body)).not.toContain('ghp-outside');

      const cfg = getOrchestratorConfig();
      expect(cfg.github.token).not.toBe('ghp-outside');
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects a file not literally named .env, even under the permitted root', async () => {
    const disguisedFile = path.join(tmpDir, 'id_rsa');
    fs.writeFileSync(disguisedFile, 'SECRET_KEY_MATERIAL\n', 'utf8');

    const res = await supertest(buildApp())
      .post('/api/setup/import')
      .send({ path: disguisedFile });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('SECRET_KEY_MATERIAL');
  });

  it('rejects a path that escapes the permitted root via traversal', async () => {
    const res = await supertest(buildApp())
      .post('/api/setup/import')
      .send({ path: path.join(tmpDir, '..', '.env') });

    expect(res.status).toBe(400);
  });
});

// ── Setup write endpoints — auth required once setup is complete ──────────────

describe('setup write endpoints reject unauthenticated requests once setup is complete', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-setup-complete-'));
    const src = new DataDirConfigSource(tmpDir);
    src.write({
      github: { token: 'ghp-existing', repo: '' },
      notion: { apiKey: 'ntn-existing' },
      setupComplete: true,
    });
    _setConfigSourceForTesting(src);
    // A device is enrolled — requireDeviceAuth's own bootstrap fallback (for
    // zero enrolled devices) must not be what's carrying this test.
    mockedGetActiveDeviceCount.mockReturnValue(1);
  });

  afterEach(() => {
    _resetAppConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('rejects POST /setup/save-credentials without a device token and writes nothing', async () => {
    const res = await supertest(buildApp())
      .post('/api/setup/save-credentials')
      .send({ githubToken: 'ghp-attacker', notionApiKey: 'ntn-attacker' });

    expect(res.status).toBe(401);
    const cfg = new DataDirConfigSource(tmpDir).read();
    expect(cfg.github.token).toBe('ghp-existing');
    expect(cfg.notion.apiKey).toBe('ntn-existing');
  });

  it('rejects POST /setup/complete without a device token', async () => {
    const res = await supertest(buildApp()).post('/api/setup/complete');
    expect(res.status).toBe(401);
  });

  it('rejects POST /setup/import without a device token and writes nothing', async () => {
    const envFile = path.join(tmpDir, '.env');
    fs.writeFileSync(envFile, 'GITHUB_TOKEN=ghp-attacker\n', 'utf8');

    const res = await supertest(buildApp())
      .post('/api/setup/import')
      .send({ path: envFile });

    expect(res.status).toBe(401);
    const cfg = new DataDirConfigSource(tmpDir).read();
    expect(cfg.github.token).toBe('ghp-existing');
  });
});

// ── requireSetupAccess — setup-state and origin gating ─────────────────────────

describe('requireSetupAccess', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-setup-access-'));
    _setConfigSourceForTesting(new DataDirConfigSource(tmpDir));
    mockedGetActiveDeviceCount.mockReturnValue(0);
  });

  afterEach(() => {
    _resetAppConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function fakeReqRes(remoteAddress: string) {
    const req = {
      path: '/setup/save-credentials',
      headers: {},
      socket: { remoteAddress },
    } as unknown as import('express').Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as import('express').Response;
    const next = vi.fn();
    return { req, res, next };
  }

  it('allows a loopback request while setup is genuinely pending', () => {
    const { req, res, next } = fakeReqRes('127.0.0.1');
    requireSetupAccess(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects a non-loopback request while setup is genuinely pending', () => {
    const { req, res, next } = fakeReqRes('192.168.1.50');
    requireSetupAccess(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'setup_loopback_only' }),
    );
  });

  it('rejects an unauthenticated request once setup is complete, even from loopback', () => {
    new DataDirConfigSource(tmpDir).write({ setupComplete: true });
    mockedGetActiveDeviceCount.mockReturnValue(1);

    const { req, res, next } = fakeReqRes('127.0.0.1');
    requireSetupAccess(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('allows an authenticated request once setup is complete (falls back to requireDeviceAuth)', () => {
    new DataDirConfigSource(tmpDir).write({ setupComplete: true });
    mockedGetActiveDeviceCount.mockReturnValue(0);

    // No devices enrolled yet even though setup completed — requireDeviceAuth's
    // own bootstrap window still applies (unchanged pre-existing behavior).
    const { req, res, next } = fakeReqRes('127.0.0.1');
    requireSetupAccess(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
