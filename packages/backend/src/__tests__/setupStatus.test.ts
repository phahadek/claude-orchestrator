import { describe, it, expect, vi, beforeEach } from 'vitest';

// Prevent config.ts module-level getOrchestratorConfig() call from crashing
vi.mock('../config.js', () => ({
  config: {
    notionApiKey: '',
    sqlitePath: ':memory:',
    port: 3001,
    projectDir: '/tmp',
    claudePath: 'claude',
    maxConcurrentCodeSessions: 20,
    anthropicApiKey: '',
  },
  GITHUB_TOKEN: '',
  GITHUB_REPO: '',
  resolveClaudePath: vi.fn(() => 'claude'),
  normalizePath: vi.fn((p: string) => p),
}));

vi.mock('../config/appConfig.js', () => ({
  getOrchestratorConfig: vi.fn(),
}));

vi.mock('../db/queries.js', () => ({
  countProjects: vi.fn(),
  getPRByNumber: vi.fn(),
}));

vi.mock('../github/GitHubClient.js', () => ({
  GitHubClient: { probe: vi.fn() },
}));
vi.mock('../github/types.js', () => ({
  GitHubApiError: class GitHubApiError extends Error {},
}));
vi.mock('../notion/NotionClient.js', () => ({ probeNotionToken: vi.fn() }));
vi.mock('../notion/types.js', () => ({
  NotionApiError: class NotionApiError extends Error {},
}));
vi.mock('../tasks/JiraClient.js', () => ({
  JiraClient: { probe: vi.fn() },
  JiraApiError: class JiraApiError extends Error {},
}));
vi.mock('../config/DataDirConfigSource.js', () => ({
  DataDirConfigSource: class {
    write = vi.fn();
  },
}));
vi.mock('../config/credentialsPath.js', () => ({
  claudeCredentialsPath: vi.fn().mockReturnValue(''),
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getOrchestratorConfig } from '../config/appConfig.js';
import { countProjects } from '../db/queries.js';
import { computeSetupStatus, isSetupRequired } from '../routes/setup.js';

type CfgStub = {
  setupComplete: boolean;
  github: { token: string; repo: string };
  notion: { apiKey: string };
  db: { path: string };
  server: { port: number };
};

function stubCfg(
  overrides: Partial<{
    setupComplete: boolean;
    githubToken: string;
    notionKey: string;
  }> = {},
): CfgStub {
  return {
    setupComplete: overrides.setupComplete ?? false,
    github: { token: overrides.githubToken ?? '', repo: '' },
    notion: { apiKey: overrides.notionKey ?? '' },
    db: { path: ':memory:' },
    server: { port: 3001 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(countProjects).mockReturnValue(1);
});

describe('computeSetupStatus / isSetupRequired — table-driven', () => {
  const cases: Array<{
    label: string;
    setupComplete: boolean;
    githubToken: string;
    notionKey: string;
    projectCount: number;
    expectedSetupNeeded: boolean;
    missingIncludes?: string[];
    missingExcludes?: string[];
  }> = [
    {
      label:
        'setupComplete=true suppresses wizard even with no token/notion/projects',
      setupComplete: true,
      githubToken: '',
      notionKey: '',
      projectCount: 0,
      expectedSetupNeeded: false,
      missingIncludes: ['github.token', 'notion.apiKey', 'project'],
    },
    {
      label: 'setupComplete=true suppresses wizard even with no github token',
      setupComplete: true,
      githubToken: '',
      notionKey: 'nk',
      projectCount: 1,
      expectedSetupNeeded: false,
    },
    {
      label: 'setupComplete=true suppresses wizard even with no notion key',
      setupComplete: true,
      githubToken: 'tok',
      notionKey: '',
      projectCount: 1,
      expectedSetupNeeded: false,
      missingIncludes: ['notion.apiKey'],
    },
    {
      label:
        'genuine first run (no setupComplete, no token, no projects) shows wizard',
      setupComplete: false,
      githubToken: '',
      notionKey: '',
      projectCount: 0,
      expectedSetupNeeded: true,
    },
    {
      label:
        'notion.apiKey absent alone does NOT trigger wizard when token+projects present',
      setupComplete: false,
      githubToken: 'tok',
      notionKey: '',
      projectCount: 1,
      expectedSetupNeeded: false,
      missingIncludes: ['notion.apiKey'],
    },
    {
      label: 'notion.apiKey absent + no github token still triggers wizard',
      setupComplete: false,
      githubToken: '',
      notionKey: '',
      projectCount: 1,
      expectedSetupNeeded: true,
      missingIncludes: ['github.token', 'notion.apiKey'],
    },
    {
      label:
        'YAML/corporate: no notion key, has token + project — wizard stays away',
      setupComplete: false,
      githubToken: 'ghp_tok',
      notionKey: '',
      projectCount: 2,
      expectedSetupNeeded: false,
      missingIncludes: ['notion.apiKey'],
      missingExcludes: ['github.token', 'project'],
    },
    {
      label:
        'fully configured setup without setupComplete returns setupNeeded:false',
      setupComplete: false,
      githubToken: 'tok',
      notionKey: 'nk',
      projectCount: 1,
      expectedSetupNeeded: false,
    },
  ];

  for (const tc of cases) {
    it(tc.label, () => {
      vi.mocked(getOrchestratorConfig).mockReturnValue(
        stubCfg({
          setupComplete: tc.setupComplete,
          githubToken: tc.githubToken,
          notionKey: tc.notionKey,
        }) as never,
      );
      vi.mocked(countProjects).mockReturnValue(tc.projectCount);

      const status = computeSetupStatus();
      expect(status.setupNeeded).toBe(tc.expectedSetupNeeded);

      for (const key of tc.missingIncludes ?? []) {
        expect(status.missing).toContain(key);
      }
      for (const key of tc.missingExcludes ?? []) {
        expect(status.missing).not.toContain(key);
      }

      // isSetupRequired must always agree with computeSetupStatus
      expect(isSetupRequired()).toBe(tc.expectedSetupNeeded);
    });
  }
});

describe('computeSetupStatus — DB error on first boot', () => {
  it('treats DB error as project missing (triggers wizard on first run)', () => {
    vi.mocked(getOrchestratorConfig).mockReturnValue(
      stubCfg({ setupComplete: false, githubToken: '' }) as never,
    );
    vi.mocked(countProjects).mockImplementation(() => {
      throw new Error('DB not ready');
    });

    const { setupNeeded, missing } = computeSetupStatus();
    expect(setupNeeded).toBe(true);
    expect(missing).toContain('project');
  });

  it('DB error with setupComplete=true still returns setupNeeded:false', () => {
    vi.mocked(getOrchestratorConfig).mockReturnValue(
      stubCfg({ setupComplete: true }) as never,
    );
    vi.mocked(countProjects).mockImplementation(() => {
      throw new Error('DB not ready');
    });

    const { setupNeeded } = computeSetupStatus();
    expect(setupNeeded).toBe(false);
  });
});
