import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { normalizePath } from '../config';
import {
  ProjectService,
  type ProjectPatch,
  type MilestonePatch,
} from '../projects/ProjectService';
import type { AutoMerger } from '../github/AutoMerger';
import { getMergeReadyPRs } from '../db/queries';
import { NotionClient, normalizeNotionId } from '../notion/NotionClient';
import { loadOrchestratorConfig } from '../session/orchestrator-config';
import { GitHubClient } from '../github/GitHubClient';
import { JiraClient } from '../tasks/JiraClient';
import { JIRA_HOST, JIRA_TOKEN, JIRA_EMAIL } from '../config';

let _autoMerger: AutoMerger | null = null;
export function setAutoMerger(merger: AutoMerger): void {
  _autoMerger = merger;
}

export const projectsRouter = Router();

function isExistingDirectory(p: string): boolean {
  try {
    return fs.statSync(normalizePath(p)).isDirectory();
  } catch {
    return false;
  }
}

const JIRA_EPIC_KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;

/** Returns an error string if sourceId is malformed for the given taskSource, or null if valid. */
function validateSourceIdFormat(
  sourceId: string,
  taskSource: string,
): string | null {
  switch (taskSource) {
    case 'notion':
      if (!normalizeNotionId(sourceId))
        return 'sourceId is not a valid Notion database URL or ID';
      return null;
    case 'github': {
      const n = parseInt(sourceId, 10);
      if (isNaN(n) || n <= 0 || String(n) !== sourceId)
        return 'sourceId must be a positive integer (GitHub milestone number)';
      return null;
    }
    case 'jira':
      if (!JIRA_EPIC_KEY_RE.test(sourceId))
        return 'sourceId must be a Jira Epic key (e.g. PROJECT-123)';
      return null;
    default:
      return null;
  }
}

const OWNER_REPO_RE = /^[^/]+\/[^/]+$/;

interface GithubTaskSourceConfig {
  owner: string;
  repo: string;
  defaultMilestone?: number | null;
}

function parseGithubTaskSourceConfig(
  raw: unknown,
): { ok: true; config: GithubTaskSourceConfig } | { ok: false; error: string } {
  if (typeof raw === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'task_source_config is not valid JSON' };
    }
    return parseGithubTaskSourceConfig(parsed);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'task_source_config must be a JSON object' };
  }
  const obj = raw as Record<string, unknown>;
  const ownerRepo =
    typeof obj.owner === 'string' && typeof obj.repo === 'string'
      ? `${obj.owner}/${obj.repo}`
      : typeof obj.ownerRepo === 'string'
        ? obj.ownerRepo
        : null;
  if (!ownerRepo) {
    return {
      ok: false,
      error: 'task_source_config must have owner and repo fields',
    };
  }
  if (!OWNER_REPO_RE.test(ownerRepo)) {
    return {
      ok: false,
      error: 'owner/repo must be in the format "owner/repo"',
    };
  }
  const [owner, repo] = ownerRepo.split('/');
  const defaultMilestone =
    typeof obj.defaultMilestone === 'number'
      ? obj.defaultMilestone
      : obj.defaultMilestone == null
        ? null
        : undefined;
  if (defaultMilestone === undefined && obj.defaultMilestone !== undefined) {
    return {
      ok: false,
      error: 'task_source_config.defaultMilestone must be a number or null',
    };
  }
  return { ok: true, config: { owner, repo, defaultMilestone } };
}

async function verifyGithubRepoAccess(
  ownerRepo: string,
): Promise<string | null> {
  try {
    const client = new GitHubClient();
    await client.getRepo(ownerRepo);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `GitHub repo '${ownerRepo}' is not accessible: ${msg}`;
  }
}

// ── Projects ─────────────────────────────────────────────────────────────────

projectsRouter.get('/projects', (_req: Request, res: Response) => {
  res.json(ProjectService.list());
});

projectsRouter.post('/projects', async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body) {
    res.status(400).json({ error: 'Request body is required' });
    return;
  }

  const name = typeof body.name === 'string' ? body.name : '';
  const projectDir = typeof body.projectDir === 'string' ? body.projectDir : '';
  if (!name || !projectDir) {
    res.status(400).json({ error: 'name and projectDir are required' });
    return;
  }

  if (!isExistingDirectory(projectDir)) {
    res
      .status(400)
      .json({ error: `projectDir '${projectDir}' does not exist on disk` });
    return;
  }

  const rawTaskSource = body.taskSource;
  if (
    rawTaskSource !== undefined &&
    rawTaskSource !== 'notion' &&
    rawTaskSource !== 'yaml' &&
    rawTaskSource !== 'github' &&
    rawTaskSource !== 'jira'
  ) {
    res.status(400).json({
      error: `taskSource must be 'notion', 'yaml', 'github', or 'jira'`,
    });
    return;
  }
  const taskSource =
    rawTaskSource === 'yaml'
      ? 'yaml'
      : rawTaskSource === 'github'
        ? 'github'
        : rawTaskSource === 'jira'
          ? 'jira'
          : 'notion';

  let taskSourceConfig: string | null = null;
  if (taskSource === 'github') {
    const parsed = parseGithubTaskSourceConfig(body.taskSourceConfig);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const repoError = await verifyGithubRepoAccess(
      `${parsed.config.owner}/${parsed.config.repo}`,
    );
    if (repoError) {
      res.status(400).json({ error: repoError });
      return;
    }
    taskSourceConfig = JSON.stringify(parsed.config);
  }

  const rawGitMode = body.gitMode;
  if (
    rawGitMode !== undefined &&
    rawGitMode !== 'github' &&
    rawGitMode !== 'local-only'
  ) {
    res.status(400).json({ error: `gitMode must be 'github' or 'local-only'` });
    return;
  }
  const gitMode = rawGitMode === 'local-only' ? 'local-only' : 'github';
  const id =
    typeof body.id === 'string' && body.id ? body.id : crypto.randomUUID();

  if (ProjectService.getById(id)) {
    res.status(409).json({ error: `Project with id '${id}' already exists` });
    return;
  }

  // derive github_repo from GitHub task source config when applicable
  let githubRepo: string | null =
    typeof body.githubRepo === 'string' ? body.githubRepo : null;
  if (taskSource === 'github' && taskSourceConfig) {
    const cfg = JSON.parse(taskSourceConfig) as {
      owner?: string;
      repo?: string;
    };
    if (cfg.owner && cfg.repo) {
      githubRepo = `${cfg.owner}/${cfg.repo}`;
    }
  }

  const project = ProjectService.create({
    id,
    name,
    projectDir,
    contextUrl: typeof body.contextUrl === 'string' ? body.contextUrl : null,
    githubRepo,
    taskSource,
    taskSourceConfig,
    gitMode,
    autoLaunchEnabled: body.autoLaunchEnabled === true,
    autoLaunchMilestoneId:
      typeof body.autoLaunchMilestoneId === 'string'
        ? body.autoLaunchMilestoneId
        : null,
    autoMergeEnabled: body.autoMergeEnabled === true,
    baseBranch: typeof body.baseBranch === 'string' ? body.baseBranch : 'dev',
  });
  res.status(201).json(project);
});

projectsRouter.patch('/projects/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const body = (req.body as Record<string, unknown>) ?? {};

  if (
    typeof body.projectDir === 'string' &&
    !isExistingDirectory(body.projectDir)
  ) {
    res.status(400).json({
      error: `projectDir '${body.projectDir}' does not exist on disk`,
    });
    return;
  }

  const patch: ProjectPatch = {};
  if (typeof body.name === 'string') patch.name = body.name;
  if (typeof body.projectDir === 'string') patch.project_dir = body.projectDir;
  if ('contextUrl' in body) {
    patch.context_url =
      typeof body.contextUrl === 'string' ? body.contextUrl : null;
  }
  if ('githubRepo' in body) {
    patch.github_repo =
      typeof body.githubRepo === 'string' ? body.githubRepo : null;
  }
  if (
    body.taskSource === 'notion' ||
    body.taskSource === 'yaml' ||
    body.taskSource === 'github' ||
    body.taskSource === 'jira'
  ) {
    patch.task_source = body.taskSource;
  }
  if ('autoLaunchEnabled' in body) {
    patch.auto_launch_enabled = body.autoLaunchEnabled === true ? 1 : 0;
  }
  if ('autoLaunchMilestoneId' in body) {
    patch.auto_launch_milestone_id =
      typeof body.autoLaunchMilestoneId === 'string'
        ? body.autoLaunchMilestoneId
        : null;
  }
  if ('autoMergeEnabled' in body) {
    patch.auto_merge_enabled = body.autoMergeEnabled === true ? 1 : 0;
  }
  if ('milestoneBranching' in body) {
    if (
      body.milestoneBranching === 'two_tier' ||
      body.milestoneBranching === 'flat' ||
      body.milestoneBranching === null
    ) {
      patch.milestone_branching = body.milestoneBranching as
        | 'two_tier'
        | 'flat'
        | null;
    } else if (body.milestoneBranching !== undefined) {
      res.status(400).json({
        error: `milestoneBranching must be 'two_tier', 'flat', or null`,
      });
      return;
    }
  }
  if ('nonMilestoneSourceConfig' in body) {
    if (body.nonMilestoneSourceConfig === null) {
      patch.non_milestone_source_config = null;
    } else if (typeof body.nonMilestoneSourceConfig === 'string') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.nonMilestoneSourceConfig);
      } catch {
        res
          .status(400)
          .json({ error: 'nonMilestoneSourceConfig is not valid JSON' });
        return;
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        res
          .status(400)
          .json({ error: 'nonMilestoneSourceConfig must be a JSON object' });
        return;
      }
      const obj = parsed as Record<string, unknown>;
      if (
        (obj.notionDatabaseId !== undefined &&
          typeof obj.notionDatabaseId !== 'string') ||
        (obj.milestoneId !== undefined && typeof obj.milestoneId !== 'string')
      ) {
        res.status(400).json({
          error:
            'nonMilestoneSourceConfig must have shape {notionDatabaseId?: string; milestoneId?: string}',
        });
        return;
      }
      patch.non_milestone_source_config = body.nonMilestoneSourceConfig;
    } else if (typeof body.nonMilestoneSourceConfig === 'object') {
      const obj = body.nonMilestoneSourceConfig as Record<string, unknown>;
      if (
        (obj.notionDatabaseId !== undefined &&
          typeof obj.notionDatabaseId !== 'string') ||
        (obj.milestoneId !== undefined && typeof obj.milestoneId !== 'string')
      ) {
        res.status(400).json({
          error:
            'nonMilestoneSourceConfig must have shape {notionDatabaseId?: string; milestoneId?: string}',
        });
        return;
      }
      patch.non_milestone_source_config = JSON.stringify(
        body.nonMilestoneSourceConfig,
      );
    } else {
      res.status(400).json({
        error:
          'nonMilestoneSourceConfig must be a JSON object, JSON string, or null',
      });
      return;
    }
  }
  if ('taskSourceConfig' in body) {
    if (body.taskSourceConfig === null) {
      patch.task_source_config = null;
    } else {
      const parsed = parseGithubTaskSourceConfig(body.taskSourceConfig);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      const repoError = await verifyGithubRepoAccess(
        `${parsed.config.owner}/${parsed.config.repo}`,
      );
      if (repoError) {
        res.status(400).json({ error: repoError });
        return;
      }
      patch.task_source_config = JSON.stringify(parsed.config);
      // derive github_repo from the validated GitHub task source config
      patch.github_repo = `${parsed.config.owner}/${parsed.config.repo}`;
    }
  }

  if (body.gitMode === 'github' || body.gitMode === 'local-only') {
    patch.git_mode = body.gitMode;
  } else if ('gitMode' in body && body.gitMode !== undefined) {
    res.status(400).json({ error: `gitMode must be 'github' or 'local-only'` });
    return;
  }
  if (typeof body.baseBranch === 'string') {
    patch.base_branch = body.baseBranch;
  }

  // dataResidencyConfirmed triggers audit logging via the dedicated service method.
  if ('dataResidencyConfirmed' in body) {
    const updated = ProjectService.setDataResidencyConfirmed(
      id,
      body.dataResidencyConfirmed === true,
    );
    if (!updated) {
      res.status(404).json({ error: `Project '${id}' not found` });
      return;
    }
    // Apply any remaining patch fields on top.
    delete (patch as Record<string, unknown>).data_residency_confirmed;
    if (Object.keys(patch).length === 0) {
      res.json(updated);
      return;
    }
    const final = ProjectService.update(id, patch);
    res.json(final ?? updated);
    return;
  }

  const updated = ProjectService.update(id, patch);
  if (!updated) {
    res.status(404).json({ error: `Project '${id}' not found` });
    return;
  }
  res.json(updated);
});

projectsRouter.delete('/projects/:id', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const deleted = ProjectService.delete(id);
  if (!deleted) {
    res.status(404).json({ error: `Project '${id}' not found` });
    return;
  }
  res.status(204).send();
});

// ── Milestones (nested + flat) ───────────────────────────────────────────────

projectsRouter.get(
  '/projects/:id/milestones',
  (req: Request, res: Response) => {
    const projectId = String(req.params.id);
    if (!ProjectService.getById(projectId)) {
      res.status(404).json({ error: `Project '${projectId}' not found` });
      return;
    }
    res.json(ProjectService.listMilestones(projectId));
  },
);

projectsRouter.post(
  '/projects/:id/milestones',
  (req: Request, res: Response) => {
    const projectId = String(req.params.id);
    const project = ProjectService.getById(projectId);
    if (!project) {
      res.status(404).json({ error: `Project '${projectId}' not found` });
      return;
    }

    const body = (req.body as Record<string, unknown>) ?? {};
    const name = typeof body.name === 'string' ? body.name : '';
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const rawSourceId =
      typeof body.sourceId === 'string' ? body.sourceId : null;
    if (rawSourceId) {
      const fmtErr = validateSourceIdFormat(rawSourceId, project.taskSource);
      if (fmtErr) {
        res.status(400).json({ error: fmtErr });
        return;
      }
    }

    const id =
      typeof body.id === 'string' && body.id ? body.id : crypto.randomUUID();
    if (ProjectService.getMilestone(id)) {
      res
        .status(409)
        .json({ error: `Milestone with id '${id}' already exists` });
      return;
    }

    const milestone = ProjectService.createMilestone({
      id,
      projectId,
      name,
      sourceId: rawSourceId,
      displayOrder:
        typeof body.displayOrder === 'number' ? body.displayOrder : 0,
    });
    res.status(201).json(milestone);
  },
);

projectsRouter.patch('/milestones/:id', (req: Request, res: Response) => {
  const id = String(req.params.id);

  const existing = ProjectService.getMilestone(id);
  if (!existing) {
    res.status(404).json({ error: `Milestone '${id}' not found` });
    return;
  }

  const body = (req.body as Record<string, unknown>) ?? {};

  if (
    'sourceId' in body &&
    typeof body.sourceId === 'string' &&
    body.sourceId
  ) {
    const project = ProjectService.getById(existing.projectId);
    if (project) {
      const fmtErr = validateSourceIdFormat(body.sourceId, project.taskSource);
      if (fmtErr) {
        res.status(400).json({ error: fmtErr });
        return;
      }
    }
  }

  const patch: MilestonePatch = {};
  if (typeof body.name === 'string') patch.name = body.name;
  if ('sourceId' in body) {
    patch.source_id = typeof body.sourceId === 'string' ? body.sourceId : null;
  }
  if (typeof body.displayOrder === 'number')
    patch.display_order = body.displayOrder;

  const updated = ProjectService.updateMilestone(id, patch);
  if (!updated) {
    res.status(404).json({ error: `Milestone '${id}' not found` });
    return;
  }
  res.json(updated);
});

projectsRouter.delete('/milestones/:id', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const deleted = ProjectService.deleteMilestone(id);
  if (!deleted) {
    res.status(404).json({ error: `Milestone '${id}' not found` });
    return;
  }
  res.status(204).send();
});

// ── tasks.yaml stub creation (YAML projects) ─────────────────────────────────

projectsRouter.post(
  '/projects/:id/tasks-yaml-stub',
  (req: Request, res: Response) => {
    const projectId = String(req.params.id);
    const project = ProjectService.getById(projectId);
    if (!project) {
      res.status(404).json({ error: `Project '${projectId}' not found` });
      return;
    }
    if (project.taskSource !== 'yaml') {
      res.status(400).json({
        error: `Project '${projectId}' is not configured for YAML task source`,
      });
      return;
    }

    const dir = normalizePath(project.projectDir);
    if (!isExistingDirectory(dir)) {
      res.status(400).json({
        error: `projectDir '${project.projectDir}' does not exist on disk`,
      });
      return;
    }

    const filePath = path.join(dir, 'tasks.yaml');
    if (fs.existsSync(filePath)) {
      res
        .status(409)
        .json({ error: 'tasks.yaml already exists', path: filePath });
      return;
    }

    const milestones =
      project.milestones.length > 0
        ? project.milestones.map((m) => ({
            id: m.sourceId ?? m.id,
            name: m.name,
            tasks: [],
          }))
        : [{ id: 'm1', name: 'Default', tasks: [] }];

    const stub = {
      project: { id: project.id, name: project.name },
      milestones,
    };
    fs.writeFileSync(filePath, yaml.dump(stub, { lineWidth: 120 }), 'utf-8');
    res.status(201).json({ path: filePath });
  },
);

// ── Notion board validation ───────────────────────────────────────────────────

projectsRouter.get(
  '/notion/validate-board',
  async (req: Request, res: Response) => {
    const rawId = typeof req.query.id === 'string' ? req.query.id.trim() : '';
    if (!rawId) {
      res.status(400).json({ error: 'id query parameter is required' });
      return;
    }
    if (!normalizeNotionId(rawId)) {
      res
        .status(400)
        .json({ error: 'Could not extract a valid Notion ID from the input' });
      return;
    }
    const client = new NotionClient();
    try {
      const result = await client.validateBoard(rawId);
      res.json(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Notion validation failed';
      res.status(400).json({ error: message });
    }
  },
);

// ── GitHub milestone validation ──────────────────────────────────────────────

projectsRouter.get(
  '/projects/:id/github/validate-milestone',
  async (req: Request, res: Response) => {
    const projectId = String(req.params.id);
    const project = ProjectService.getById(projectId);
    if (!project) {
      res.status(404).json({ error: `Project '${projectId}' not found` });
      return;
    }
    if (project.taskSource !== 'github') {
      res.status(400).json({
        error: `Project '${projectId}' does not use GitHub task source`,
      });
      return;
    }

    const rawNumber =
      typeof req.query.number === 'string' ? req.query.number.trim() : '';
    if (!rawNumber) {
      res.status(400).json({ error: 'number query parameter is required' });
      return;
    }
    const n = parseInt(rawNumber, 10);
    if (isNaN(n) || n <= 0 || String(n) !== rawNumber) {
      res.status(400).json({
        error: 'number must be a positive integer (GitHub milestone number)',
      });
      return;
    }

    let ownerRepo: string;
    try {
      const cfg = project.taskSourceConfig
        ? (JSON.parse(project.taskSourceConfig) as GithubTaskSourceConfig)
        : null;
      if (!cfg?.owner || !cfg?.repo) {
        res
          .status(400)
          .json({ error: 'GitHub task source config is missing owner/repo' });
        return;
      }
      ownerRepo = `${cfg.owner}/${cfg.repo}`;
    } catch {
      res.status(400).json({ error: 'GitHub task source config is malformed' });
      return;
    }

    try {
      const client = new GitHubClient();
      const milestone = await client.getMilestone(ownerRepo, n);
      res.json({
        type: 'github-milestone',
        number: milestone.id,
        title: milestone.title,
        state: milestone.state,
      });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'GitHub milestone validation failed';
      res.status(400).json({ error: message });
    }
  },
);

// ── Jira Epic validation ──────────────────────────────────────────────────────

projectsRouter.get(
  '/projects/:id/jira/validate-epic',
  async (req: Request, res: Response) => {
    const projectId = String(req.params.id);
    const project = ProjectService.getById(projectId);
    if (!project) {
      res.status(404).json({ error: `Project '${projectId}' not found` });
      return;
    }
    if (project.taskSource !== 'jira') {
      res.status(400).json({
        error: `Project '${projectId}' does not use Jira task source`,
      });
      return;
    }

    const rawKey =
      typeof req.query.key === 'string' ? req.query.key.trim() : '';
    if (!rawKey) {
      res.status(400).json({ error: 'key query parameter is required' });
      return;
    }
    if (!JIRA_EPIC_KEY_RE.test(rawKey)) {
      res.status(400).json({
        error: 'key must be a valid Jira Epic key (e.g. PROJECT-123)',
      });
      return;
    }

    let jiraHost: string;
    try {
      const cfg = project.taskSourceConfig
        ? (JSON.parse(project.taskSourceConfig) as { host?: string })
        : null;
      jiraHost = cfg?.host || JIRA_HOST;
    } catch {
      jiraHost = JIRA_HOST;
    }

    if (!jiraHost || !JIRA_TOKEN) {
      res.status(400).json({ error: 'Jira is not configured on this server' });
      return;
    }

    try {
      const client = new JiraClient(
        jiraHost,
        JIRA_TOKEN,
        JIRA_EMAIL || undefined,
      );
      const issue = await client.getIssue(rawKey);
      res.json({
        type: 'jira-epic',
        key: issue.key,
        summary: issue.fields.summary,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Jira Epic validation failed';
      res.status(400).json({ error: message });
    }
  },
);

// ── Orchestrator config (read-only) ──────────────────────────────────────────

projectsRouter.get(
  '/projects/:id/orchestrator-config',
  (req: Request, res: Response) => {
    const id = String(req.params.id);
    const project = ProjectService.getById(id);
    if (!project) {
      res.status(404).json({ error: `Project '${id}' not found` });
      return;
    }

    const dir = normalizePath(project.projectDir);
    const configFile = path.join(dir, '.claude-orchestrator.yml');
    const present = fs.existsSync(configFile);
    const config = loadOrchestratorConfig(dir);
    res.json({ present, config });
  },
);

// ── GitHub milestones (for GitHub task source) ──────────────────────────────

projectsRouter.get(
  '/projects/:id/github-milestones',
  async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const project = ProjectService.getById(id);
    if (!project) {
      res.status(404).json({ error: `Project '${id}' not found` });
      return;
    }
    if (project.taskSource !== 'github') {
      res.status(400).json({
        error: `Project '${id}' is not configured for GitHub task source`,
      });
      return;
    }
    let ownerRepo: string;
    try {
      const cfg = project.taskSourceConfig
        ? (JSON.parse(project.taskSourceConfig) as GithubTaskSourceConfig)
        : null;
      if (!cfg?.owner || !cfg?.repo) {
        res
          .status(400)
          .json({ error: 'GitHub task source config is missing owner/repo' });
        return;
      }
      ownerRepo = `${cfg.owner}/${cfg.repo}`;
    } catch {
      res.status(400).json({ error: 'GitHub task source config is malformed' });
      return;
    }
    try {
      const client = new GitHubClient();
      const milestones = await client.listMilestones(ownerRepo, {
        state: 'open',
      });
      res.json(milestones);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to fetch GitHub milestones';
      res.status(400).json({ error: message });
    }
  },
);

// ── Merge-Ready bulk merge ────────────────────────────────────────────────────

projectsRouter.post(
  '/projects/:projectId/milestones/:milestoneId/merge-ready',
  (req: Request, res: Response) => {
    const projectId = String(req.params.projectId);
    const milestoneId = String(req.params.milestoneId);

    if (!ProjectService.getById(projectId)) {
      res.status(404).json({ error: `Project '${projectId}' not found` });
      return;
    }

    const eligiblePRs = getMergeReadyPRs(projectId, milestoneId);
    const attempted: number[] = [];

    for (const pr of eligiblePRs) {
      if (_autoMerger) {
        _autoMerger.attempt(pr.pr_number, pr.repo, { bypassToggle: true });
      }
      attempted.push(pr.pr_number);
    }

    res.json({ attempted });
  },
);
