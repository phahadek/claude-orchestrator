import { getProjectByGithubRepo, getProjectById } from '../config';
import {
  setPRReviewResult,
  getSetting,
  getPRByNumber,
  setPendingPush,
  setPauseReason,
  getLocalBranchBySession,
  setLocalBranchPauseReason,
  getSession,
} from '../db/queries';
import type {
  PRReviewService,
  PRReviewResult,
  WorkItem,
} from './PRReviewService';
import { FetchRetryExhaustedError } from './PRReviewService';
import type { SessionManager } from '../session/SessionManager';
import type { GitHubClient } from './GitHubClient';
import type { ReviewJob } from './types';
import { GitHubDiffSource, LocalDiffSource } from './DiffSource';
import { formatReviewFeedback, formatCIFailureFeedback } from './reviewUtils';
import { runVerifyAsGate } from '../orchestration/verifyRunner';
import { loadOrchestratorConfig } from '../session/orchestrator-config';
import { loadAutofixCommands, runAutofix } from '../session/autofix-runner';
import { runFilePollutionCheck } from '../session/filePollutionCheck';
import { recordEvent } from '../audit/AuditLog';
import type { ServerMessage } from '../ws/types';

const REVIEW_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ITERATIONS = 3;

function getMaxReviewIterations(): number {
  const raw = getSetting('max_review_iterations');
  if (!raw) return DEFAULT_MAX_ITERATIONS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_ITERATIONS;
}

interface LocalBranchJob {
  type: 'local_branch';
  localBranchId: number;
  projectId: string;
  sessionId: string;
  branchName: string;
  baseBranch: string;
  worktreePath: string;
  taskId: string | null;
  contextUrl: string;
}

type QueuedJob = (ReviewJob & { type?: 'pr' }) | LocalBranchJob;

export class ReviewOrchestrator {
  private queue: QueuedJob[] = [];
  private running = 0;
  /** SHA of the last autofix commit per PR, keyed by "prNumber:repo". */
  private lastAutofixShas = new Map<string, string>();
  /** In-flight post-revert worktree sync promises, keyed by "prNumber:repo". */
  private pendingSyncs = new Map<string, Promise<void>>();

  constructor(
    private reviewService: PRReviewService,
    private sessionManager: SessionManager,
    private maxConcurrency: number = 1,
    private enabled: boolean = true,
    private github?: GitHubClient,
  ) {
    sessionManager.on('pr_opened', (job: ReviewJob) => this.onPrOpened(job));
    sessionManager.on('message', (msg: ServerMessage) => this.onMessage(msg));
    sessionManager.on(
      'revert_sync_registered',
      (payload: {
        prNumber: number;
        repo: string;
        syncPromise: Promise<void>;
      }) => {
        this.registerRevertSync(
          payload.prNumber,
          payload.repo,
          payload.syncPromise,
        );
      },
    );
  }

  /** Store a pending sync promise so executeReview can await it before fetching the diff. */
  registerRevertSync(
    prNumber: number,
    repo: string,
    syncPromise: Promise<void>,
  ): void {
    const key = `${prNumber}:${repo}`;
    this.pendingSyncs.set(key, syncPromise);
  }

  private onPrOpened(job: ReviewJob): void {
    if (!this.enabled) return;
    if (!job.taskId) {
      console.warn(
        `[ReviewOrchestrator] PR #${job.prNumber} has no Notion task — skipping`,
      );
      return;
    }
    this.queue.push(job);
    void this.drain();
  }

  private onMessage(msg: ServerMessage): void {
    if (!this.enabled) return;
    if (msg.type !== 'local_branch_submitted') return;

    const { projectId, sessionId, branchName, baseBranch } = msg;

    const sessionRow = getSession(sessionId);
    if (!sessionRow?.worktree_path) {
      console.warn(
        `[ReviewOrchestrator] local_branch_submitted for session ${sessionId} — no worktree_path, skipping`,
      );
      return;
    }

    const localBranchRow = getLocalBranchBySession(sessionId);
    if (!localBranchRow) {
      console.warn(
        `[ReviewOrchestrator] local_branch_submitted for session ${sessionId} — no local_branch row found, skipping`,
      );
      return;
    }

    const project = getProjectById(projectId);
    const contextUrl = project?.contextUrl ?? '';

    this.queue.push({
      type: 'local_branch',
      localBranchId: localBranchRow.id,
      projectId,
      sessionId,
      branchName,
      baseBranch,
      worktreePath: sessionRow.worktree_path,
      taskId: sessionRow.task_id,
      contextUrl,
    });
    void this.drain();
  }

  private async drain(): Promise<void> {
    while (this.running < this.maxConcurrency && this.queue.length > 0) {
      this.running++;
      const job = this.queue.shift()!;
      try {
        if (job.type === 'local_branch') {
          await this.executeLocalBranchReview(job);
        } else {
          await this.executeReview(job as ReviewJob);
        }
      } catch (e) {
        if (job.type === 'local_branch') {
          console.error(
            `[ReviewOrchestrator] review failed for local branch ${job.branchName}:`,
            e,
          );
        } else {
          const prJob = job as ReviewJob;
          console.error(
            `[ReviewOrchestrator] review failed for PR #${prJob.prNumber}:`,
            e,
          );
        }
      } finally {
        this.running--;
        void this.drain();
      }
    }
  }

  /**
   * Runs the autofix + file-pollution-check pipeline for a PR.
   * Called from both executeReview (first review) and the server.ts
   * push_detected re-review path so every push goes through the same pipeline.
   */
  async runAutofixPipeline(
    prNumber: number,
    repo: string,
    taskId: string | null,
  ): Promise<void> {
    const project = getProjectByGithubRepo(repo);
    if (!project) return;

    const autofixCommands = loadAutofixCommands(project.projectDir);
    if (autofixCommands.length === 0) return;

    this.sessionManager.emit('message', {
      type: 'autofix_started',
      prNumber,
      repo,
    });

    const prRow = getPRByNumber(prNumber, repo);
    const worktreePath = prRow?.session_id
      ? (getSession(prRow.session_id)?.worktree_path ?? '')
      : '';

    let autofixSuccess = true;
    let autofixSummary = 'no worktree available — autofix skipped';

    if (worktreePath) {
      try {
        const result = await runAutofix(
          worktreePath,
          project.projectDir,
          autofixCommands,
          (msg) =>
            console.log(`[ReviewOrchestrator] autofix PR #${prNumber}: ${msg}`),
        );
        autofixSuccess = result.success;
        autofixSummary = result.summary;
        if (result.commitSha) {
          this.lastAutofixShas.set(`${prNumber}:${repo}`, result.commitSha);
          if (prRow?.session_id && result.touchedFiles?.length) {
            this.sessionManager.addToRevertLock(
              prRow.session_id,
              result.touchedFiles,
            );
          }
          if (this.github) {
            await runFilePollutionCheck({
              github: this.github,
              worktreePath,
              repo,
              prNumber,
              baseBranch: prRow?.base_branch ?? 'dev',
              sessionId: prRow?.session_id ?? null,
              projectId: project.id,
              taskId,
              onReverted: (files) => {
                if (prRow?.session_id) {
                  this.sessionManager.addToRevertLock(prRow.session_id, files);
                }
              },
            });
          }
        }
      } catch (err) {
        autofixSuccess = false;
        autofixSummary = `autofix threw: ${String(err)}`;
        console.error(
          `[ReviewOrchestrator] autofix error for PR #${prNumber}:`,
          err,
        );
      }
    }

    this.sessionManager.emit('message', {
      type: 'autofix_complete',
      prNumber,
      repo,
      success: autofixSuccess,
      summary: autofixSummary,
    });

    if (!autofixSuccess) {
      console.warn(
        `[ReviewOrchestrator] autofix failed for PR #${prNumber} (fail open): ${autofixSummary}`,
      );
    }
  }

  /**
   * Returns true (and consumes the entry) when the given SHA is the autofix
   * commit that was pushed during the last runAutofixPipeline() for this PR.
   * Used by the push_detected handler to skip re-reviews for autofix-only pushes
   * so they do not count against the iteration cap.
   */
  consumeAutofixSha(prNumber: number, repo: string, sha: string): boolean {
    const key = `${prNumber}:${repo}`;
    if (this.lastAutofixShas.get(key) === sha) {
      this.lastAutofixShas.delete(key);
      return true;
    }
    return false;
  }

  private async executeLocalBranchReview(job: LocalBranchJob): Promise<void> {
    const project = getProjectById(job.projectId);
    if (project) {
      const config = loadOrchestratorConfig(project.projectDir);
      const verifyResult = await runVerifyAsGate(
        job.worktreePath,
        config.verify,
      );
      if (!verifyResult.passed) {
        const autofixCommands = loadAutofixCommands(project.projectDir);
        if (autofixCommands.length > 0) {
          try {
            const autofixResult = await runAutofix(
              job.worktreePath,
              project.projectDir,
              autofixCommands,
              (msg) =>
                console.log(
                  `[ReviewOrchestrator] autofix local branch ${job.branchName}: ${msg}`,
                ),
            );
            if (autofixResult.commitSha) {
              recordEvent({
                event_type: 'autofix_for_ci_failure',
                actor_type: 'system',
                task_id: job.taskId ?? null,
                payload: {
                  pr_number: job.localBranchId,
                  commit_sha: autofixResult.commitSha,
                  failing_checks: verifyResult.failedCommand
                    ? [verifyResult.failedCommand]
                    : [],
                  source: 'verify',
                },
              });
              // Re-run verify to see if autofix resolved it
              const retryResult = await runVerifyAsGate(
                job.worktreePath,
                config.verify,
              );
              if (retryResult.passed) {
                // Autofix fixed the gate — fall through to AI review
              } else {
                setLocalBranchPauseReason(job.localBranchId, 'ci_failing');
                this.sessionManager.send(
                  job.sessionId,
                  formatCIFailureFeedback({
                    source: 'verify',
                    failedCommand: retryResult.failedCommand,
                    truncatedOutput: retryResult.truncatedOutput,
                  }),
                );
                return;
              }
            } else {
              setLocalBranchPauseReason(job.localBranchId, 'ci_failing');
              this.sessionManager.send(
                job.sessionId,
                formatCIFailureFeedback({
                  source: 'verify',
                  failedCommand: verifyResult.failedCommand,
                  truncatedOutput: verifyResult.truncatedOutput,
                }),
              );
              return;
            }
          } catch (err) {
            console.warn(
              `[ReviewOrchestrator] autofix error for local branch ${job.branchName}:`,
              err,
            );
            setLocalBranchPauseReason(job.localBranchId, 'ci_failing');
            this.sessionManager.send(
              job.sessionId,
              formatCIFailureFeedback({
                source: 'verify',
                failedCommand: verifyResult.failedCommand,
                truncatedOutput: verifyResult.truncatedOutput,
              }),
            );
            return;
          }
        } else {
          setLocalBranchPauseReason(job.localBranchId, 'ci_failing');
          this.sessionManager.send(
            job.sessionId,
            formatCIFailureFeedback({
              source: 'verify',
              failedCommand: verifyResult.failedCommand,
              truncatedOutput: verifyResult.truncatedOutput,
            }),
          );
          return;
        }
      }
    }

    const diffSource = new LocalDiffSource(
      job.worktreePath,
      job.baseBranch,
      job.branchName,
    );

    const workItem: WorkItem = {
      type: 'local_branch',
      localBranchId: job.localBranchId,
      branchName: job.branchName,
      baseBranch: job.baseBranch,
      sessionId: job.sessionId,
      taskId: job.taskId,
    };

    let result: PRReviewResult;
    try {
      result = await Promise.race([
        this.reviewService.reviewPR(
          workItem,
          diffSource,
          job.projectId,
          job.contextUrl,
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Review timed out')),
            REVIEW_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (e) {
      const summary =
        e instanceof Error && e.message === 'Review timed out'
          ? 'Review timed out'
          : String(e);
      this.sessionManager.emit('message', {
        type: 'pr_review_complete',
        prNumber: job.localBranchId,
        repo: `local/${job.branchName}`,
        verdict: 'error',
        summary,
      });
      return;
    }

    this.sessionManager.emit('message', {
      type: 'pr_review_complete',
      prNumber: job.localBranchId,
      repo: `local/${job.branchName}`,
      verdict: result.verdict,
      summary: result.summary,
    });

    if (result.verdict === 'needs_changes') {
      this.sessionManager.send(job.sessionId, formatReviewFeedback(result, 0));
    }
  }

  private async executeReview(job: ReviewJob): Promise<void> {
    // Await any in-flight post-revert worktree sync before fetching the diff,
    // so the review sees the canonical file state, not the contaminated version.
    const syncKey = `${job.prNumber}:${job.repo}`;
    const pendingSync = this.pendingSyncs.get(syncKey);
    if (pendingSync) {
      this.pendingSyncs.delete(syncKey);
      await pendingSync;
    }

    const project = getProjectByGithubRepo(job.repo);
    if (!project) {
      console.warn(
        `[ReviewOrchestrator] PR #${job.prNumber}: no project found for repo ${job.repo} — skipping`,
      );
      return;
    }

    // Check iteration cap before starting a review
    const prRow = getPRByNumber(job.prNumber, job.repo);
    const maxIterations = getMaxReviewIterations();
    if (prRow && prRow.review_iteration >= maxIterations) {
      const message = `Review loop for PR #${job.prNumber} reached ${maxIterations} iterations without approval. Manual intervention needed.`;
      console.warn(`[ReviewOrchestrator] ${message}`);
      setPauseReason(job.prNumber, job.repo, 'max_reviews');
      this.sessionManager.emit('message', {
        type: 'review_escalated',
        prNumber: job.prNumber,
        repo: job.repo,
        message,
      });
      return;
    }

    // ── Autofix + file-pollution-check step ──────────────────────────────────
    await this.runAutofixPipeline(job.prNumber, job.repo, job.taskId ?? null);
    // ─────────────────────────────────────────────────────────────────────────

    this.sessionManager.emit('message', {
      type: 'review_started',
      prNumber: job.prNumber,
      sessionId: prRow?.review_session_id ?? '',
    });

    const diffSource = this.github
      ? new GitHubDiffSource(this.github, job.repo, job.prNumber)
      : {
          fetchDiff: async () => {
            throw new Error('No GitHub client available for diff');
          },
        };

    const workItem: WorkItem = {
      type: 'pr',
      prNumber: job.prNumber,
      repo: job.repo,
    };

    let result: PRReviewResult;
    try {
      result = await Promise.race([
        this.reviewService.reviewPR(
          workItem,
          diffSource,
          project.id,
          job.contextUrl,
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Review timed out')),
            REVIEW_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (e) {
      if (e instanceof FetchRetryExhaustedError) {
        // review_failed was already emitted by PRReviewService; leave review_result null
        return;
      }
      const summary =
        e instanceof Error && e.message === 'Review timed out'
          ? 'Review timed out'
          : String(e);
      setPRReviewResult(
        job.prNumber,
        job.repo,
        JSON.stringify({ verdict: 'error', summary, dimensions: [] }),
      );
      this.sessionManager.emit('message', {
        type: 'pr_review_complete',
        prNumber: job.prNumber,
        repo: job.repo,
        verdict: 'error',
        summary,
      });
      return;
    }

    // Draft transition and Notion update are handled inside reviewService.reviewPR()
    // via handleApprovedVerdict. Derive draftTransitioned from the pre-review row so
    // we can include draft: false in the broadcast when applicable.
    const draftTransitioned =
      result.verdict === 'approved' && prRow?.draft === 1;

    this.sessionManager.emit('message', {
      type: 'pr_review_complete',
      prNumber: job.prNumber,
      repo: job.repo,
      verdict: result.verdict,
      summary: result.summary,
      ...(draftTransitioned && { draft: false }),
    });

    // Route feedback to coding session if verdict requires changes
    if (result.verdict === 'needs_changes') {
      const prRow = getPRByNumber(job.prNumber, job.repo);
      if (prRow?.session_id) {
        this.sessionManager.send(
          prRow.session_id,
          formatReviewFeedback(result, 0),
        );
      }
    } else if (result.verdict === 'incomplete') {
      const message = `Review for PR #${job.prNumber} returned an incomplete verdict — the reviewer could not assess the PR. Manual intervention needed.`;
      console.warn(`[ReviewOrchestrator] ${message}`);
      this.sessionManager.emit('message', {
        type: 'review_incomplete',
        prNumber: job.prNumber,
        repo: job.repo,
        message,
      });
    }

    // After the initial review, check if a push arrived during the review window.
    // If so, clear the flag and trigger re-review via push_detected so the
    // standard re-review path (server.ts push_detected handler) handles it,
    // now that review_session_id is populated.
    const postReviewRow = getPRByNumber(job.prNumber, job.repo);
    if (postReviewRow?.pending_push && postReviewRow.session_id) {
      setPendingPush(job.prNumber, job.repo, 0);
      console.log(
        `[ReviewOrchestrator] pending_push detected for PR #${job.prNumber} — triggering re-review`,
      );
      this.sessionManager.emit('push_detected', {
        sessionId: postReviewRow.session_id,
      });
    }
  }
}
