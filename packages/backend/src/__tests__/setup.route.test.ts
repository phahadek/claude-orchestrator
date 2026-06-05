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
}));

vi.mock('../config/dataDir.js', () => ({
  getDataDir: vi.fn(() => os.tmpdir()),
}));

// Static imports — Vitest resolves these through the mocks above
import setupRouter, { isSetupRequired } from '../routes/setup.js';
import { countProjects } from '../db/queries.js';
import { getDataDir } from '../config/dataDir.js';
import {
  DataDirConfigSource,
  CONFIG_DEFAULTS,
} from '../config/DataDirConfigSource.js';
import {
  _setConfigSourceForTesting,
  _resetAppConfigCache,
} from '../config/appConfig.js';

const mockedCountProjects = countProjects as MockedFunction<
  typeof countProjects
>;
const mockedGetDataDir = getDataDir as MockedFunction<typeof getDataDir>;

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

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-setup-'));
    mockedGetDataDir.mockReturnValue(tmpDir);
    // The status route now reads the resolved config (config.json → .env fallback),
    // so drive it through the app-config override pointed at this test's data dir.
    _setConfigSourceForTesting(new DataDirConfigSource(tmpDir));
    mockedCountProjects.mockReturnValue(0);
  });

  afterEach(() => {
    _resetAppConfigCache();
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
    _setConfigSourceForTesting({ read: () => CONFIG_DEFAULTS, write: () => {} });
    mockedCountProjects.mockReturnValue(0);
    expect(isSetupRequired()).toBe(true);
  });
});

// ── GET /api/setup/env-check ──────────────────────────────────────────────────

describe('GET /api/setup/env-check', () => {
  it('returns claudeInstalled and gitInstalled booleans', async () => {
    const res = await supertest(buildApp()).get('/api/setup/env-check');
    expect(res.status).toBe(200);
    expect(typeof res.body.claudeInstalled).toBe('boolean');
    expect(typeof res.body.gitInstalled).toBe('boolean');
    expect(typeof res.body.claudeAuthenticated).toBe('boolean');
  });

  it('reports claudeAuthenticated=false when credentials file is absent', async () => {
    const fakeAppData = fs.mkdtempSync(
      path.join(os.tmpdir(), 'oc-appdata-empty-'),
    );
    const origAppData = process.env.APPDATA;
    process.env.APPDATA = fakeAppData;
    try {
      const res = await supertest(buildApp()).get('/api/setup/env-check');
      expect(res.status).toBe(200);
      // With a fresh dir that has no credentials file, claudeAuthenticated must be false
      expect(res.body.claudeAuthenticated).toBe(false);
    } finally {
      if (origAppData !== undefined) process.env.APPDATA = origAppData;
      else delete process.env.APPDATA;
      fs.rmSync(fakeAppData, { recursive: true, force: true });
    }
  });

  it('reports claudeAuthenticated=true when credentials file has a token', async () => {
    const fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-appdata-'));
    const claudeDir = path.join(fakeAppData, 'Claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauthToken: 'tok-abc123' }),
      'utf8',
    );
    const origAppData = process.env.APPDATA;
    process.env.APPDATA = fakeAppData;
    try {
      const res = await supertest(buildApp()).get('/api/setup/env-check');
      expect(res.status).toBe(200);
      // If claude is installed on the machine, authenticated must be true.
      // If it's not installed (e.g. CI without claude), claudeAuthenticated
      // would be false because the guard `claudeInstalled ? ... : false`.
      // We assert conditionally so CI passes even without claude installed.
      if (res.body.claudeInstalled) {
        expect(res.body.claudeAuthenticated).toBe(true);
      }
    } finally {
      if (origAppData !== undefined) process.env.APPDATA = origAppData;
      else delete process.env.APPDATA;
      fs.rmSync(fakeAppData, { recursive: true, force: true });
    }
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

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-import-'));
    mockedGetDataDir.mockReturnValue(tmpDir);
  });

  afterEach(() => {
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
      .send({ path: path.join(tmpDir, 'missing.env') });
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

    // Verify config.json was written correctly
    const src = new DataDirConfigSource(tmpDir);
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
});
