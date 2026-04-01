import { Router } from 'express';
import type { Request, Response } from 'express';
import { getProjectById } from '../config.js';
import {
  getOpenPRs,
  getPRByNumber,
  updatePRState,
  getTaskTitleFromCache,
} from '../db/queries.js';
import { PRSyncJob } from '../github/PRSyncJob.js';
import { GitHubApiError } from '../github/types.js';
import type { GitHubClient } from '../github/GitHubClient.js';
import type { PRReviewService } from '../github/PRReviewService.js';
import type { PRReviewResult } from '../github/PRReviewService.js';
import type { SessionManager } from '../session/SessionManager.js';

export function createPrsRouter(
  github: GitHubClient,
  prReviewService: PRReviewService,
  sessionManager: SessionManager,
): Router {
  const router = Router();

  // ── GET /api/prs?projectId=<id> ─────────────────────────────────────────────
  router.get('/prs', (req: Request, res: Response) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
    if (!projectId) {
      res.status(400).json({ error: 'projectId query param is required' });
      return;
    }
    const project = getProjectById(projectId);
    if (!project?.githubRepo) {
      res.status(422).json({ error: 'Project has no githubRepo configured' });
      return;
    }
    const rows = getOpenPRs(project.githubRepo);
    const items = rows.map((pr) => ({
      prNumber: pr.pr_number,
      prUrl: pr.pr_url,
      title: pr.title,
      headBranch: pr.head_branch,
      baseBranch: pr.base_branch,
      state: pr.state,
      notionTaskId: pr.notion_task_id,
      notionTaskTitle: pr.notion_task_id ? getTaskTitleFromCache(pr.notion_task_id) : null,
      reviewResult: pr.review_result
        ? (JSON.parse(pr.review_result) as PRReviewResult)
        : null,
      reviewedAt: pr.review_at,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
    }));
    res.json(items);
  });

  // ── GET /api/prs/sync ───────────────────────────────────────────────────────
  router.get('/prs/sync', async (_req: Request, res: Response) => {
    const job = new PRSyncJob(github);
    try {
      await job.run();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── POST /api/prs/:prNumber/review ──────────────────────────────────────────
  router.post('/prs/:prNumber/review', async (req: Request, res: Response) => {
    const prNumber = parseInt(String(req.params.prNumber), 10);
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
    if (!projectId) {
      res.status(400).json({ error: 'projectId query param is required' });
      return;
    }
    const project = getProjectById(projectId);
    if (!project?.githubRepo) {
      res.status(422).json({ error: 'Project has no githubRepo configured' });
      return;
    }
    const repo = project.githubRepo;
    const prRow = getPRByNumber(prNumber, repo);
    if (!prRow) {
      res.status(404).json({ error: `PR #${prNumber} not found` });
      return;
    }
    if (!prRow.notion_task_id) {
      res.status(422).json({ error: 'No Notion task linked to this PR' });
      return;
    }
    try {
      const result = await prReviewService.reviewPR(prNumber, repo);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── POST /api/prs/:prNumber/merge ────────────────────────────────────────────
  router.post('/prs/:prNumber/merge', async (req: Request, res: Response) => {
    const prNumber = parseInt(String(req.params.prNumber), 10);
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
    if (!projectId) {
      res.status(400).json({ error: 'projectId query param is required' });
      return;
    }
    const project = getProjectById(projectId);
    if (!project?.githubRepo) {
      res.status(422).json({ error: 'Project has no githubRepo configured' });
      return;
    }
    const repo = project.githubRepo;
    const prRow = getPRByNumber(prNumber, repo);
    const commitTitle =
      typeof (req.body as { commitTitle?: string }).commitTitle === 'string'
        ? (req.body as { commitTitle: string }).commitTitle
        : prRow?.title ?? `Merge PR #${prNumber}`;
    try {
      const result = await github.mergePR(prNumber, commitTitle, repo);
      updatePRState(prNumber, repo, 'merged');
      res.json(result);
    } catch (err) {
      if (err instanceof GitHubApiError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── POST /api/prs/:prNumber/fix ──────────────────────────────────────────────
  router.post('/prs/:prNumber/fix', async (req: Request, res: Response) => {
    const prNumber = parseInt(String(req.params.prNumber), 10);
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
    if (!projectId) {
      res.status(400).json({ error: 'projectId query param is required' });
      return;
    }
    const project = getProjectById(projectId);
    if (!project?.githubRepo) {
      res.status(422).json({ error: 'Project has no githubRepo configured' });
      return;
    }
    const repo = project.githubRepo;
    const prRow = getPRByNumber(prNumber, repo);
    if (!prRow) {
      res.status(404).json({ error: `PR #${prNumber} not found` });
      return;
    }
    if (!prRow.session_id) {
      res.status(422).json({ error: 'No session linked to this PR' });
      return;
    }
    if (!prRow.review_result) {
      res.status(422).json({ error: 'Run a review before sending a fix' });
      return;
    }
    const reviewResult = JSON.parse(prRow.review_result) as PRReviewResult;
    const failingDimensions = reviewResult.dimensions.filter((d) => !d.passed);
    const lines = failingDimensions.map((d) => `❌ ${d.name}: ${d.notes}`).join('\n');
    const fixMessage =
      `PR #${prNumber} review findings — please address the following:\n\n${lines}\n\nOverall: ${reviewResult.summary}`;
    await sessionManager.sendOrResume(prRow.session_id, fixMessage);
    res.json({ sessionId: prRow.session_id });
  });

  return router;
}
