import { logger } from '../logger';
import {
  getProjectByGithubRepo,
  getProjectById,
  runtimeSettings,
} from '../config';
import { typedGetSetting } from '../config/settings';
import {
  setPRReviewResult,
  getPRByNumber,
  setPendingPush,
  setPauseReason,
  getLocalBranchBySession,
  setLocalBranchPauseReason,
  getSession,
  addAutofixSha,
  consumeAutofixSha as dbConsumeAutofixSha,
  insertPendingReviewSync,
  deletePendingReviewSync,
  getAllPendingReviewSyncs,
  hasTestResultForSha,
  upsertTestResult,
  hasAnalyzeResultForSha,
  upsertAnalyzeResult,
  getAnalyzeResult,
  setPreReviewStage,
  setLastReviewedSha,
} from '../db/queries';
import { syncToOrigin } from './PRFileReverter';
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
import { runTestCommands } from '../session/test-runner';
import { runFilePollutionCheck } from '../session/filePollutionCheck';
import { recordEvent } from '../audit/AuditLog';
import type { ServerMessage } from '../ws/types';

function getMaxReviewIterations(): number {
  return typedGetSetting('max_review_iterations');
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

const STALL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const STALL_CHECK_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes

export class ReviewOrchestrator {
  private queue: QueuedJob[] = [];
  private running = 0;
  /** PR keys ("prNumber:repo") for reviews currently executing — enforces per-PR serialization. */
  private inFlightPRKeys = new Set<string>();
  /** Start timestamps (ms) for in-flight reviews keyed by "prNumber:repo" — used by stall detector. */
  private inFlightStartTimes = new Map<string, number>();
  /** In-flight post-revert worktree sync promises, keyed by "prNumber:repo". */
  private pendingSyncs = new Map<string, Promise<void>>();
  /** Resolves once all incomplete pending_review_sync rows from the previous run are retried. */
  readonly bootReady: Promise<void>;
  private stallDetectorInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private reviewService: PRReviewService,
    private sessionManager: SessionManager,
    private enabled: boolean = true,
    private github?: GitHubClient,
    stallCheckIntervalMs: number = STALL_CHECK_INTERVAL_MS,
    stallTimeoutMs: number = STALL_TIMEOUT_MS,
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
    this.bootReady = this.rehydratePendingSyncs();
    this.startStallDetector(stallCheckIntervalMs, stallTimeoutMs);
  }

  /** Release all background timers. Call when shutting down the server. */
  destroy(): void {
    if (this.stallDetectorInterval) {
      clearInterval(this.stallDetectorInterval);
      this.stallDetectorInterval = null;
    }
  }

  private startStallDetector(intervalMs: number, timeoutMs: number): void {
    const handle = setInterval(() => {
      const now = Date.now();
      for (const [key, startTime] of this.inFlightStartTimes) {
        const elapsedMs = now - startTime;
        if (elapsedMs > timeoutMs) {
          logger.error(
            `[ReviewOrchestrator] STALL DETECTED for ${key} — review has been running for ${Math.round(elapsedMs / 60000)} min. Force-clearing slot.`,
          );
          this.inFlightPRKeys.delete(key);
          this.inFlightStartTimes.delete(key);
          this.running = Math.max(0, this.running - 1);
          void this.drain();
        }
      }
    }, intervalMs);
    // Don't keep the Node process alive for the stall detector alone.
    handle.unref();
    this.stallDetectorInterval = handle;
  }

  /**
   * Re-attempt each incomplete pending_review_sync row left over from a previous
   * run. For each row, performs an idempotent git fetch + reset so the worktree
   * reflects the remote branch state, then clears the row. If the revert push
   * had already completed on GitHub before the restart, the fetch/reset is a
   * no-op. Arms the in-memory pendingSyncs map so executeReview can await the
   * operations before fetching the diff.
   */
  async rehydratePendingSyncs(): Promise<void> {
    const pending = getAllPendingReviewSyncs();
    if (pending.length === 0) return;

    await Promise.all(
      pending.map(async ({ pr_number, repo }) => {
        const key = `${pr_number}:${repo}`;
        const syncPromise = (async () => {
          try {
            const prRow = getPRByNumber(pr_number, repo);
            if (prRow?.session_id && prRow.head_branch) {
              const session = getSession(prRow.session_id);
              if (session?.worktree_path) {
                await syncToOrigin(session.worktree_path, prRow.head_branch);
              }
            }
          } catch (e) {
            logger.warn(
              `[ReviewOrchestrator] boot-retry sync failed for PR #${pr_number} (${repo}): ${e}`,
            );
          }
        })();
        const tracked = syncPromise.finally(() => {
          deletePendingReviewSync(pr_number, repo);
        });
        this.pendingSyncs.set(key, tracked);
        await tracked;
      }),
    );
  }

  /** Store a pending sync promise so executeReview can await it before fetching the diff. */
  registerRevertSync(
    prNumber: number,
    repo: string,
    syncPromise: Promise<void>,
  ): void {
    const key = `${prNumber}:${repo}`;
    insertPendingReviewSync(prNumber, repo);
    const tracked = syncPromise.finally(() => {
      deletePendingReviewSync(prNumber, repo);
    });
    this.pendingSyncs.set(key, tracked);
  }

  private onPrOpened(job: ReviewJob): void {
    if (!this.enabled) {
      logger.info(
        `[ReviewOrchestrator] pr_opened received for PR #${job.prNumber} (${job.repo}) — orchestrator disabled, skipping`,
      );
      return;
    }
    if (!job.taskId) {
      logger.warn(
        `[ReviewOrchestrator] PR #${job.prNumber} has no Notion task — skipping`,
      );
      return;
    }
    logger.info(
      `[ReviewOrchestrator] pr_opened received for PR #${job.prNumber} (${job.repo}) — queueing (queue depth before: ${this.queue.length})`,
    );
    this.queue.push(job);
    void this.drain();
  }

  private onMessage(msg: ServerMessage): void {
    if (!this.enabled) return;
    if (msg.type !== 'local_branch_submitted') return;

    const { projectId, sessionId, branchName, baseBranch } = msg;

    const sessionRow = getSession(sessionId);
    if (!sessionRow?.worktree_path) {
      logger.warn(
        `[ReviewOrchestrator] local_branch_submitted for session ${sessionId} — no worktree_path, skipping`,
      );
      return;
    }

    const localBranchRow = getLocalBranchBySession(sessionId);
    if (!localBranchRow) {
      logger.warn(
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

  private prKey(job: QueuedJob): string | null {
    if (job.type === 'local_branch') return null;
    const prJob = job as ReviewJob;
    return `${prJob.prNumber}:${prJob.repo}`;
  }

  async drain(): Promise<void> {
    await this.bootReady;
    while (
      this.running < runtimeSettings.auto_review_concurrency &&
      this.queue.length > 0
    ) {
      // Find the first job not blocked by per-PR serialization.
      let jobIndex = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const key = this.prKey(this.queue[i]);
        if (key === null || !this.inFlightPRKeys.has(key)) {
          jobIndex = i;
          break;
        }
      }
      if (jobIndex === -1) break; // all remaining jobs are blocked by in-flight reviews

      const [job] = this.queue.splice(jobIndex, 1);
      const key = this.prKey(job);

      this.running++;
      if (key !== null) {
        this.inFlightPRKeys.add(key);
        this.inFlightStartTimes.set(key, Date.now());
      }

      if (job.type === 'local_branch') {
        const lbJob = job as LocalBranchJob;
        logger.info(
          `[ReviewOrchestrator] drain: starting local-branch review for ${lbJob.branchName} (running: ${this.running}/${runtimeSettings.auto_review_concurrency})`,
        );
      } else {
        const prJob = job as ReviewJob;
        logger.info(
          `[ReviewOrchestrator] drain: starting review for PR #${prJob.prNumber} (${prJob.repo}) (running: ${this.running}/${runtimeSettings.auto_review_concurrency})`,
        );
      }

      void (async () => {
        try {
          if (job.type === 'local_branch') {
            await this.executeLocalBranchReview(job);
          } else {
            await this.executeReview(job as ReviewJob);
          }
        } catch (e) {
          if (job.type === 'local_branch') {
            logger.error(
              `[ReviewOrchestrator] review failed for local branch ${(job as LocalBranchJob).branchName}:`,
              e,
            );
          } else {
            const prJob = job as ReviewJob;
            logger.error(
              `[ReviewOrchestrator] review failed for PR #${prJob.prNumber}:`,
              e,
            );
          }
        } finally {
          this.running--;
          if (key !== null) {
            this.inFlightPRKeys.delete(key);
            this.inFlightStartTimes.delete(key);
          }
          void this.drain();
        }
      })();
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
  ): Promise<{ success: boolean; summary: string }> {
    const project = getProjectByGithubRepo(repo);
    if (!project) return { success: true, summary: 'no project — skipped' };

    const autofixCommands = loadAutofixCommands(project.projectDir);
    if (autofixCommands.length === 0)
      return { success: true, summary: 'no autofix commands — skipped' };

    this.sessionManager.emit('message', {
      type: 'autofix_started',
      prNumber,
      repo,
    });
    setPreReviewStage(prNumber, repo, 'autofix');

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
            logger.info(`[ReviewOrchestrator] autofix PR #${prNumber}: ${msg}`),
        );
        autofixSuccess = result.success;
        autofixSummary = result.summary;
        if (result.commitSha) {
          addAutofixSha(prNumber, repo, result.commitSha);
          if (prRow?.session_id && result.touchedFiles?.length) {
            this.sessionManager.addToRevertLock(
              prRow.session_id,
              result.touchedFiles,
            );
          }
          if (this.github) {
            const pollutionResult = await runFilePollutionCheck({
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
            if (pollutionResult.revertCommitSha) {
              addAutofixSha(prNumber, repo, pollutionResult.revertCommitSha);
            }
          }
        }
      } catch (err) {
        autofixSuccess = false;
        autofixSummary = `autofix threw: ${String(err)}`;
        logger.error(
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
      logger.warn(
        `[ReviewOrchestrator] autofix failed for PR #${prNumber}: ${autofixSummary}`,
      );
    }

    return { success: autofixSuccess, summary: autofixSummary };
  }

  /**
   * Returns true (and consumes the entry) when the given SHA is the autofix
   * commit that was pushed during the last runAutofixPipeline() for this PR.
   * Used by the push_detected handler to skip re-reviews for autofix-only pushes
   * so they do not count against the iteration cap.
   */
  consumeAutofixSha(prNumber: number, repo: string, sha: string): boolean {
    return dbConsumeAutofixSha(prNumber, repo, sha);
  }

  /** Returns true when a review is actively executing or queued-but-blocked for this PR. */
  isReviewInFlight(prNumber: number, repo: string): boolean {
    return this.inFlightPRKeys.has(`${prNumber}:${repo}`);
  }

  /**
   * Enqueue a review for the given PR via the same path as pr_opened.
   * Skips when the orchestrator is disabled or the job has no taskId.
   */
  enqueueReview(job: ReviewJob): void {
    if (!this.enabled) return;
    if (!job.taskId) return;
    logger.info(
      `[ReviewOrchestrator] enqueueReview for PR #${job.prNumber} (${job.repo}) — queueing (queue depth before: ${this.queue.length})`,
    );
    this.queue.push(job);
    void this.drain();
  }

  /**
   * Run the configured test: commands for a PR's head SHA.
   * Deduplicates: if a result already exists for this SHA, skips execution.
   * Persists { passed, output } keyed by (prNumber, repo, sha) for F2 to consult.
   */
  async runTestPipeline(
    prNumber: number,
    repo: string,
    headSha: string,
    worktreePath: string,
    commands: string[] | undefined,
    timeoutSec: number,
    maxRssMb = 0,
    failFast = true,
  ): Promise<void> {
    if (!commands?.length || !headSha) return;

    if (hasTestResultForSha(prNumber, repo, headSha)) {
      logger.info(
        `[ReviewOrchestrator] tests already ran for PR #${prNumber} SHA ${headSha.slice(0, 7)} — skipping`,
      );
      return;
    }

    logger.info(
      `[ReviewOrchestrator] running tests for PR #${prNumber} SHA ${headSha.slice(0, 7)} (timeout ${timeoutSec}s)`,
    );

    const { passed, output } = await runTestCommands(
      worktreePath,
      commands,
      timeoutSec,
      (msg) => logger.info(`[ReviewOrchestrator] test PR #${prNumber}: ${msg}`),
      { maxRssMb, failFast },
    );

    upsertTestResult(prNumber, repo, headSha, passed, output);

    logger.info(
      `[ReviewOrchestrator] tests ${passed ? 'PASSED' : 'FAILED'} for PR #${prNumber} SHA ${headSha.slice(0, 7)}`,
    );
  }

  /**
   * Run the configured analyze: commands for a PR's head SHA.
   * Deduplicates: if a result already exists for this SHA, returns the cached result.
   * Persists { passed, output } keyed by (prNumber, repo, sha).
   * Returns { passed, output } so the caller can act on failure.
   */
  async runAnalyzePipeline(
    prNumber: number,
    repo: string,
    headSha: string,
    worktreePath: string,
    commands: string[],
    timeoutSec: number,
    maxRssMb = 0,
    failFast = true,
  ): Promise<{ passed: boolean; output: string }> {
    if (!commands.length || !headSha) return { passed: true, output: '' };

    if (hasAnalyzeResultForSha(prNumber, repo, headSha)) {
      logger.info(
        `[ReviewOrchestrator] analyze already ran for PR #${prNumber} SHA ${headSha.slice(0, 7)} — returning cached result`,
      );
      const cached = getAnalyzeResult(prNumber, repo, headSha);
      return { passed: cached?.passed === 1, output: cached?.output ?? '' };
    }

    logger.info(
      `[ReviewOrchestrator] running analyze for PR #${prNumber} SHA ${headSha.slice(0, 7)} (timeout ${timeoutSec}s)`,
    );

    const { passed, output } = await runTestCommands(
      worktreePath,
      commands,
      timeoutSec,
      (msg) =>
        logger.info(`[ReviewOrchestrator] analyze PR #${prNumber}: ${msg}`),
      { maxRssMb, failFast },
    );

    upsertAnalyzeResult(prNumber, repo, headSha, passed, output);

    logger.info(
      `[ReviewOrchestrator] analyze ${passed ? 'PASSED' : 'FAILED'} for PR #${prNumber} SHA ${headSha.slice(0, 7)}`,
    );

    return { passed, output };
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
                logger.info(
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
            logger.warn(
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
      result = await this.reviewService.reviewPR(
        workItem,
        diffSource,
        job.projectId,
        job.contextUrl,
      );
    } catch (e) {
      this.sessionManager.emit('message', {
        type: 'pr_review_complete',
        prNumber: job.localBranchId,
        repo: `local/${job.branchName}`,
        verdict: 'error',
        summary: String(e),
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
      try {
        await this.sessionManager.sendOrResume(
          job.sessionId,
          formatReviewFeedback(result, 0),
        );
      } catch (e) {
        recordEvent({
          event_type: 'verdict_routing_failed',
          actor_type: 'system',
          actor_id: job.sessionId,
          project_id: job.projectId ?? null,
          task_id: job.taskId ?? null,
          payload: {
            pr_number: job.localBranchId,
            repo: `local/${job.branchName}`,
            error: String(e),
          },
        });
        logger.warn(
          `[ReviewOrchestrator] verdict routing failed for local branch ${job.branchName}: ${e}`,
        );
      }
    }
  }

  private consumePendingPushIfSet(prNumber: number, repo: string): void {
    const row = getPRByNumber(prNumber, repo);
    if (row?.pending_push && row.session_id) {
      setPendingPush(prNumber, repo, 0);
      logger.info(
        `[ReviewOrchestrator] pending_push detected for PR #${prNumber} — triggering re-review`,
      );
      this.sessionManager.emit('push_detected', {
        sessionId: row.session_id,
      });
    }
  }

  private async routeGateFailureToSession(
    job: ReviewJob,
    kind: 'verify' | 'autofix',
    detail: {
      failedCommand?: string;
      truncatedOutput?: string;
      summary: string;
    },
  ): Promise<void> {
    const prRow = getPRByNumber(job.prNumber, job.repo);

    setPRReviewResult(
      job.prNumber,
      job.repo,
      JSON.stringify({
        verdict: kind === 'verify' ? 'verify_failed' : 'autofix_failed',
        summary: detail.summary,
        dimensions: [],
      }),
    );
    // Set last_reviewed_sha so the next push is identified as new code and
    // shouldAutoReview returns true instead of seeing null === null.
    setLastReviewedSha(job.prNumber, job.repo, prRow?.head_sha ?? null);

    this.sessionManager.emit('message', {
      type: 'pr_review_blocked_by_gate',
      prNumber: job.prNumber,
      repo: job.repo,
      kind,
      failedCommand: detail.failedCommand,
      summary: detail.summary,
    });
    setPreReviewStage(
      job.prNumber,
      job.repo,
      kind === 'autofix' ? 'blocked_autofix' : 'blocked_verify',
    );

    const sessionId = prRow?.session_id;
    if (!sessionId) return;

    const message =
      kind === 'verify'
        ? formatCIFailureFeedback({
            source: 'verify',
            failedCommand: detail.failedCommand,
            truncatedOutput: detail.truncatedOutput,
          })
        : `## Autofix Gate Failure\n\nThe autofix pipeline failed and could not produce a clean commit.\n\n**Error:** ${detail.summary}\n\nPlease fix the issue and re-push.`;

    try {
      await this.sessionManager.sendOrResume(sessionId, message);
    } catch (e) {
      logger.warn(
        `[ReviewOrchestrator] gate failure routing failed for PR #${job.prNumber}: ${e}`,
      );
    }
  }

  private async executeReview(job: ReviewJob): Promise<void> {
    logger.info(
      `[ReviewOrchestrator] executeReview: entered for PR #${job.prNumber} (${job.repo}) taskId=${job.taskId ?? 'none'}`,
    );

    // Await any in-flight post-revert worktree sync before fetching the diff,
    // so the review sees the canonical file state, not the contaminated version.
    const syncKey = `${job.prNumber}:${job.repo}`;
    const pendingSync = this.pendingSyncs.get(syncKey);
    if (pendingSync) {
      logger.info(
        `[ReviewOrchestrator] executeReview: awaiting pending revert sync for PR #${job.prNumber}`,
      );
      this.pendingSyncs.delete(syncKey);
      await pendingSync;
    }

    const project = getProjectByGithubRepo(job.repo);
    if (!project) {
      logger.warn(
        `[ReviewOrchestrator] PR #${job.prNumber}: no project found for repo ${job.repo} — skipping`,
      );
      return;
    }

    // Check iteration cap before starting a review
    const prRow = getPRByNumber(job.prNumber, job.repo);
    const maxIterations = getMaxReviewIterations();
    if (prRow && prRow.review_iteration >= maxIterations) {
      const message = `Review loop for PR #${job.prNumber} reached ${maxIterations} iterations without approval. Manual intervention needed.`;
      logger.warn(`[ReviewOrchestrator] ${message}`);
      setPauseReason(job.prNumber, job.repo, 'max_reviews');
      this.sessionManager.emit('message', {
        type: 'review_escalated',
        prNumber: job.prNumber,
        repo: job.repo,
        message,
      });
      return;
    }

    // ── Gate 1: Autofix + file-pollution-check step ──────────────────────────
    const autofixResult = await this.runAutofixPipeline(
      job.prNumber,
      job.repo,
      job.taskId ?? null,
    );
    if (!autofixResult.success) {
      logger.info(
        `[ReviewOrchestrator] executeReview: gate failure (kind=autofix) for PR #${job.prNumber}`,
      );
      await this.routeGateFailureToSession(job, 'autofix', {
        summary: autofixResult.summary,
      });
      this.consumePendingPushIfSet(job.prNumber, job.repo);
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Gate 2: Verify ───────────────────────────────────────────────────────
    {
      const gatePrRow = getPRByNumber(job.prNumber, job.repo);
      const gateWorktreePath = gatePrRow?.session_id
        ? (getSession(gatePrRow.session_id)?.worktree_path ?? '')
        : '';
      if (gateWorktreePath) {
        this.sessionManager.emit('message', {
          type: 'verify_pipeline_started',
          prNumber: job.prNumber,
          repo: job.repo,
        });
        setPreReviewStage(job.prNumber, job.repo, 'verify');
        const verifyConfig = loadOrchestratorConfig(project.projectDir);
        const verifyResult = await runVerifyAsGate(
          gateWorktreePath,
          verifyConfig.verify,
        );
        if (!verifyResult.passed) {
          logger.info(
            `[ReviewOrchestrator] executeReview: gate failure (kind=verify) for PR #${job.prNumber}`,
          );
          await this.routeGateFailureToSession(job, 'verify', {
            failedCommand: verifyResult.failedCommand,
            truncatedOutput: verifyResult.truncatedOutput,
            summary: verifyResult.failedCommand
              ? `verify failed: ${verifyResult.failedCommand}`
              : 'verify failed',
          });
          this.consumePendingPushIfSet(job.prNumber, job.repo);
          return;
        }
        this.sessionManager.emit('message', {
          type: 'verify_pipeline_complete',
          prNumber: job.prNumber,
          repo: job.repo,
        });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Gate 3: Analyze (static analysis, between verify and tests) ──────────
    {
      const analyzePrRow = getPRByNumber(job.prNumber, job.repo);
      const analyzeHeadSha = analyzePrRow?.head_sha ?? '';
      const analyzeWorktreePath = analyzePrRow?.session_id
        ? (getSession(analyzePrRow.session_id)?.worktree_path ?? '')
        : '';
      if (analyzeHeadSha && analyzeWorktreePath) {
        const analyzeConfig = loadOrchestratorConfig(project.projectDir);
        if (analyzeConfig.analyze?.length) {
          this.sessionManager.emit('message', {
            type: 'analyze_pipeline_started',
            prNumber: job.prNumber,
            repo: job.repo,
          });
          setPreReviewStage(job.prNumber, job.repo, 'analyzing');
          const analyzeResult = await this.runAnalyzePipeline(
            job.prNumber,
            job.repo,
            analyzeHeadSha,
            analyzeWorktreePath,
            analyzeConfig.analyze,
            analyzeConfig.analyze_timeout_sec,
            analyzeConfig.analyze_max_rss_mb,
            analyzeConfig.analyze_fail_fast,
          );
          if (!analyzeResult.passed) {
            logger.info(
              `[ReviewOrchestrator] executeReview: analyze gate FAILED for PR #${job.prNumber} — pausing`,
            );
            setPauseReason(job.prNumber, job.repo, 'analyze_failing');
            const analyzeSessionId = getPRByNumber(
              job.prNumber,
              job.repo,
            )?.session_id;
            if (analyzeSessionId) {
              const message = `## Analyze Gate Failure\n\nThe static analysis gate failed. Please fix the issues below and re-push.\n\n\`\`\`\n${analyzeResult.output}\n\`\`\``;
              try {
                await this.sessionManager.sendOrResume(
                  analyzeSessionId,
                  message,
                );
              } catch (e) {
                logger.warn(
                  `[ReviewOrchestrator] analyze failure routing failed for PR #${job.prNumber}: ${e}`,
                );
              }
            }
            this.consumePendingPushIfSet(job.prNumber, job.repo);
            return;
          }
          this.sessionManager.emit('message', {
            type: 'analyze_pipeline_complete',
            prNumber: job.prNumber,
            repo: job.repo,
          });
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Orchestrator-run tests (per head-SHA, deduped) ────────────────────────
    {
      const freshPrRow = getPRByNumber(job.prNumber, job.repo);
      const headSha = freshPrRow?.head_sha ?? '';
      const worktreePath = freshPrRow?.session_id
        ? (getSession(freshPrRow.session_id)?.worktree_path ?? '')
        : '';
      if (headSha && worktreePath) {
        const config = loadOrchestratorConfig(project.projectDir);
        this.sessionManager.emit('message', {
          type: 'test_pipeline_started',
          prNumber: job.prNumber,
          repo: job.repo,
        });
        setPreReviewStage(job.prNumber, job.repo, 'tests');
        await this.runTestPipeline(
          job.prNumber,
          job.repo,
          headSha,
          worktreePath,
          config.test,
          config.test_timeout_sec,
          config.test_max_rss_mb,
          config.test_fail_fast,
        );
        this.sessionManager.emit('message', {
          type: 'test_pipeline_complete',
          prNumber: job.prNumber,
          repo: job.repo,
        });
        setPreReviewStage(job.prNumber, job.repo, 'awaiting_review');
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    setPreReviewStage(job.prNumber, job.repo, null);
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
      result = await this.reviewService.reviewPR(
        workItem,
        diffSource,
        project.id,
        job.contextUrl,
      );
    } catch (e) {
      if (e instanceof FetchRetryExhaustedError) {
        // review_failed was already emitted by PRReviewService; leave review_result null
        return;
      }
      // PRReviewService persists the verdict immediately after parse, before any
      // side effects. If reviewPR throws, it means parsing never completed and no
      // verdict was persisted — write the error sentinel only in that case to avoid
      // clobbering a verdict that was already successfully stored.
      const alreadyPersisted = !!getPRByNumber(job.prNumber, job.repo)
        ?.review_result;
      if (!alreadyPersisted) {
        const summary = String(e);
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
      }
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
        try {
          await this.sessionManager.sendOrResume(
            prRow.session_id,
            formatReviewFeedback(result, 0),
          );
        } catch (e) {
          recordEvent({
            event_type: 'verdict_routing_failed',
            actor_type: 'system',
            actor_id: prRow.session_id,
            project_id: project.id ?? null,
            task_id: prRow.task_id ?? null,
            payload: {
              pr_number: job.prNumber,
              repo: job.repo,
              error: String(e),
            },
          });
          logger.warn(
            `[ReviewOrchestrator] verdict routing failed for PR #${job.prNumber}: ${e}`,
          );
        }
      }
    } else if (result.verdict === 'incomplete') {
      const message = `Review for PR #${job.prNumber} returned an incomplete verdict — the reviewer could not assess the PR. Manual intervention needed.`;
      logger.warn(`[ReviewOrchestrator] ${message}`);
      this.sessionManager.emit('message', {
        type: 'review_incomplete',
        prNumber: job.prNumber,
        repo: job.repo,
        message,
      });
      // Notify the implementing session so it knows to push a clearer version.
      if (prRow?.session_id) {
        try {
          await this.sessionManager.sendOrResume(
            prRow.session_id,
            formatReviewFeedback(result, 0),
          );
        } catch (e) {
          recordEvent({
            event_type: 'verdict_routing_failed',
            actor_type: 'system',
            actor_id: prRow.session_id,
            project_id: project.id ?? null,
            task_id: prRow.task_id ?? null,
            payload: {
              pr_number: job.prNumber,
              repo: job.repo,
              error: String(e),
            },
          });
          logger.warn(
            `[ReviewOrchestrator] incomplete verdict routing failed for PR #${job.prNumber}: ${e}`,
          );
        }
      }
    }

    this.consumePendingPushIfSet(job.prNumber, job.repo);
  }
}
