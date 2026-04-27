import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { normalizePath } from '../config';
import { ProjectService, type ProjectPatch, type MilestonePatch } from '../projects/ProjectService';

export const projectsRouter = Router();

function isExistingDirectory(p: string): boolean {
  try {
    return fs.statSync(normalizePath(p)).isDirectory();
  } catch {
    return false;
  }
}

// ── Projects ─────────────────────────────────────────────────────────────────

projectsRouter.get('/projects', (_req: Request, res: Response) => {
  res.json(ProjectService.list());
});

projectsRouter.post('/projects', (req: Request, res: Response) => {
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
    res.status(400).json({ error: `projectDir '${projectDir}' does not exist on disk` });
    return;
  }

  const taskSource = body.taskSource === 'yaml' ? 'yaml' : 'notion';
  const id = typeof body.id === 'string' && body.id ? body.id : crypto.randomUUID();

  if (ProjectService.getById(id)) {
    res.status(409).json({ error: `Project with id '${id}' already exists` });
    return;
  }

  const project = ProjectService.create({
    id,
    name,
    projectDir,
    contextUrl: typeof body.contextUrl === 'string' ? body.contextUrl : null,
    githubRepo: typeof body.githubRepo === 'string' ? body.githubRepo : null,
    taskSource,
  });
  res.status(201).json(project);
});

projectsRouter.patch('/projects/:id', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const body = (req.body as Record<string, unknown>) ?? {};

  if (typeof body.projectDir === 'string' && !isExistingDirectory(body.projectDir)) {
    res.status(400).json({ error: `projectDir '${body.projectDir}' does not exist on disk` });
    return;
  }

  const patch: ProjectPatch = {};
  if (typeof body.name === 'string') patch.name = body.name;
  if (typeof body.projectDir === 'string') patch.project_dir = body.projectDir;
  if ('contextUrl' in body) {
    patch.context_url = typeof body.contextUrl === 'string' ? body.contextUrl : null;
  }
  if ('githubRepo' in body) {
    patch.github_repo = typeof body.githubRepo === 'string' ? body.githubRepo : null;
  }
  if (body.taskSource === 'notion' || body.taskSource === 'yaml') {
    patch.task_source = body.taskSource;
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

projectsRouter.get('/projects/:id/milestones', (req: Request, res: Response) => {
  const projectId = String(req.params.id);
  if (!ProjectService.getById(projectId)) {
    res.status(404).json({ error: `Project '${projectId}' not found` });
    return;
  }
  res.json(ProjectService.listMilestones(projectId));
});

projectsRouter.post('/projects/:id/milestones', (req: Request, res: Response) => {
  const projectId = String(req.params.id);
  if (!ProjectService.getById(projectId)) {
    res.status(404).json({ error: `Project '${projectId}' not found` });
    return;
  }

  const body = (req.body as Record<string, unknown>) ?? {};
  const name = typeof body.name === 'string' ? body.name : '';
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const id = typeof body.id === 'string' && body.id ? body.id : crypto.randomUUID();
  if (ProjectService.getMilestone(id)) {
    res.status(409).json({ error: `Milestone with id '${id}' already exists` });
    return;
  }

  const milestone = ProjectService.createMilestone({
    id,
    projectId,
    name,
    sourceId: typeof body.sourceId === 'string' ? body.sourceId : null,
    displayOrder: typeof body.displayOrder === 'number' ? body.displayOrder : 0,
  });
  res.status(201).json(milestone);
});

projectsRouter.patch('/milestones/:id', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const body = (req.body as Record<string, unknown>) ?? {};

  const patch: MilestonePatch = {};
  if (typeof body.name === 'string') patch.name = body.name;
  if ('sourceId' in body) {
    patch.source_id = typeof body.sourceId === 'string' ? body.sourceId : null;
  }
  if (typeof body.displayOrder === 'number') patch.display_order = body.displayOrder;

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

projectsRouter.post('/projects/:id/tasks-yaml-stub', (req: Request, res: Response) => {
  const projectId = String(req.params.id);
  const project = ProjectService.getById(projectId);
  if (!project) {
    res.status(404).json({ error: `Project '${projectId}' not found` });
    return;
  }
  if (project.taskSource !== 'yaml') {
    res.status(400).json({ error: `Project '${projectId}' is not configured for YAML task source` });
    return;
  }

  const dir = normalizePath(project.projectDir);
  if (!isExistingDirectory(dir)) {
    res.status(400).json({ error: `projectDir '${project.projectDir}' does not exist on disk` });
    return;
  }

  const filePath = path.join(dir, 'tasks.yaml');
  if (fs.existsSync(filePath)) {
    res.status(409).json({ error: 'tasks.yaml already exists', path: filePath });
    return;
  }

  const milestones = project.milestones.length > 0
    ? project.milestones.map((m) => ({ id: m.sourceId ?? m.id, name: m.name, tasks: [] }))
    : [{ id: 'm1', name: 'Default', tasks: [] }];

  const stub = { project: { id: project.id, name: project.name }, milestones };
  fs.writeFileSync(filePath, yaml.dump(stub, { lineWidth: 120 }), 'utf-8');
  res.status(201).json({ path: filePath });
});
