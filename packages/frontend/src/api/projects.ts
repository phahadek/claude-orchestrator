import { getDeviceToken } from '../auth/deviceToken';

export type TaskSource = 'notion' | 'yaml' | 'github' | 'jira';
export type GitMode = 'github' | 'local-only';

export interface GithubTaskSourceConfig {
  owner: string;
  repo: string;
  defaultMilestone?: number | null;
}

export interface GithubMilestone {
  id: number;
  nodeId: string;
  title: string;
  description: string | null;
  state: 'open' | 'closed';
  openIssues: number;
  closedIssues: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestratorConfig {
  autofix: string[];
  verify: string[];
  ci_check_name: string[];
  allowed_tools: string[];
  bash_rules: string[];
  bootstrap_script: string;
}

export interface OrchestratorConfigResponse {
  present: boolean;
  config: OrchestratorConfig;
}

interface DatabaseValidation {
  type: 'database';
  title: string;
  id: string;
}

interface PageValidation {
  type: 'page';
  childDatabaseId: string | null;
  childDatabaseTitle: string | null;
}

export type BoardValidation = DatabaseValidation | PageValidation;

export interface GithubMilestoneValidation {
  type: 'github-milestone';
  number: number;
  title: string;
  state: 'open' | 'closed';
}

export interface JiraEpicValidation {
  type: 'jira-epic';
  key: string;
  summary: string;
}

export type SourceValidation =
  | BoardValidation
  | GithubMilestoneValidation
  | JiraEpicValidation;

export interface ProjectMilestone {
  id: string;
  projectId: string;
  name: string;
  sourceId: string | null;
  displayOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface NonMilestoneSourceConfig {
  notionDatabaseId?: string;
  milestoneId?: string;
}

export interface Project {
  id: string;
  name: string;
  projectDir: string;
  contextUrl: string | null;
  githubRepo: string | null;
  taskSource: TaskSource;
  gitMode: GitMode;
  autoLaunchEnabled: boolean;
  autoLaunchMilestoneId: string | null;
  autoMergeEnabled: boolean;
  nonMilestoneSourceConfig: NonMilestoneSourceConfig | null;
  taskSourceConfig: string | null;
  dataResidencyConfirmed: boolean;
  baseBranch: string;
  createdAt: number;
  updatedAt: number;
  milestones: ProjectMilestone[];
}

export interface CreateProjectInput {
  id?: string;
  name: string;
  projectDir: string;
  contextUrl?: string | null;
  githubRepo?: string | null;
  taskSource: TaskSource;
  taskSourceConfig?: string | null;
  gitMode?: GitMode;
  autoLaunchEnabled?: boolean;
  autoLaunchMilestoneId?: string | null;
  autoMergeEnabled?: boolean;
  baseBranch?: string;
}

export interface UpdateProjectInput {
  name?: string;
  projectDir?: string;
  contextUrl?: string | null;
  githubRepo?: string | null;
  taskSource?: TaskSource;
  taskSourceConfig?: string | null;
  gitMode?: GitMode;
  autoLaunchEnabled?: boolean;
  autoLaunchMilestoneId?: string | null;
  autoMergeEnabled?: boolean;
  nonMilestoneSourceConfig?: NonMilestoneSourceConfig | null;
  dataResidencyConfirmed?: boolean;
  baseBranch?: string;
}

export interface CreateMilestoneInput {
  id?: string;
  name: string;
  sourceId?: string | null;
  displayOrder?: number;
}

export interface UpdateMilestoneInput {
  name?: string;
  sourceId?: string | null;
  displayOrder?: number;
}

export async function apiRequest<T>(
  input: RequestInfo,
  init?: RequestInit,
): Promise<T> {
  const token = getDeviceToken(); // may be null before enrollment
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(input, { ...init, headers });

  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('device-unauthorized'));
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      if (body?.error) message = body.error;
      code = body.code;
    } catch {
      /* body is not JSON */
    }
    if (res.status === 403 && code === 'bootstrap_loopback_only') {
      window.dispatchEvent(new CustomEvent('device-bootstrap-loopback-only'));
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const request = apiRequest;

export const projectsApi = {
  list(): Promise<Project[]> {
    return request<Project[]>('/api/projects');
  },

  create(input: CreateProjectInput): Promise<Project> {
    return request<Project>('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  },

  update(id: string, patch: UpdateProjectInput): Promise<Project> {
    return request<Project>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },

  delete(id: string): Promise<void> {
    return request<void>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  listMilestones(projectId: string): Promise<ProjectMilestone[]> {
    return request<ProjectMilestone[]>(
      `/api/projects/${encodeURIComponent(projectId)}/milestones`,
    );
  },

  createMilestone(
    projectId: string,
    input: CreateMilestoneInput,
  ): Promise<ProjectMilestone> {
    return request<ProjectMilestone>(
      `/api/projects/${encodeURIComponent(projectId)}/milestones`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
  },

  updateMilestone(
    milestoneId: string,
    patch: UpdateMilestoneInput,
  ): Promise<ProjectMilestone> {
    return request<ProjectMilestone>(
      `/api/milestones/${encodeURIComponent(milestoneId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
    );
  },

  deleteMilestone(milestoneId: string): Promise<void> {
    return request<void>(`/api/milestones/${encodeURIComponent(milestoneId)}`, {
      method: 'DELETE',
    });
  },

  async validateGithubMilestone(
    projectId: string,
    number: number,
  ): Promise<GithubMilestoneValidation> {
    const res = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/github/validate-milestone?number=${number}`,
    );
    const body = (await res.json()) as
      | GithubMilestoneValidation
      | { error: string };
    if (!res.ok) {
      throw new Error(
        'error' in body && body.error
          ? body.error
          : `${res.status} ${res.statusText}`,
      );
    }
    return body as GithubMilestoneValidation;
  },

  async validateJiraEpic(
    projectId: string,
    key: string,
  ): Promise<JiraEpicValidation> {
    const res = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/jira/validate-epic?key=${encodeURIComponent(key)}`,
    );
    const body = (await res.json()) as JiraEpicValidation | { error: string };
    if (!res.ok) {
      throw new Error(
        'error' in body && body.error
          ? body.error
          : `${res.status} ${res.statusText}`,
      );
    }
    return body as JiraEpicValidation;
  },

  async validateNotionBoard(id: string): Promise<BoardValidation> {
    const res = await fetch(
      `/api/notion/validate-board?id=${encodeURIComponent(id)}`,
    );
    const body = (await res.json()) as BoardValidation | { error: string };
    if (!res.ok) {
      throw new Error(
        'error' in body && body.error
          ? body.error
          : `${res.status} ${res.statusText}`,
      );
    }
    return body as BoardValidation;
  },

  createTasksYamlStub(projectId: string): Promise<{ path: string }> {
    return request<{ path: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks-yaml-stub`,
      { method: 'POST' },
    );
  },

  mergeReady(
    projectId: string,
    milestoneId: string,
  ): Promise<{ attempted: number[] }> {
    return request<{ attempted: number[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/milestones/${encodeURIComponent(milestoneId)}/merge-ready`,
      { method: 'POST' },
    );
  },

  getOrchestratorConfig(
    projectId: string,
  ): Promise<OrchestratorConfigResponse> {
    return request<OrchestratorConfigResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/orchestrator-config`,
    );
  },

  listGithubMilestones(projectId: string): Promise<GithubMilestone[]> {
    return request<GithubMilestone[]>(
      `/api/projects/${encodeURIComponent(projectId)}/github-milestones`,
    );
  },
};

export const sessionsApi = {
  markMerged(sessionId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/mark-merged`,
      { method: 'POST' },
    );
  },
  abort(sessionId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/abort`,
      { method: 'POST' },
    );
  },
};
