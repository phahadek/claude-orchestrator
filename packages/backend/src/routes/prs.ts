import { Router } from 'express';
import type { Request, Response } from 'express';
import { getProjectById, getProjectByGithubRepo } from '../config';
import { loadOrchestratorConfig } from '../session/orchestrator-config';
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
  getSessionsByProject,
  lookupSessionByBranch,
} from '../db/queries';
import { GitHubApiError } from '../github/types';
import type { MergeabilityCategory } from '../github/types';
import type { GitHubClient } from '../github/GitHubClient';
import type { PRReviewService } from '../github/PRReviewService';
import type { PRReviewResult } from '../github/PRReviewService';
import { GitHubDiffSource } from '../github/DiffSource';
import type { PRMergeWatcher } from '../github/PRMergeWatcher';
import type { AutoMerger } from '../github/AutoMerger';
import type { SessionManager } from '../session/SessionManager';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { TaskBackend } from '../tasks/TaskBackend';
import type { ServerMessage } from '../ws/types';
import { emitTaskUpdated } from './tasks';
import { recordEvent } from '../audit/AuditLog';
import type { DeviceRow } from '../db/types';

let _broadcast: (msg: ServerMessage) => void = () => {};
export function setPRBroadcast(fn: (msg: ServerMessage) => void): void {
  _broadcast = fn;
}

function parseFailingChecks(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

export function createPrsRouter(
  github: GitHubClient,
  prReviewService: PRReviewService,
  sessionManager: SessionManager,
  /**
   * Optional fixed task backend used by tests. In production this is undefined
   * and the backend is resolved per-call via `getTaskBackend(project.id)`.
   */
  taskBackendOverride?: TaskBackend,
  mergeWatcher?: PRMergeWatcher,
  autoMerger?: AutoMerger,
): Router {
  const router = Router();

  function resolveBackendForRepo(repo: string): TaskBackend | undefined {
    if (taskBackendOverride) return taskBackendOverride;
    const project = getProjectByGithubRepo(repo);
    return project ? getTaskBackend(project.id) : undefined;
  }

  // ── GET /api/prs?projectId=<id> ─────────────────────────────────────────────
  router.get('/prs', async (req: Request, res: Response) => {
    const projectId =
      typeof req.query.projectId === 'string' ? req.query.projectId : '';
    if (!projectId) {
      res.status(400).json({ error: 'projectId query param is required' });
      return;
    }
    const project = getProjectById(projectId);
    if (!project) {
      res.status(400).json({ error: 'Project not found' });
      return;
    }

    const autoMergeEnabled = project.autoMergeEnabled;

    // Local-only projects: return code sessions as unified local_branch items
    if (project.gitMode === 'local-only') {
      const sessions = getSessionsByProject(projectId);
      const codeSessions = sessions.filter(
        (s) => s.session_type === 'standard' && !s.archived,
      );
      const reviewSessions = sessions.filter(
        (s) => s.session_type === 'review',
      );

      // Build map of task_id -> latest review session result
      const reviewResultByTask = new Map<string, PRReviewResult>();
      for (const rs of reviewSessions) {
        if (!rs.task_id || !rs.review_result) continue;
        const existing = reviewResultByTask.get(rs.task_id);
        if (!existing) {
          try {
            reviewResultByTask.set(
              rs.task_id,
              JSON.parse(rs.review_result) as PRReviewResult,
            );
          } catch {
            // skip malformed JSON
          }
        }
      }

      const localItems = codeSessions.map((s) => ({
        type: 'local_branch' as const,
        sessionId: s.session_id,
        branchName: `session/${s.session_id}`,
        baseBranch: 'dev',
        status: s.status,
        reviewResult: s.task_id
          ? (reviewResultByTask.get(s.task_id) ?? null)
          : null,
        createdAt: new Date(s.started_at).toISOString(),
        autoMergeEnabled,
        notionTaskId: s.task_id,
        notionTaskTitle: s.task_id ? getTaskTitleFromCache(s.task_id) : null,
      }));
      res.json(localItems);
      return;
    }

    if (!project.githubRepo) {
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
      const stale = rows.filter(
        (r) => r.state === 'open' && !openNumbers.has(r.pr_number),
      );
      for (const pr of stale) {
        const prStateResult = await github.getPRState(pr.pr_number, repo);
        const state = prStateResult.state;
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
      type: 'pr' as const,
      prNumber: pr.pr_number,
      prUrl: pr.pr_url,
      title: pr.title,
      headBranch: pr.head_branch,
      branchName: pr.head_branch ?? '',
      baseBranch: pr.base_branch ?? '',
      state: reconciledStates.get(pr.pr_number) ?? pr.state,
      notionTaskId: pr.task_id,
      notionTaskTitle: pr.task_id ? getTaskTitleFromCache(pr.task_id) : null,
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
      failingChecks: parseFailingChecks(pr.failing_checks),
      pauseReason: pr.pause_reason ?? null,
      autoMergeEnabled,
    }));
    res.json(items);
  });

  // ── POST /api/prs/:prNumber/review ──────────────────────────────────────────
  router.post('/prs/:prNumber/review', async (req: Request, res: Response) => {
    const prNumber = parseInt(String(req.params.prNumber), 10);
    const projectId =
      typeof req.query.projectId === 'string' ? req.query.projectId : '';
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
        const sessionMatch = lookupSessionByBranch(pr.headBranch);
        upsertPullRequest({
          pr_number: pr.id,
          pr_url: pr.url,
          task_id: sessionMatch?.task_id ?? null,
          session_id: sessionMatch?.session_id ?? null,
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
        if (sessionMatch) {
          console.log(
            `[prs] on-demand sync PR #${prNumber}: linked session ${sessionMatch.session_id.slice(0, 8)} via head_branch "${pr.headBranch}"`,
          );
        }
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
        prReviewService.reviewPR(
          { type: 'pr', prNumber, repo },
          new GitHubDiffSource(github, repo, prNumber),
          projectId,
          contextUrl,
        ),
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

  // ── GET /api/prs/:owner/:repoName/:prNumber/mergeability ─────────────────────
  // Fresh mergeability check used by the frontend right before opening a merge.
  // Persists the categorized merge_state (clean / dirty / ci_failed / blocked /
  // unknown) so the dashboard can show category-specific blockers consistently
  // with the periodic watcher poll.
  router.get(
    '/prs/:owner/:repoName/:prNumber/mergeability',
    async (req: Request, res: Response) => {
      const repo = `${req.params.owner}/${req.params.repoName}`;
      const prNumber = parseInt(String(req.params.prNumber), 10);
      try {
        const repoProject = getProjectByGithubRepo(repo);
        const ciCheckNames = repoProject
          ? loadOrchestratorConfig(repoProject.projectDir).ci_check_name
          : [];
        const category = await github.categorizeMergeability(
          prNumber,
          repo,
          ciCheckNames,
        );
        const failingNames = category.failingChecks.map((c) => c.name);
        const failingNamesOrNull =
          failingNames.length > 0 ? failingNames : null;
        const mergeable =
          category.category === 'clean'
            ? true
            : category.category === 'unknown' &&
                category.rawMergeableState === null
              ? null
              : false;
        const prRow = getPRByNumber(prNumber, repo);
        if (prRow && prRow.merge_state !== category.mergeState) {
          const mergeableInt = mergeable === null ? null : mergeable ? 1 : 0;
          updateMergeState(
            prNumber,
            repo,
            mergeableInt,
            category.mergeState,
            failingNamesOrNull,
          );
          _broadcast({
            type: 'pr_mergeability_changed',
            prNumber,
            repo,
            mergeable,
            mergeState: category.mergeState,
            failingChecks: failingNamesOrNull,
          });
          if (prRow.task_id) emitTaskUpdated(prRow.task_id);
        }
        res.json({
          mergeable,
          mergeState: category.mergeState,
          category: category.category,
          failingChecks: failingNames,
        });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // ── POST /api/prs/:owner/:repoName/:prNumber/merge ───────────────────────────
  router.post(
    '/prs/:owner/:repoName/:prNumber/merge',
    async (req: Request, res: Response) => {
      const repo = `${req.params.owner}/${req.params.repoName}`;
      const prNumber = parseInt(String(req.params.prNumber), 10);
      const mergeProject = getProjectByGithubRepo(repo);
      const mergeCiCheckNames = mergeProject
        ? loadOrchestratorConfig(mergeProject.projectDir).ci_check_name
        : [];
      const prRow = getPRByNumber(prNumber, repo);
      const commitTitle =
        typeof (req.body as { commitTitle?: string }).commitTitle === 'string'
          ? (req.body as { commitTitle: string }).commitTitle
          : (prRow?.title ?? `Merge PR #${prNumber}`);

      // Pre-merge mergeability check: ask GitHub directly (with retry) right before
      // attempting the merge. Catches the case where the base branch received new
      // commits between review and merge, which leaves the stored merge_state stale.
      try {
        const { mergeable, mergeableState } =
          await github.getMergeabilityWithRetry(prNumber, repo);
        if (mergeable === false) {
          // Persist conflict state, broadcast, and message the code session
          updateMergeState(prNumber, repo, 0, mergeableState ?? 'dirty');
          _broadcast({
            type: 'pr_mergeability_changed',
            prNumber,
            repo,
            mergeable: false,
            mergeState: mergeableState ?? 'dirty',
          });
          if (prRow?.task_id) emitTaskUpdated(prRow.task_id);
          if (prRow?.session_id) {
            const baseBranch = prRow.base_branch ?? 'dev';
            const msg = `PR #${prNumber} has merge conflicts with the base branch. Rebase onto \`${baseBranch}\`, resolve the conflicts, and push the fixed branch.`;
            sessionManager
              .sendOrResume(prRow.session_id, msg)
              .catch((err: unknown) =>
                console.warn(
                  '[prs] sendOrResume failed:',
                  (err as Error).message,
                ),
              );
          }
          res.status(422).json({
            error:
              'PR has merge conflicts. Use Fix Conflicts to have the code session rebase and resolve them.',
          });
          return;
        }
        // mergeable === null after retries: GitHub still computing. Fall through to
        // the actual merge attempt — the 409/405 catch path below will handle a true conflict.
      } catch (err) {
        // Pre-check error is non-fatal — fall through to the merge attempt
        console.warn(
          `[prs] pre-merge mergeability check failed for PR #${prNumber}:`,
          (err as Error).message,
        );
      }

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

        // Update task to Done via the project-scoped task backend and broadcast task_updated
        if (prRow?.task_id) {
          const taskId = prRow.task_id;
          const backend = resolveBackendForRepo(repo);
          if (backend) {
            try {
              await backend.updateStatus(taskId, '✅ Done', {
                source: 'orchestrator',
              });
              _broadcast({
                type: 'task_status_changed',
                notionTaskId: taskId,
                newStatus: '✅ Done',
              });
              emitTaskUpdated(taskId);
            } catch (err: unknown) {
              console.warn(
                '[prs] task backend updateStatus failed:',
                (err as Error).message,
              );
            }
          }
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
          // Merge blocked — categorize by querying GitHub for mergeable_state +
          // check-runs so we can tell merge conflicts apart from CI failures and
          // branch-protection blocks. The agent only gets a session message for
          // categories it can act on (conflicts → rebase, ci_failed → fix).
          let category: MergeabilityCategory;
          try {
            category = await github.categorizeMergeability(
              prNumber,
              repo,
              mergeCiCheckNames,
            );
          } catch (catErr) {
            console.warn(
              '[prs] categorizeMergeability failed:',
              (catErr as Error).message,
            );
            // Fallback to conflict — historical default.
            category = {
              category: 'conflict',
              mergeState: 'dirty',
              rawMergeableState: null,
              failingChecks: [],
              headSha: null,
            };
          }
          // GitHub may briefly still report 'clean' while the merge is failing
          // for some other reason; downgrade to 'unknown' rather than lying.
          if (category.category === 'clean') {
            category = {
              category: 'unknown',
              mergeState: 'unknown',
              rawMergeableState: category.rawMergeableState,
              failingChecks: [],
              headSha: null,
            };
          }

          const failingNames = category.failingChecks.map((c) => c.name);
          const failingNamesOrNull =
            failingNames.length > 0 ? failingNames : null;
          updateMergeState(
            prNumber,
            repo,
            0,
            category.mergeState,
            failingNamesOrNull,
          );
          _broadcast({
            type: 'pr_mergeability_changed',
            prNumber,
            repo,
            mergeable: false,
            mergeState: category.mergeState,
            failingChecks: failingNamesOrNull,
          });
          if (prRow?.task_id) emitTaskUpdated(prRow.task_id);

          let errorMessage: string;
          switch (category.category) {
            case 'conflict':
              errorMessage =
                'PR has merge conflicts. Use Fix Conflicts to have the code session rebase and resolve them.';
              if (prRow?.session_id) {
                const baseBranch = prRow.base_branch ?? 'dev';
                const msg = `PR #${prNumber} has merge conflicts with the base branch. Rebase onto \`${baseBranch}\`, resolve the conflicts, and push the fixed branch.`;
                sessionManager
                  .sendOrResume(prRow.session_id, msg)
                  .catch((sendErr: unknown) =>
                    console.warn(
                      '[prs] sendOrResume failed:',
                      (sendErr as Error).message,
                    ),
                  );
              }
              break;
            case 'ci_failed':
              errorMessage =
                failingNames.length > 0
                  ? `PR cannot merge — required CI checks are failing: ${failingNames.join(', ')}`
                  : 'PR cannot merge — required CI checks are failing';
              if (prRow?.session_id) {
                const msg =
                  failingNames.length > 0
                    ? `PR #${prNumber} cannot be merged because the following CI checks are failing: ${failingNames.join(', ')}. Investigate the failures and push a fix.`
                    : `PR #${prNumber} cannot be merged because required CI checks are failing. Investigate the failures and push a fix.`;
                sessionManager
                  .sendOrResume(prRow.session_id, msg)
                  .catch((sendErr: unknown) =>
                    console.warn(
                      '[prs] sendOrResume failed:',
                      (sendErr as Error).message,
                    ),
                  );
              }
              break;
            case 'blocked':
              errorMessage =
                'PR is blocked by branch protection (e.g. a required review is missing). Resolve on GitHub before merging.';
              break;
            case 'unknown':
            default:
              errorMessage =
                'Merge failed and GitHub did not report a definitive reason — try again in a moment.';
              break;
          }
          res.status(422).json({
            error: errorMessage,
            category: category.category,
            failingChecks: failingNames,
          });
          return;
        }
        if (errStatus !== null) {
          res.status(422).json({ error: (err as Error).message });
          return;
        }
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // ── POST /api/prs/:owner/:repoName/:prNumber/re-review ───────────────────────
  router.post(
    '/prs/:owner/:repoName/:prNumber/re-review',
    async (req: Request, res: Response) => {
      const repo = `${req.params.owner}/${req.params.repoName}`;
      const prNumber = parseInt(String(req.params.prNumber), 10);
      const prRow = getPRByNumber(prNumber, repo);
      if (!prRow) {
        res.status(404).json({ error: `PR #${prNumber} not found` });
        return;
      }

      // Reset iteration counter so the orchestrator won't block on the cap
      resetReviewIteration(prNumber, repo);

      const project = getProjectByGithubRepo(repo);
      if (!project) {
        res
          .status(422)
          .json({ error: `No project configured for repo ${repo}` });
        return;
      }
      try {
        const result = await Promise.race([
          prReviewService.reviewPR(
            { type: 'pr', prNumber, repo },
            new GitHubDiffSource(github, repo, prNumber),
            project.id,
            project.contextUrl,
          ),
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
    },
  );

  // ── POST /api/prs/:owner/:repoName/:prNumber/approve ─────────────────────────
  router.post(
    '/prs/:owner/:repoName/:prNumber/approve',
    async (req: Request, res: Response) => {
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

      // Update task status to In Review via the project-scoped task backend
      if (prRow.task_id) {
        const backend = resolveBackendForRepo(repo);
        if (backend) {
          await backend
            .updateStatus(prRow.task_id, '👀 In Review', {
              source: 'orchestrator',
            })
            .catch((e: unknown) =>
              console.warn(
                '[prs] task backend updateStatus failed:',
                (e as Error).message,
              ),
            );
        }
      }

      _broadcast({
        type: 'pr_review_complete',
        prNumber,
        repo,
        verdict: 'approved',
        summary: result.summary,
      });
      // Kick off auto-merge for projects with the toggle enabled (no-op otherwise)
      if (autoMerger) autoMerger.attempt(prNumber, repo);
      res.json(result);
    },
  );

  // ── DELETE /api/prs/clear?projectId=<id> ────────────────────────────────────
  router.delete('/prs/clear', (req: Request, res: Response) => {
    const projectId =
      typeof req.query.projectId === 'string' ? req.query.projectId : '';
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
    const deviceId = (req as Request & { device?: DeviceRow }).device?.id ?? null;
    recordEvent({
      event_type: 'manual_pr_clear',
      actor_type: 'user',
      actor_id: deviceId,
      project_id: projectId,
      task_id: null,
      payload: { repo: project.githubRepo, deleted_count: count },
    });
    res.json({ deleted: count });
  });

  // ── GET /api/prs/clear/count?projectId=<id> ──────────────────────────────────
  router.get('/prs/clear/count', (req: Request, res: Response) => {
    const projectId =
      typeof req.query.projectId === 'string' ? req.query.projectId : '';
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
    const projectId =
      typeof req.query.projectId === 'string' ? req.query.projectId : '';
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
    const projectId =
      typeof req.query.projectId === 'string' ? req.query.projectId : '';
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

  // ── POST /api/prs/:owner/:repoName/:prNumber/fix-conflicts ──────────────────
  router.post(
    '/prs/:owner/:repoName/:prNumber/fix-conflicts',
    async (req: Request, res: Response) => {
      const repo = `${req.params.owner}/${req.params.repoName}`;
      const prNumber = parseInt(String(req.params.prNumber), 10);
      const prRow = getPRByNumber(prNumber, repo);
      if (!prRow) {
        res.status(404).json({ error: `PR #${prNumber} not found` });
        return;
      }
      if (!prRow.session_id) {
        res.status(422).json({ error: 'No code session linked to this PR' });
        return;
      }
      const message =
        `PR #${prNumber} has merge conflicts with the base branch. ` +
        `Please rebase onto \`dev\`, resolve the conflicts, and push the fixed branch.`;
      const sessionId = await sessionManager.sendOrResume(
        prRow.session_id,
        message,
      );
      // Reset merge state so PRMergeWatcher will re-check after the push
      updateMergeState(prNumber, repo, null, null);
      _broadcast({
        type: 'pr_mergeability_changed',
        prNumber,
        repo,
        mergeable: null,
        mergeState: null,
      });
      if (prRow.task_id) emitTaskUpdated(prRow.task_id);
      res.json({ sessionId });
    },
  );

  // ── POST /api/prs/:prNumber/fix ──────────────────────────────────────────────
  router.post('/prs/:prNumber/fix', async (req: Request, res: Response) => {
    const prNumber = parseInt(String(req.params.prNumber), 10);
    const projectId =
      typeof req.query.projectId === 'string' ? req.query.projectId : '';
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
    const failingDimensions = (reviewResult.dimensions ?? []).filter(
      (d) => !d.passed,
    );
    const lines = failingDimensions
      .map((d) => `❌ ${d.name}: ${d.notes}`)
      .join('\n');
    const fixMessage = `PR #${prNumber} review findings — please address the following:\n\n${lines}\n\nOverall: ${reviewResult.summary}`;
    await sessionManager.sendOrResume(prRow.session_id, fixMessage);
    res.json({ sessionId: prRow.session_id });
  });

  return router;
}
