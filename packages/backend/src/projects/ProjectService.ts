import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { randomUUID } from 'crypto';
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
} from '../db/queries';
import type {
  MilestoneRow,
  ProjectRow,
  TaskSource,
  GitMode,
} from '../db/types';
import type { NonMilestoneSourceConfig } from '../tasks/TaskBackend';
import { recordEvent } from '../audit/AuditLog';
import { normalizePath } from '../config';
import { logger } from '../logger';

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
  gitMode: GitMode;
  autoLaunchEnabled: boolean;
  autoLaunchMilestoneId: string | null;
  autoMergeEnabled: boolean;
  milestoneBranching: 'two_tier' | 'flat' | null;
  nonMilestoneSourceConfig: NonMilestoneSourceConfig | null;
  taskSourceConfig: string | null;
  dataResidencyConfirmed: boolean;
  baseBranch: string;
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
  taskSourceConfig?: string | null;
  gitMode?: GitMode;
  autoLaunchEnabled?: boolean;
  autoLaunchMilestoneId?: string | null;
  autoMergeEnabled?: boolean;
  dataResidencyConfirmed?: boolean;
  baseBranch?: string;
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
  let nonMilestoneSourceConfig: NonMilestoneSourceConfig | null = null;
  if (row.non_milestone_source_config) {
    try {
      nonMilestoneSourceConfig = JSON.parse(
        row.non_milestone_source_config,
      ) as NonMilestoneSourceConfig;
    } catch {
      // ignore malformed JSON
    }
  }
  return {
    id: row.id,
    name: row.name,
    projectDir: row.project_dir,
    contextUrl: row.context_url,
    githubRepo: row.github_repo,
    taskSource: row.task_source,
    gitMode: row.git_mode ?? 'github',
    autoLaunchEnabled: row.auto_launch_enabled === 1,
    autoLaunchMilestoneId: row.auto_launch_milestone_id,
    autoMergeEnabled: row.auto_merge_enabled === 1,
    milestoneBranching: row.milestone_branching ?? null,
    nonMilestoneSourceConfig,
    taskSourceConfig: row.task_source_config ?? null,
    dataResidencyConfirmed: (row.data_residency_confirmed ?? 0) === 1,
    baseBranch: row.base_branch ?? 'dev',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    milestones: milestones.map(rowToMilestone),
  };
}

export function getProjectRepos(project: {
  githubRepo?: string | null;
}): string[] {
  const raw = project.githubRepo;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as string[];
  } catch {
    // bare string
  }
  return [raw];
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
    return this.list().find((p) => getProjectRepos(p).includes(githubRepo));
  },

  create(input: CreateProjectInput): Project {
    const row = insertProject({
      id: input.id,
      name: input.name,
      project_dir: normalizePath(input.projectDir),
      context_url: input.contextUrl ?? null,
      github_repo: input.githubRepo ?? null,
      task_source: input.taskSource ?? 'notion',
      task_source_config: input.taskSourceConfig ?? null,
      git_mode: input.gitMode ?? 'github',
      auto_launch_enabled: input.autoLaunchEnabled ? 1 : 0,
      auto_launch_milestone_id: input.autoLaunchMilestoneId ?? null,
      auto_merge_enabled: input.autoMergeEnabled ? 1 : 0,
      data_residency_confirmed: input.dataResidencyConfirmed ? 1 : 0,
      base_branch: input.baseBranch ?? 'dev',
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

  /**
   * Reconcile tasks.yaml milestones into the DB milestones table for a yaml project.
   * Upsert-only: never deletes rows. For each yaml milestone in order:
   *   1. update the row whose source_id matches the yaml id
   *   2. adopt a source_id=null row whose name matches (backfill source_id, keep id)
   *   3. create a new row
   */
  reconcileYamlMilestones(projectId: string, projectDir: string): void {
    const filePath = path.join(projectDir, 'tasks.yaml');
    if (!fs.existsSync(filePath)) return;

    let yamlMilestones: { id: string; name: string }[];
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = yaml.load(raw) as {
        milestones?: { id: string; name: string }[];
      } | null;
      if (!parsed?.milestones || !Array.isArray(parsed.milestones)) return;
      yamlMilestones = parsed.milestones.filter(
        (m) => typeof m.id === 'string' && typeof m.name === 'string',
      );
    } catch (err) {
      logger.warn(
        `[ProjectService] reconcileYamlMilestones: failed to read ${filePath}: ${String(err)}`,
      );
      return;
    }

    const existing = listMilestonesByProject(projectId);

    for (let i = 0; i < yamlMilestones.length; i++) {
      const ym = yamlMilestones[i];
      const displayOrder = i;

      const bySourceId = existing.find((r) => r.source_id === ym.id);
      if (bySourceId) {
        updateMilestone(bySourceId.id, {
          name: ym.name,
          display_order: displayOrder,
        });
        continue;
      }

      const byName = existing.find(
        (r) => r.source_id === null && r.name === ym.name,
      );
      if (byName) {
        updateMilestone(byName.id, {
          name: ym.name,
          source_id: ym.id,
          display_order: displayOrder,
        });
        continue;
      }

      insertMilestone({
        id: randomUUID(),
        project_id: projectId,
        name: ym.name,
        source_id: ym.id,
        display_order: displayOrder,
      });
    }
  },

  setDataResidencyConfirmed(
    projectId: string,
    newValue: boolean,
  ): Project | undefined {
    const existing = getProjectRowById(projectId);
    if (!existing) return undefined;
    const previousValue = (existing.data_residency_confirmed ?? 0) === 1;
    const row = updateProject(projectId, {
      data_residency_confirmed: newValue ? 1 : 0,
    });
    if (!row) return undefined;
    recordEvent({
      event_type: 'data_residency_flag_toggled',
      actor_type: 'human',
      project_id: projectId,
      payload: { projectId, previousValue, newValue },
    });
    return rowToProject(row, listMilestonesByProject(projectId));
  },
};

export type { ProjectPatch, MilestonePatch };
