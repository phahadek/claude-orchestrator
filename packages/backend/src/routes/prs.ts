import { Router } from 'express';
import type { Request, Response } from 'express';
import { getProjectById, config } from '../config';
import {
  getPRs,
  getPRByNumber,
  updatePRState,
  updateMergeState,
  getTaskTitleFromCache,
  upsertPullRequest,
  deletePR,
  deleteMergedAndClosedPRs,
  countMergedAndClosedPRs,
  resetReviewIteration,
  setPRReviewResult,
  updatePRDraftStatus,
} from '../db/queries';
import { GitHubApiError } from '../github/types';
import type { GitHubClient } from '../github/GitHubClient';
import type { PRReviewService } from '../github/PRReviewService';
import type { PRReviewResult } from '../github/PRReviewService';
import type { PRMergeWatcher } from '../github/PRMergeWatcher';
import type { SessionManager } from '../session/SessionManager';
import type { TaskTrackerBackend } from '../tasks/TaskTrackerBackend';
import type { ServerMessage } from '../ws/types';
import { emitTaskUpdated } from './tasks';

let _broadcast: (msg: ServerMessage) => void = () => {};
export function setPRBroadcast(fn: (msg: ServerMessage) => void): void {
  _broadcast = fn;
}

export function createPrsRouter(
  github: GitHubClient,
  prReviewService: PRReviewService,
  sessionManager: SessionManager,
  notionClient: TaskTrackerBackend,
  mergeWatcher?: PRMergeWatcher,
): Router {
  const router = Router();

  // ── GET /api/prs?projectId=<id> ─────────────────────────────────────────────
  router.get('/prs', async (req: Request, res: Response) => {
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
    const rows = getPRs(repo);

    // Reconcile stale open PRs against GitHub state (best-effort)
    const reconciledStates = new Map<number, string>();
    try {
      const openOnGitHub = await github.listOpenPRs(repo);
      const openNumbers = new Set(openOnGitHub.map((p) => p.id));
      const stale = rows.filter((r) => r.state === 'open' && !openNumbers.has(r.pr_number));
      for (const pr of stale) {
        const state = await github.getPRState(pr.pr_number, repo);
        if (state === 'merged' && mergeWatcher) {
          await mergeWatcher.handleMerged(pr, null);
        } else {
          updatePRState(pr.pr_number, repo, state);
        }
        reconciledStates.set(pr.pr_number, state);
      }
    } catch {
      // reconciliation is best-effort; return cached data on GitHub error
    }

    const items = rows.map((pr) => ({
      prNumber: pr.pr_number,
      prUrl: pr.pr_url,
      title: pr.title,
      headBranch: pr.head_branch,
      baseBranch: pr.base_branch,
      state: reconciledStates.get(pr.pr_number) ?? pr.state,
      notionTaskId: pr.notion_task_id,
      notionTaskTitle: pr.notion_task_id ? getTaskTitleFromCache(pr.notion_task_id) : null,
      sessionId: pr.session_id ?? null,
      reviewSessionId: pr.review_session_id ?? null,
      repo: pr.repo,
      reviewResult: pr.review_result
        ? (JSON.parse(pr.review_result) as PRReviewResult)
        : null,
      reviewedAt: pr.review_at,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      reviewIteration: pr.review_iteration,
      mergeState: pr.merge_state ?? null,
    }));
    res.json(items);
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
    let prRow = getPRByNumber(prNumber, repo);
    if (!prRow) {
      // On-demand sync: PR may not have been synced yet (e.g. just created).
      // Fetch the specific PR from GitHub and upsert before retrying.
      try {
        const pr = await github.fetchPR(repo, prNumber);
        const now = new Date().toISOString();
        upsertPullRequest({
          pr_number: pr.id,
          pr_url: pr.url,
          notion_task_id: null,
          session_id: null,
          repo,
          title: pr.title,
          body: pr.body ?? null,
          head_branch: pr.headBranch,
          base_branch: pr.baseBranch,
          state: pr.state,
          draft: pr.draft ? 1 : 0,
          review_result: null,
          review_at: null,
          created_at: pr.createdAt,
          updated_at: pr.updatedAt,
          synced_at: now,
          review_iteration: 0,
          review_session_id: null,
          head_sha: pr.headSha,
          last_reviewed_sha: null,
          node_id: pr.nodeId,
          merge_state: pr.mergeableState,
          merge_state_checked_at: now,
        });
        prRow = getPRByNumber(prNumber, repo);
      } catch {
        // GitHub fetch failed — fall through to 404
      }
    }
    if (!prRow) {
      res.status(404).json({ error: `PR #${prNumber} not found` });
      return;
    }
    const contextUrl = project.contextUrl;
    try {
      const result = await Promise.race([
        prReviewService.reviewPR(prNumber, repo, projectId, contextUrl),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Review timed out')), 120_000),
        ),
      ]);
      _broadcast({
        type: 'pr_review_complete',
        prNumber,
        repo,
        verdict: result.verdict,
        summary: result.summary,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof Error && err.message === 'Review timed out') {
        res.status(504).json({ error: 'Review timed out' });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── POST /api/prs/:owner/:repoName/:prNumber/merge ───────────────────────────
  router.post('/prs/:owner/:repoName/:prNumber/merge', async (req: Request, res: Response) => {
    const repo = `${req.params.owner}/${req.params.repoName}`;
    const prNumber = parseInt(String(req.params.prNumber), 10);
    const prRow = getPRByNumber(prNumber, repo);
    const commitTitle =
      typeof (req.body as { commitTitle?: string }).commitTitle === 'string'
        ? (req.body as { commitTitle: string }).commitTitle
        : prRow?.title ?? `Merge PR #${prNumber}`;
    try {
      const result = await github.mergePR(prNumber, commitTitle, repo);
      updatePRState(prNumber, repo, 'merged');

      // End coding session gracefully (stdin close → clean CLI exit)
      if (prRow?.session_id) {
        sessionManager.endSession(prRow.session_id);
      }

      // End review session gracefully (stdin close → clean CLI exit)
      if (prRow?.review_session_id) {
        sessionManager.endSession(prRow.review_session_id);
      }

      // Update Notion task to Done and broadcast task_updated so the Tasks view refreshes
      if (prRow?.notion_task_id) {
        const taskId = prRow.notion_task_id;
        await notionClient.updateStatus(taskId, '✅ Done')
          .then(() => {
            _broadcast({ type: 'task_status_changed', notionTaskId: taskId, newStatus: '✅ Done' });
            emitTaskUpdated(taskId);
          })
          .catch((err: unknown) =>
            console.warn('[prs] Notion updateStatus failed:', (err as Error).message),
          );
      }

      _broadcast({
        type: 'pr_merged',
        prNumber,
        repo,
        sha: (result as { sha?: string }).sha ?? '',
      });

      res.json(result);
    } catch (err) {
      // Check for GitHubApiError by class or by duck-typing (.status property),
      // since instanceof can fail across module boundaries in some build configs.
      const errStatus: number | null =
        err instanceof GitHubApiError
          ? err.status
          : typeof (err as GitHubApiError).status === 'number'
            ? (err as GitHubApiError).status
            : null;
      if (errStatus === 409 || errStatus === 405) {
        // Merge conflict or not mergeable — persist the conflict state
        updateMergeState(prNumber, repo, 0, 'dirty');
        _broadcast({ type: 'pr_state_changed', prNumber, repo, mergeable: false, mergeState: 'dirty' });
        if (prRow?.notion_task_id) emitTaskUpdated(prRow.notion_task_id);
        res.status(422).json({ error: 'PR has merge conflicts. Use Re-review to have the code session fix them.' });
        return;
      }
      if (errStatus !== null) {
        res.status(422).json({ error: (err as Error).message });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── POST /api/prs/:owner/:repoName/:prNumber/re-review ───────────────────────
  router.post('/prs/:owner/:repoName/:prNumber/re-review', async (req: Request, res: Response) => {
    const repo = `${req.params.owner}/${req.params.repoName}`;
    const prNumber = parseInt(String(req.params.prNumber), 10);
    const prRow = getPRByNumber(prNumber, repo);
    if (!prRow) {
      res.status(404).json({ error: `PR #${prNumber} not found` });
      return;
    }

    // Reset iteration counter so the orchestrator won't block on the cap
    resetReviewIteration(prNumber, repo);

    const project = config.projects.find((p) => p.githubRepo === repo);
    if (!project) {
      res.status(422).json({ error: `No project configured for repo ${repo}` });
      return;
    }
    try {
      const result = await Promise.race([
        prReviewService.reviewPR(prNumber, repo, project.id, project.contextUrl),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Review timed out')), 120_000),
        ),
      ]);
      _broadcast({
        type: 'pr_review_complete',
        prNumber,
        repo,
        verdict: result.verdict,
        summary: result.summary,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof Error && err.message === 'Review timed out') {
        res.status(504).json({ error: 'Review timed out' });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── POST /api/prs/:owner/:repoName/:prNumber/approve ─────────────────────────
  router.post('/prs/:owner/:repoName/:prNumber/approve', async (req: Request, res: Response) => {
    const repo = `${req.params.owner}/${req.params.repoName}`;
    const prNumber = parseInt(String(req.params.prNumber), 10);
    const prRow = getPRByNumber(prNumber, repo);
    if (!prRow) {
      res.status(404).json({ error: `PR #${prNumber} not found` });
      return;
    }
    const result: PRReviewResult = {
      prNumber,
      repo,
      verdict: 'approved',
      dimensions: [],
      summary: 'Manually approved via dashboard',
      reviewedAt: new Date().toISOString(),
    };
    setPRReviewResult(prNumber, repo, JSON.stringify(result));

    // Transition draft → ready on GitHub (always attempt; handles "already not a draft" gracefully)
    try {
      await github.markPRReady(repo, prNumber);
      updatePRDraftStatus(prNumber, repo, 0);
    } catch (e) {
      console.warn(`[prs] markPRReady skipped for PR #${prNumber}:`, e);
    }

    // Update Notion task to In Review
    if (prRow.notion_task_id) {
      await notionClient.updateStatus(prRow.notion_task_id, '👀 In Review').catch((e: unknown) =>
        console.warn('[prs] Notion updateStatus failed:', (e as Error).message),
      );
    }

    _broadcast({
      type: 'pr_review_complete',
      prNumber,
      repo,
      verdict: 'approved',
      summary: result.summary,
    });
    res.json(result);
  });

  // ── DELETE /api/prs/clear?projectId=<id> ────────────────────────────────────
  router.delete('/prs/clear', (req: Request, res: Response) => {
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
    const count = deleteMergedAndClosedPRs(project.githubRepo);
    res.json({ deleted: count });
  });

  // ── GET /api/prs/clear/count?projectId=<id> ──────────────────────────────────
  router.get('/prs/clear/count', (req: Request, res: Response) => {
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
    const count = countMergedAndClosedPRs(project.githubRepo);
    res.json({ count });
  });

  // ── DELETE /api/prs/:prNumber?projectId=<id> ─────────────────────────────────
  router.delete('/prs/:prNumber', (req: Request, res: Response) => {
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
    const deleted = deletePR(prNumber, project.githubRepo);
    if (!deleted) {
      res.status(404).json({ error: `PR #${prNumber} not found` });
      return;
    }
    res.json({ ok: true });
  });

  // ── GET /api/prs/:prNumber/diff?projectId=<id> ───────────────────────────────
  router.get('/prs/:prNumber/diff', async (req: Request, res: Response) => {
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
    try {
      const result = await github.fetchDiff(prNumber, repo);
      res.json({ diff: result.diff, filesChanged: result.filesChanged });
    } catch (err) {
      if (err instanceof GitHubApiError) {
        res.status(err.status).json({ error: err.message });
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
    const failingDimensions = (reviewResult.dimensions ?? []).filter((d) => !d.passed);
    const lines = failingDimensions.map((d) => `❌ ${d.name}: ${d.notes}`).join('\n');
    const fixMessage =
      `PR #${prNumber} review findings — please address the following:\n\n${lines}\n\nOverall: ${reviewResult.summary}`;
    await sessionManager.sendOrResume(prRow.session_id, fixMessage);
    res.json({ sessionId: prRow.session_id });
  });

  return router;
}
