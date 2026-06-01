import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../projects/ProjectService', () => ({
  ProjectService: { getById: vi.fn() },
}));

vi.mock('../notion/NotionClient', () => ({
  NotionClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('./NotionTaskBackend', () => ({
  NotionTaskBackend: vi.fn().mockImplementation(() => ({
    type: 'notion',
    fetchReadyTasks: vi.fn(),
    attachPR: vi.fn(),
    updateStatus: vi.fn(),
    fetchTaskPage: vi.fn(),
    fetchNonMilestoneReadyTasks: vi.fn(),
    updateNotes: vi.fn(),
    appendImplementationNote: vi.fn(),
    listTasksByStatus: vi.fn(),
  })),
}));

vi.mock('./LocalTaskBackend', () => ({
  LocalTaskBackend: vi.fn().mockImplementation(() => ({
    type: 'local',
    fetchReadyTasks: vi.fn(),
    attachPR: vi.fn(),
    updateStatus: vi.fn(),
    fetchTaskPage: vi.fn(),
    fetchNonMilestoneReadyTasks: vi.fn(),
    updateNotes: vi.fn(),
    appendImplementationNote: vi.fn(),
    listTasksByStatus: vi.fn(),
  })),
}));

vi.mock('./JiraClient', () => ({
  JiraClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('./JiraTaskSourceProvider', () => ({
  JiraTaskSourceProvider: vi.fn().mockImplementation(() => ({
    type: 'jira',
    fetchReadyTasks: vi.fn(),
    attachPR: vi.fn(),
    updateStatus: vi.fn(),
    fetchTaskPage: vi.fn(),
    fetchNonMilestoneReadyTasks: vi.fn(),
    updateNotes: vi.fn(),
    appendImplementationNote: vi.fn(),
    listTasksByStatus: vi.fn(),
  })),
}));

vi.mock('./GithubTaskSourceProvider', () => ({
  GithubTaskSourceProvider: vi.fn().mockImplementation(() => ({
    type: 'github',
    fetchReadyTasks: vi.fn(),
    attachPR: vi.fn(),
    updateStatus: vi.fn(),
    fetchTaskPage: vi.fn(),
    fetchNonMilestoneReadyTasks: vi.fn(),
    updateNotes: vi.fn(),
    appendImplementationNote: vi.fn(),
    listTasksByStatus: vi.fn(),
  })),
}));

vi.mock('../github/GitHubClient', () => ({
  GitHubClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../db/queries', () => ({
  upsertTaskCache: vi.fn(),
}));

vi.mock('../config', () => ({
  JIRA_HOST: 'https://jira.example.com',
  JIRA_TOKEN: 'token',
  JIRA_EMAIL: 'user@example.com',
  GITHUB_TOKEN: 'ghtoken',
  GITHUB_REPO: 'owner/repo',
}));

import { ProjectService } from '../projects/ProjectService';
import { getTaskBackend, _resetTaskBackendCacheForTests } from './TaskBackend';
import { GithubTaskSourceProvider } from './GithubTaskSourceProvider';
import { NotionTaskBackend } from './NotionTaskBackend';
import { LocalTaskBackend } from './LocalTaskBackend';
import { JiraTaskSourceProvider } from './JiraTaskSourceProvider';

function makeProject(
  taskSource: string,
  taskSourceConfig: string | null = null,
  projectDir = '/tmp/proj',
) {
  return {
    id: 'proj-1',
    name: 'Test Project',
    taskSource,
    taskSourceConfig,
    projectDir,
    notionProjectId: null,
    repoUrl: null,
    defaultBranch: 'main',
    createdAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetTaskBackendCacheForTests();
});

describe('getTaskBackend — github source', () => {
  it('returns a GithubTaskSourceProvider when taskSource is github', () => {
    vi.mocked(ProjectService.getById).mockReturnValue(
      makeProject(
        'github',
        JSON.stringify({ owner: 'acme', repo: 'core' }),
      ) as never,
    );
    const backend = getTaskBackend('proj-1');
    expect(backend.type).toBe('github');
    expect(GithubTaskSourceProvider).toHaveBeenCalledOnce();
  });

  it('parses task_source_config JSON into owner/repo/defaultMilestone', () => {
    const config = { owner: 'acme', repo: 'core', defaultMilestone: 3 };
    vi.mocked(ProjectService.getById).mockReturnValue(
      makeProject('github', JSON.stringify(config)) as never,
    );
    getTaskBackend('proj-1');
    expect(GithubTaskSourceProvider).toHaveBeenCalledWith(
      expect.anything(),
      config,
    );
  });

  it('throws a clear error for malformed task_source_config JSON', () => {
    vi.mocked(ProjectService.getById).mockReturnValue(
      makeProject('github', '{not valid json}') as never,
    );
    expect(() => getTaskBackend('proj-1')).toThrowError(
      /malformed task_source_config JSON/,
    );
  });

  it('throws a clear error when task_source_config is null', () => {
    vi.mocked(ProjectService.getById).mockReturnValue(
      makeProject('github', null) as never,
    );
    expect(() => getTaskBackend('proj-1')).toThrowError(
      /task_source_config is required/,
    );
  });

  it('throws a clear error when owner is missing', () => {
    vi.mocked(ProjectService.getById).mockReturnValue(
      makeProject('github', JSON.stringify({ repo: 'core' })) as never,
    );
    expect(() => getTaskBackend('proj-1')).toThrowError(/missing "owner"/);
  });

  it('throws a clear error when repo is missing', () => {
    vi.mocked(ProjectService.getById).mockReturnValue(
      makeProject('github', JSON.stringify({ owner: 'acme' })) as never,
    );
    expect(() => getTaskBackend('proj-1')).toThrowError(/missing "repo"/);
  });
});

describe('getTaskBackend — regression: existing source types', () => {
  it('resolves notion source', () => {
    vi.mocked(ProjectService.getById).mockReturnValue(
      makeProject('notion') as never,
    );
    const backend = getTaskBackend('proj-1');
    expect(backend.type).toBe('notion');
    expect(NotionTaskBackend).toHaveBeenCalledOnce();
  });

  it('resolves yaml source', () => {
    vi.mocked(ProjectService.getById).mockReturnValue(
      makeProject('yaml') as never,
    );
    const backend = getTaskBackend('proj-1');
    expect(backend.type).toBe('local');
    expect(LocalTaskBackend).toHaveBeenCalledOnce();
  });

  it('resolves jira source', () => {
    vi.mocked(ProjectService.getById).mockReturnValue(
      makeProject(
        'jira',
        JSON.stringify({
          host: 'https://jira.example.com',
          project_key: 'TEST',
        }),
      ) as never,
    );
    const backend = getTaskBackend('proj-1');
    expect(backend.type).toBe('jira');
    expect(JiraTaskSourceProvider).toHaveBeenCalledOnce();
  });
});
