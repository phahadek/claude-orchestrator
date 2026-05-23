export type TaskSource = 'notion' | 'yaml';

export interface ProjectMilestone {
  id: string;
  projectId: string;
  name: string;
  sourceId: string | null;
  displayOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface Project {
  id: string;
  name: string;
  projectDir: string;
  contextUrl: string | null;
  githubRepo: string | null;
  taskSource: TaskSource;
  autoLaunchEnabled: boolean;
  autoLaunchMilestoneId: string | null;
  autoMergeEnabled: boolean;
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
  autoLaunchEnabled?: boolean;
  autoLaunchMilestoneId?: string | null;
  autoMergeEnabled?: boolean;
}

export interface UpdateProjectInput {
  name?: string;
  projectDir?: string;
  contextUrl?: string | null;
  githubRepo?: string | null;
  taskSource?: TaskSource;
  autoLaunchEnabled?: boolean;
  autoLaunchMilestoneId?: string | null;
  autoMergeEnabled?: boolean;
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

async function request<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* body is not JSON */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

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
};
