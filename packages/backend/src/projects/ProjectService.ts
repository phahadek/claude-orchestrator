import {
  insertProject,
  getProjectRowById,
  listProjectRows,
  updateProject,
  deleteProject,
  countProjects,
  insertMilestone,
  getMilestoneById,
  listMilestonesByProject,
  updateMilestone,
  deleteMilestone,
  type ProjectPatch,
  type MilestonePatch,
} from "../db/queries";
import type { MilestoneRow, ProjectRow, TaskSource } from "../db/types";

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
  createdAt: number;
  updatedAt: number;
  milestones: ProjectMilestone[];
}

export interface CreateProjectInput {
  id: string;
  name: string;
  projectDir: string;
  contextUrl?: string | null;
  githubRepo?: string | null;
  taskSource?: TaskSource;
  autoLaunchEnabled?: boolean;
  autoLaunchMilestoneId?: string | null;
}

export interface CreateMilestoneInput {
  id: string;
  projectId: string;
  name: string;
  sourceId?: string | null;
  displayOrder?: number;
}

function rowToMilestone(row: MilestoneRow): ProjectMilestone {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    sourceId: row.source_id,
    displayOrder: row.display_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToProject(row: ProjectRow, milestones: MilestoneRow[]): Project {
  return {
    id: row.id,
    name: row.name,
    projectDir: row.project_dir,
    contextUrl: row.context_url,
    githubRepo: row.github_repo,
    taskSource: row.task_source,
    autoLaunchEnabled: row.auto_launch_enabled === 1,
    autoLaunchMilestoneId: row.auto_launch_milestone_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    milestones: milestones.map(rowToMilestone),
  };
}

export const ProjectService = {
  list(): Project[] {
    const rows = listProjectRows();
    return rows.map((row) =>
      rowToProject(row, listMilestonesByProject(row.id)),
    );
  },

  count(): number {
    return countProjects();
  },

  getById(id: string): Project | undefined {
    const row = getProjectRowById(id);
    if (!row) return undefined;
    return rowToProject(row, listMilestonesByProject(id));
  },

  getByGithubRepo(githubRepo: string): Project | undefined {
    return this.list().find((p) => p.githubRepo === githubRepo);
  },

  create(input: CreateProjectInput): Project {
    const row = insertProject({
      id: input.id,
      name: input.name,
      project_dir: input.projectDir,
      context_url: input.contextUrl ?? null,
      github_repo: input.githubRepo ?? null,
      task_source: input.taskSource ?? "notion",
      auto_launch_enabled: input.autoLaunchEnabled ? 1 : 0,
      auto_launch_milestone_id: input.autoLaunchMilestoneId ?? null,
    });
    return rowToProject(row, []);
  },

  update(id: string, patch: ProjectPatch): Project | undefined {
    const row = updateProject(id, patch);
    if (!row) return undefined;
    return rowToProject(row, listMilestonesByProject(id));
  },

  delete(id: string): boolean {
    return deleteProject(id);
  },

  listMilestones(projectId: string): ProjectMilestone[] {
    return listMilestonesByProject(projectId).map(rowToMilestone);
  },

  getMilestone(id: string): ProjectMilestone | undefined {
    const row = getMilestoneById(id);
    return row ? rowToMilestone(row) : undefined;
  },

  createMilestone(input: CreateMilestoneInput): ProjectMilestone {
    const row = insertMilestone({
      id: input.id,
      project_id: input.projectId,
      name: input.name,
      source_id: input.sourceId ?? null,
      display_order: input.displayOrder ?? 0,
    });
    return rowToMilestone(row);
  },

  updateMilestone(
    id: string,
    patch: MilestonePatch,
  ): ProjectMilestone | undefined {
    const row = updateMilestone(id, patch);
    return row ? rowToMilestone(row) : undefined;
  },

  deleteMilestone(id: string): boolean {
    return deleteMilestone(id);
  },
};

export type { ProjectPatch, MilestonePatch };
