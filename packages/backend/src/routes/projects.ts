import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import { ProjectService, type ProjectPatch, type MilestonePatch } from '../projects/ProjectService';

export const projectsRouter = Router();

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
